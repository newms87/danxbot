/**
 * Integration test for the prep-verdict round-trip (DX-294).
 *
 * Wires the real MCP-side `callDanxbotPrepVerdict` (HTTP client) to the
 * real worker-side `handlePrepVerdict` (route handler) over a real
 * loopback HTTP server. The dispatch row is mocked via dependency
 * injection — the route's only DB read is `getDispatchById`, and the
 * round-trip doesn't need an actual `dispatches` table to exercise the
 * YAML side-effect contract.
 *
 * Coverage: every verdict that mutates state (conflict_on, blocked,
 * abort) AND the `ok` verdict in both prep modes. Assertions check the
 * on-disk YAML / the settings.json side-effect / the dispatch's
 * `job.stop` invocation — i.e. the OBSERVABLE state Phase 5 of DX-291
 * will read on the next pick.
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
  callDanxbotPrepVerdict,
  PREP_VERDICT_QUEUE_DIR,
  type PrepVerdictPayload,
} from "../../mcp/danxbot-prep-verdict.js";
import { handlePrepVerdict } from "../../worker/prep-verdict-route.js";
import { makeRepoContext } from "../helpers/fixtures.js";
import {
  createEmptyIssue,
  serializeIssue,
  parseIssue,
} from "../../issue-tracker/yaml.js";
import type { AgentJob } from "../../agent/agent-types.js";
import type { Dispatch } from "../../dashboard/dispatches.js";

// Silence the route's internal logger so test output stays readable.
vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeDispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-1",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {} as Dispatch["triggerMetadata"],
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: "DX-100",
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
    agentName: "murphy",
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
    ...over,
  };
}

function makeJobStub(dispatchKind?: "prep" | "work") {
  const stop = vi.fn(async () => undefined);
  const job = {
    id: "dispatch-1",
    status: "running" as const,
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
    stop,
  } as unknown as AgentJob;
  return { job, stop };
}

function writeIssue(root: string, id: string) {
  mkdirSync(join(root, ".danxbot", "issues", "open"), { recursive: true });
  const issue = createEmptyIssue({
    id,
    title: `Test issue ${id}`,
    description: "fixture",
  });
  writeFileSync(
    join(root, ".danxbot", "issues", "open", `${id}.yml`),
    serializeIssue(issue),
  );
}

function readIssue(root: string, id: string) {
  return parseIssue(
    readFileSync(join(root, ".danxbot", "issues", "open", `${id}.yml`), "utf-8"),
    { expectedPrefix: "DX" },
  );
}

interface Harness {
  root: string;
  server: Server;
  url: (dispatchId: string) => string;
  setStop: (fn: ReturnType<typeof vi.fn>) => void;
  setBroken: ReturnType<typeof vi.fn>;
  setDispatchKind: (kind: "prep" | "work") => void;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "prep-verdict-integration-"));
  const repo = makeRepoContext({
    name: "danxbot",
    localPath: root,
    hostPath: root,
    issuePrefix: "DX",
  });
  const setBroken = vi.fn(async () => ({}) as never);
  // DX-296 — route's ok-branch decision now keys off
  // `AgentJob.dispatchKind`, not the per-repo prepMode setting.
  // Default to "work" so legacy assertions ("ok keeps the dispatch
  // running") stay green; tests that need the prep-only branch flip
  // it via setDispatchKind.
  const { job, stop } = makeJobStub("work");
  // Allow tests to swap the stop spy without rebuilding the server.
  let currentStop: ReturnType<typeof vi.fn> = stop;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Mount the route at /api/prep-verdict/:dispatchId — same shape
      // the worker server registers in `worker/server.ts`. The match
      // pattern is intentionally identical so any future route-table
      // change surfaces here as a 404.
      const url = new URL(req.url || "/", "http://localhost");
      const m = url.pathname.match(/^\/api\/prep-verdict\/(.+)$/);
      if (req.method === "POST" && m) {
        await handlePrepVerdict(req, res, m[1], repo, {
          getDispatch: async () => makeDispatch({ id: m[1] }),
          getJob: () => {
            // Bind the stop spy onto the same job instance the route
            // mutates so `job.prepVerdict` assertions still see the
            // verdict the route stamped.
            (job as unknown as { stop: typeof currentStop }).stop = currentStop;
            return job;
          },
          setBroken: setBroken as unknown as typeof import("../../settings-file.js").setAgentBroken,
        });
        return;
      }
      res.writeHead(404);
      res.end();
    },
  );

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;

  return {
    root,
    server,
    url: (dispatchId: string) =>
      `http://127.0.0.1:${port}/api/prep-verdict/${dispatchId}`,
    setStop: (fn) => {
      currentStop = fn;
    },
    setBroken,
    setDispatchKind: (kind) => {
      (job as unknown as { dispatchKind: "prep" | "work" }).dispatchKind = kind;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("prep-verdict round-trip — MCP client → worker route", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("conflict_on: stamps candidate YAML conflict_on[] + invokes job.stop('completed')", async () => {
    writeIssue(h.root, "DX-100");
    const stop = vi.fn(async () => undefined);
    h.setStop(stop);

    const out = await callDanxbotPrepVerdict(
      {
        verdict: "conflict_on",
        reason: "both modify src/auth.ts",
        conflict_with: ["DX-200", "DX-201"],
      },
      { url: h.url("dispatch-1") },
    );

    expect(out).toMatch(/applied/);
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/conflict_on/),
    );
    const yaml = readIssue(h.root, "DX-100");
    expect(yaml.conflict_on).toEqual([
      { id: "DX-200", reason: "both modify src/auth.ts" },
      { id: "DX-201", reason: "both modify src/auth.ts" },
    ]);
  });

  it("blocked: stamps status=Blocked + blocked={reason,timestamp} on candidate + stops 'completed'", async () => {
    writeIssue(h.root, "DX-100");
    const stop = vi.fn(async () => undefined);
    h.setStop(stop);

    await callDanxbotPrepVerdict(
      { verdict: "blocked", reason: "spec ambiguous" },
      { url: h.url("dispatch-1") },
    );

    const yaml = readIssue(h.root, "DX-100");
    expect(yaml.status).toBe("Blocked");
    expect(yaml.blocked?.reason).toBe("spec ambiguous");
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep blocked/),
    );
  });

  it("abort: stamps agents.<name>.broken via setAgentBroken + stops 'failed'", async () => {
    const stop = vi.fn(async () => undefined);
    h.setStop(stop);

    await callDanxbotPrepVerdict(
      {
        verdict: "abort",
        reason: "Bash returning ENOENT",
        broken_details: { suggested_steps: ["ssh", "fix PATH"] },
      },
      { url: h.url("dispatch-1") },
    );

    expect(h.setBroken).toHaveBeenCalledWith(
      h.root,
      "murphy",
      expect.objectContaining({
        reason: "Bash returning ENOENT",
        suggested_steps: ["ssh", "fix PATH"],
      }),
      "worker",
    );
    expect(stop).toHaveBeenCalledWith(
      "failed",
      expect.stringMatching(/agent env aborted prep/),
    );
  });

  it("ok with dispatchKind=work: agent continues — no job.stop (combined-mode dispatch OR separate-mode self-claim work pass)", async () => {
    writeIssue(h.root, "DX-100");
    const stop = vi.fn(async () => undefined);
    h.setStop(stop);
    h.setDispatchKind("work");

    await callDanxbotPrepVerdict(
      { verdict: "ok", reason: "no conflicts" },
      { url: h.url("dispatch-1") },
    );

    expect(stop).not.toHaveBeenCalled();
  });

  it("ok with dispatchKind=prep: dispatch ends as completed (separate-mode prep-only first pass)", async () => {
    writeIssue(h.root, "DX-100");
    const stop = vi.fn(async () => undefined);
    h.setStop(stop);
    h.setDispatchKind("prep");

    await callDanxbotPrepVerdict(
      { verdict: "ok", reason: "no conflicts" },
      { url: h.url("dispatch-1") },
    );

    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep ok \(prep-only dispatch\)/),
    );
  });

  it("fs-queue fallback fires when the worker is unreachable + dispatchId+repoRoot supplied", async () => {
    // Point the MCP client at a closed port; loopback to a freshly
    // bound socket that immediately closes refuses the connection so
    // the HTTP path fails and the fs queue kicks in.
    const closedServer = createServer();
    await new Promise<void>((r) =>
      closedServer.listen(0, "127.0.0.1", () => r()),
    );
    const { port } = closedServer.address() as AddressInfo;
    await new Promise<void>((r) => closedServer.close(() => r()));

    const payload: PrepVerdictPayload = {
      verdict: "ok",
      reason: "worker unreachable, queueing",
    };
    const out = await callDanxbotPrepVerdict(
      payload as unknown as Record<string, unknown>,
      {
        url: `http://127.0.0.1:${port}/api/prep-verdict/dispatch-1`,
        fallback: { repoRoot: h.root, dispatchId: "dispatch-1" },
      },
    );

    expect(out).toMatch(/queued for boot replay/);
    const file = readFileSync(
      join(h.root, PREP_VERDICT_QUEUE_DIR, "dispatch-1.json"),
      "utf-8",
    );
    const parsed = JSON.parse(file);
    expect(parsed.payload).toEqual(payload);
  });
});
