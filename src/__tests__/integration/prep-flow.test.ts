/**
 * Integration test for the full prep flow (DX-291 / DX-296).
 *
 * Wires the picker (`tryMultiAgentDispatch`) through to the real prep-
 * verdict worker route + on-disk YAML over a real loopback HTTP server.
 * `dispatchWithRecovery` is replaced by a fake that simulates the
 * spawned agent: it inspects the picker's task body, learns its
 * `dispatchKind`, then drives the verdict round-trip through the real
 * route handler. The fake also stamps `prepVerdict` + `dispatchKind`
 * onto the in-memory job before invoking the picker's `onComplete`
 * callback — same shape the production launcher hands back via
 * `attach-monitoring-stack` after the agent's `danxbot_prep_verdict`
 * tool call lands.
 *
 * What this catches that the unit tests do not:
 *   - The picker's task-body decision (combined vs prep-only) feeds
 *     into the route's lifecycle decision through the SHARED
 *     `dispatchKind` discriminator. A regression that decouples them
 *     (e.g. picker stamps `prep` but route reads from prepMode) shows
 *     up here as a hung dispatch or a spurious CRITICAL_FAILURE.
 *   - The two-tick separate-mode protocol (prep on tick 1, work on
 *     tick 2) actually progresses the YAML — `assigned_agent` survives
 *     the prep dispatch's cleanup, the picker self-claims the card on
 *     tick 2, the route lets the work pass run.
 *   - Non-ok verdicts (`conflict_on`, `blocked`, `abort`) reach the
 *     route via the picker, the route stamps the YAML / settings, the
 *     onComplete chain skips the card-progress check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resetAgentLocksQueryFn,
  setAgentLocksQueryFn,
} from "../../agent/agent-locks.js";

vi.mock("../../dispatch/core.js", () => ({
  dispatch: vi.fn(),
}));
vi.mock("../../dispatch/recovery-mode.js", () => ({
  dispatchWithRecovery: vi.fn(),
}));
vi.mock("../../dispatch/scheduler.js", async () => {
  const lock = await vi.importActual<
    typeof import("../../issue-tracker/lock.js")
  >("../../issue-tracker/lock.js");
  return {
    guardLiveDispatchForCard: vi.fn().mockResolvedValue(false),
    runPostDispatchProgressCheck: vi.fn().mockResolvedValue(undefined),
    buildLockHolderInfo: lock.buildLockHolderInfo,
    tryAcquireLock: lock.tryAcquireLock,
    releaseLock: lock.releaseLock,
  };
});
vi.mock("../../agent/worktree-manager.js", () => ({
  createWorktreeManager: vi.fn().mockReturnValue({
    worktreePath: vi
      .fn()
      .mockImplementation(
        (_repo: { localPath: string }, agentName: string) =>
          `${_repo.localPath}/.danxbot/worktrees/${agentName}`,
      ),
    bootstrap: vi.fn(),
    teardown: vi.fn(),
    validate: vi.fn().mockResolvedValue({ state: "clean" }),
    syncWorktree: vi.fn().mockResolvedValue({ kind: "noop" }),
    snapshotIfDirty: vi.fn().mockResolvedValue({ kind: "clean" }),
    ensureProvisioned: vi.fn(),
    fetchOrigin: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("../../poller/yaml-lifecycle.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../poller/yaml-lifecycle.js")
  >("../../poller/yaml-lifecycle.js");
  return {
    ...actual,
    // Stamp the YAML in-memory only — the test asserts on file state via
    // direct `parseIssue` reads of the on-disk YAML the route writes.
    stampAssignedAgentAndWrite: vi.fn(async (_p, issue, name) => ({
      ...issue,
      assigned_agent: name,
    })),
    stampDispatchAndWrite: vi.fn(async (_p, issue, dispatch) => ({
      ...issue,
      dispatch: { ...dispatch },
    })),
    clearDispatchAndWrite: vi.fn(async (_p, issue) => ({
      ...issue,
      dispatch: null,
    })),
    loadLocal: vi.fn(async () => null),
    // DX-552 — the prep-verdict route now writes through real
    // `writeIssue` so DB + file land together (was a bare `writeFileSync`
    // before, which caused the picker's onComplete → loadLocal →
    // clearDispatchAndWrite chain to clobber the stamp). The integration
    // test asserts on on-disk state via direct `parseIssue` reads, so
    // we let the real `writeIssue` run (its DB upsert is a no-op when no
    // writer DB is registered, which matches this fixture).
  };
});
vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { tryMultiAgentDispatch } from "../../poller/multi-agent-pick.js";
import { dispatchWithRecovery } from "../../dispatch/recovery-mode.js";
import { runPostDispatchProgressCheck } from "../../dispatch/scheduler.js";
import { handlePrepVerdict } from "../../worker/prep-verdict-route.js";
import {
  callDanxbotPrepVerdict,
  type PrepVerdictPayload,
} from "../../mcp/danxbot-prep-verdict.js";
import {
  createEmptyIssue,
  serializeIssue,
  parseIssue,
} from "../../issue-tracker/yaml.js";
import { makeRepoContext } from "../helpers/fixtures.js";
import type {
  Issue,
  IssueTracker,
} from "../../issue-tracker/interface.js";
import type { RepoContext } from "../../types.js";
import type { AgentJob, DispatchKind } from "../../agent/agent-types.js";
import type { Dispatch } from "../../dashboard/dispatches.js";

const mockedDispatchWithRecovery = vi.mocked(dispatchWithRecovery);

let tmpRepo: string;
let server: Server;
let routeUrl: (dispatchId: string) => string;

function fakeTracker(): IssueTracker {
  return {
    fetchOpenCards: async () => [],
    getCard: async () => {
      throw new Error("getCard not used");
    },
    createCard: async () => ({ external_id: "", ac: [] }),
    updateCard: async () => {},
    
    moveToList: async () => {},
    setLabels: async () => {},
    addComment: async () => ({ id: "lock-cmt", timestamp: "" }),
    editComment: async () => {},
    getComments: async () => [],
    addAcItem: async () => ({ check_item_id: "" }),
    updateAcItem: async () => {},
    deleteAcItem: async () => {},
  };
}

function alwaysOpen() {
  return {
    tz: "America/Chicago",
    mon: ["00:00-23:59"],
    tue: ["00:00-23:59"],
    wed: ["00:00-23:59"],
    thu: ["00:00-23:59"],
    fri: ["00:00-23:59"],
    sat: ["00:00-23:59"],
    sun: ["00:00-23:59"],
  };
}

function writeSettings(prepMode: "combined" | "separate"): void {
  mkdirSync(join(tmpRepo, ".danxbot"), { recursive: true });
  writeFileSync(
    join(tmpRepo, ".danxbot/settings.json"),
    JSON.stringify(
      {
        overrides: {
          slack: { enabled: null },
          issuePoller: { enabled: null, pickupNamePrefix: null },
          dispatchApi: { enabled: null },
          ideator: { enabled: null },
          autoTriage: { enabled: null },
        },
        display: {},
        agents: {
          alice: {
            type: "agent",
            bio: "I am alice.",
            capabilities: ["issue-worker"],
            schedule: alwaysOpen(),
            enabled: true,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
        agentDefaults: { prepMode },
        meta: { updatedAt: new Date().toISOString(), updatedBy: "worker" },
      },
      null,
      2,
    ),
  );
}

function writeIssue(id: string): Issue {
  mkdirSync(join(tmpRepo, ".danxbot/issues/open"), { recursive: true });
  const issue = createEmptyIssue({
    id,
    status: "ToDo",
    title: `Test ${id}`,
    description: "fixture",
  });
  writeFileSync(
    join(tmpRepo, ".danxbot/issues/open", `${id}.yml`),
    serializeIssue(issue),
  );
  return issue;
}

function readIssue(id: string): Issue {
  return parseIssue(
    readFileSync(
      join(tmpRepo, ".danxbot/issues/open", `${id}.yml`),
      "utf-8",
    ),
    { expectedPrefix: "DX" },
  );
}

function fakeRepo(): RepoContext {
  return {
    name: "danxbot",
    localPath: tmpRepo,
    issuePrefix: "DX",
    workerPort: 5562,
    trello: {},
  } as unknown as RepoContext;
}

function makeDispatch(id: string, agentName = "alice"): Dispatch {
  return {
    id,
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {} as Dispatch["triggerMetadata"],
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: "DX-1",
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "docker",
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName,
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
  };
}

/**
 * Build the in-memory `AgentJob` shape the launcher hands the picker
 * via `dispatch().onComplete`. The fake `dispatchWithRecovery` we
 * register stamps `prepVerdict` + `dispatchKind` on this object after
 * driving the route, then invokes the picker's `onComplete`.
 */
function makeJob(dispatchId: string, dispatchKind: DispatchKind): AgentJob {
  return {
    id: dispatchId,
    status: "running",
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    recoverCount: 0,
    dispatchKind,
    stop: vi.fn(async () => undefined),
  } as unknown as AgentJob;
}

beforeEach(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), "prep-flow-"));
  setAgentLocksQueryFn(async () => [] as never);
  vi.clearAllMocks();

  // Boot a real loopback HTTP server hosting the prep-verdict route.
  // The fake agent (driven inside `dispatchWithRecovery`) POSTs the
  // verdict here via the real `callDanxbotPrepVerdict` MCP client —
  // the route applies the YAML / settings side-effect and calls
  // `job.stop` for terminating verdicts.
  const repo = makeRepoContext({
    name: "danxbot",
    localPath: tmpRepo,
    hostPath: tmpRepo,
    issuePrefix: "DX",
  });
  server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", "http://localhost");
      const m = url.pathname.match(/^\/api\/prep-verdict\/(.+)$/);
      if (req.method === "POST" && m) {
        const dispatchId = m[1];
        await handlePrepVerdict(req, res, dispatchId, repo, {
          getDispatch: async () => makeDispatch(dispatchId),
          getJob: () => activeJobs.get(dispatchId),
        });
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  routeUrl = (id: string) =>
    `http://127.0.0.1:${port}/api/prep-verdict/${id}`;
});

afterEach(async () => {
  resetAgentLocksQueryFn();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpRepo, { recursive: true, force: true });
});

/**
 * Live job table the route's `getJob` reads. Fake-dispatchWithRecovery
 * registers each dispatch here when it spawns the agent and removes
 * after onComplete.
 */
const activeJobs = new Map<string, AgentJob>();

interface FakeAgentBehavior {
  verdict: PrepVerdictPayload;
  /**
   * When set, the fake agent reports this status on the simulated
   * `danxbot_complete` call (the picker's onComplete reads it). Default
   * derives from the verdict — `ok` → completed; `conflict_on` /
   * `blocked` → completed (route stops the dispatch with completed);
   * `abort` → failed.
   */
  finalJobStatus?: "completed" | "failed";
}

/**
 * Wire the fake `dispatchWithRecovery` for one upcoming dispatch. Drives
 * the agent's verdict POST through the route and then fires the
 * picker's onComplete with the right job shape.
 */
function setupFakeDispatch(behavior: FakeAgentBehavior): void {
  mockedDispatchWithRecovery.mockImplementationOnce(
    async (input: Parameters<typeof dispatchWithRecovery>[0]) => {
      const dispatchId = input.dispatchId!;
      const dispatchKind = input.dispatchKind ?? "work";
      const job = makeJob(dispatchId, dispatchKind);
      activeJobs.set(dispatchId, job);

      // Fake the agent's mid-dispatch `danxbot_prep_verdict` call.
      // Real MCP client → real route handler over real HTTP.
      await callDanxbotPrepVerdict(behavior.verdict, {
        url: routeUrl(dispatchId),
      });

      // After the route returns, simulate the dispatch's terminal
      // status by invoking the picker's onComplete with the same job
      // shape the launcher would hand back.
      const status =
        behavior.finalJobStatus ??
        (behavior.verdict.verdict === "abort" ? "failed" : "completed");
      job.status = status;
      job.summary = `prep ${behavior.verdict.verdict}`;
      // Stash the verdict on the job (route already did it for the
      // live route-side handler; replicate here for the onComplete).
      (job as unknown as { prepVerdict: PrepVerdictPayload }).prepVerdict =
        behavior.verdict;

      await input.onComplete?.(job);
      activeJobs.delete(dispatchId);

      return { dispatchId, job };
    },
  );
}

describe("prep flow integration — picker → route → onComplete", () => {
  it("combined mode + verdict ok: picker dispatches combined task; route does NOT stop dispatch; progress check fires", async () => {
    writeSettings("combined");
    writeIssue("DX-1");
    setupFakeDispatch({
      verdict: { verdict: "ok", reason: "no conflicts" },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.task).toBe("In Progress cards: []\n\n/danx-prep DX-1\n\n/danx-next DX-1");
    expect(dispatchInput.dispatchKind).toBe("work");
    // Route's job.stop never fires for ok+work → dispatch ran to its
    // natural completion. Picker's progress check fires because the
    // verdict was ok + kind work (the work pass behaved like a
    // legacy normal dispatch).
    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
  });

  it("separate mode + fresh card: picker dispatches prep-only task; route stops dispatch on ok; progress check SKIPPED", async () => {
    writeSettings("separate");
    writeIssue("DX-1");
    setupFakeDispatch({
      verdict: { verdict: "ok", reason: "no conflicts" },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.task).toBe("In Progress cards: []\n\n/danx-prep DX-1");
    expect(dispatchInput.dispatchKind).toBe("prep");
    // Card-progress check MUST be skipped — the prep-only dispatch
    // does NOT progress the card; running the check would write a
    // spurious CRITICAL_FAILURE on the very next tick.
    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  it("separate mode + self-claim follow-up tick: picker dispatches combined work task; route does NOT stop; progress check fires", async () => {
    // Simulates tick N+1 of the separate-mode protocol. The card
    // carries assigned_agent = "alice" (preserved from tick N's prep
    // dispatch). The picker self-claims and dispatches the work pass.
    writeSettings("separate");
    writeIssue("DX-1");
    setAgentLocksQueryFn(async (sql) => {
      if (sql.includes("FROM issues")) {
        return [{ id: "DX-1", assigned_agent: "alice" }] as never;
      }
      return [] as never;
    });
    setupFakeDispatch({
      verdict: { verdict: "ok", reason: "no conflicts" },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
          assigned_agent: "alice",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);
    const dispatchInput = mockedDispatchWithRecovery.mock.calls[0][0];
    expect(dispatchInput.task).toBe("In Progress cards: []\n\n/danx-prep DX-1\n\n/danx-next DX-1");
    expect(dispatchInput.dispatchKind).toBe("work");
    expect(runPostDispatchProgressCheck).toHaveBeenCalledTimes(1);
  });

  it("verdict conflict_on: route appends conflict_on[] to candidate YAML; picker SKIPS card-progress check", async () => {
    writeSettings("combined");
    writeIssue("DX-1");
    // The conflict partner card must exist in the YAML store too — the
    // route validates candidate id, not partner id, but the test asserts
    // on candidate YAML's conflict_on[] post-write.
    writeIssue("DX-99");

    setupFakeDispatch({
      verdict: {
        verdict: "conflict_on",
        reason: "both modify src/auth.ts",
        conflict_with: ["DX-99"],
      },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);
    // The route stamped conflict_on[] on the candidate YAML directly
    // (real on-disk write via the integration HTTP server).
    const stamped = readIssue("DX-1");
    expect(stamped.conflict_on).toEqual([
      { id: "DX-99", reason: "both modify src/auth.ts" },
    ]);
    // Card-progress check skipped — the route stamped the conflict
    // gate; the card was never expected to leave ToDo.
    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  it("verdict blocked: route stamps status=Blocked + blocked record on candidate YAML; picker SKIPS card-progress check", async () => {
    writeSettings("combined");
    writeIssue("DX-1");

    setupFakeDispatch({
      verdict: { verdict: "blocked", reason: "spec ambiguous" },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);
    const stamped = readIssue("DX-1");
    expect(stamped.status).toBe("Blocked");
    expect(stamped.blocked?.reason).toBe("spec ambiguous");
    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });

  it("verdict abort: route stamps agents.<name>.broken in settings.json; picker SKIPS card-progress check", async () => {
    writeSettings("separate");
    writeIssue("DX-1");

    setupFakeDispatch({
      verdict: {
        verdict: "abort",
        reason: "Bash returning ENOENT",
        broken_details: { suggested_steps: ["ssh", "fix PATH"] },
      },
    });

    const result = await tryMultiAgentDispatch({
      repo: fakeRepo(),
      cards: [
        {
          ...createEmptyIssue({
            id: "DX-1",
            status: "ToDo",
            title: "Test DX-1",
            description: "fixture",
          }),
          external_id: "ext-DX-1",
        },
      ],
      tracker: fakeTracker(),
      now: new Date(),
    });

    expect(result.dispatched).toBe(1);

    // Route persisted broken state to settings.json — the picker
    // filters this agent out on the next tick via pickFreeAgent.
    const settings = JSON.parse(
      readFileSync(join(tmpRepo, ".danxbot/settings.json"), "utf-8"),
    );
    expect(settings.agents.alice.broken).toMatchObject({
      reason: "Bash returning ENOENT",
      suggested_steps: ["ssh", "fix PATH"],
    });

    // Picker did not run the card-progress check (would have written
    // CRITICAL_FAILURE because the card is still in ToDo).
    expect(runPostDispatchProgressCheck).not.toHaveBeenCalled();
  });
});
