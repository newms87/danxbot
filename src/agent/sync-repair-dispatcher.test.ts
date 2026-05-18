/**
 * DX-645 (Phase 3 of DX-576) — sync-repair-dispatcher tests.
 *
 * The dispatcher subscribes to `sync-repair-needed`; on every event for
 * THIS worker's repo it dispatches the `worktree-repair` workspace and
 * on terminal `completed` clears `agent.broken` programmatically.
 * Mirrors `evaluator-dispatcher.test.ts` shape — same in-memory agent
 * store + dispatchFn / mutateAgents / readSettings stubs.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  buildSyncRepairPrompt,
  startSyncRepairDispatcher,
} from "./sync-repair-dispatcher.js";
import { dispatchEvents } from "../dispatch/events.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type {
  AgentBrokenState,
  AgentRecord,
} from "../settings-file.js";
import type { AgentJob } from "./launcher.js";

function repo() {
  return makeRepoContext({
    name: "danxbot",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    workerPort: 5562,
    issuePrefix: "DX",
  });
}

/** In-memory agents store driving both `readSettings` + `mutateAgents` stubs. */
function makeAgentStore(initial: Record<string, AgentRecord>) {
  const state = { agents: initial };
  const readSettings = vi.fn(() => ({
    overrides: {} as never,
    display: {} as never,
    agents: state.agents,
    meta: {} as never,
  }));
  const mutateAgents = vi.fn(
    async (
      _localPath: string,
      mutator: (
        current: Record<string, AgentRecord>,
      ) => Record<string, AgentRecord>,
      _writtenBy: string,
    ) => {
      state.agents = mutator({ ...state.agents });
      return { agents: state.agents } as never;
    },
  );
  return { state, readSettings, mutateAgents };
}

function brokenAgent(over?: Partial<AgentBrokenState>): AgentRecord {
  const broken: AgentBrokenState = {
    reason: "syncWorktree aborted: ff-only pull rejected",
    suggested_steps: ["fatal: Not possible to fast-forward"],
    set_at: "2026-05-18T10:00:00Z",
    // DX-364 — sync-recovery uses defaultBrokenEvaluator(): leaves
    // evaluator_dispatch_id null + evaluator_status completed.
    evaluator_status: "completed",
    evaluator_dispatch_id: null,
    ...over,
  };
  return {
    type: "agent",
    bio: "test",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      always_on: true,
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    broken,
    strikes: { count: 0, history: [] },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-18T10:00:00Z",
  } as AgentRecord;
}

let unsubscribe: (() => void) | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  dispatchEvents.removeAllListeners();
});

describe("buildSyncRepairPrompt", () => {
  it("names the agent + worktree + branch + abort reason", () => {
    const prompt = buildSyncRepairPrompt({
      agentName: "alice",
      worktreePath: "/repos/danxbot/.danxbot/worktrees/alice",
      abortReason: "ff-only pull rejected",
      abortDetails: "fatal: Not possible to fast-forward",
    });
    expect(prompt).toMatch(/Broken agent: `alice`/);
    expect(prompt).toMatch(/`\/repos\/danxbot\/\.danxbot\/worktrees\/alice`/);
    expect(prompt).toMatch(/Agent branch: `alice`/);
    expect(prompt).toMatch(/ff-only pull rejected/);
    expect(prompt).toMatch(/fatal: Not possible to fast-forward/);
    // Contract steps the agent MUST execute.
    expect(prompt).toMatch(/git fetch origin/);
    expect(prompt).toMatch(/git rebase origin\/main/);
    expect(prompt).toMatch(/git push --force-with-lease/);
    // Conflict resolution policy must mention the inject-pipeline
    // bucket so the agent takes origin/main on .danxbot/workspaces/.
    expect(prompt).toMatch(/\.danxbot\/workspaces/);
    // Every `git push --force` substring MUST be followed by
    // `-with-lease`. Walk all occurrences instead of using a single
    // negative-lookahead regex (which would silently pass on the
    // wrong line because `.` does not cross newlines).
    const forces = [...prompt.matchAll(/git push --force/g)];
    expect(forces.length).toBeGreaterThan(0);
    for (const m of forces) {
      const tail = prompt.slice(m.index! + m[0].length);
      expect(tail.startsWith("-with-lease")).toBe(true);
    }
  });

  it("omits the verbatim-stderr block when abortDetails is empty", () => {
    const prompt = buildSyncRepairPrompt({
      agentName: "bob",
      worktreePath: "/x/y",
      abortReason: "fetch failed",
      abortDetails: "",
    });
    expect(prompt).not.toMatch(/Verbatim git stderr/);
    expect(prompt).toMatch(/fetch failed/);
  });

  it("truncates abortDetails over 4000 chars (prompt-budget guard)", () => {
    const huge = "x".repeat(10000);
    const prompt = buildSyncRepairPrompt({
      agentName: "c",
      worktreePath: "/x",
      abortReason: "r",
      abortDetails: huge,
    });
    // Only the first 4000 chars land in the prompt.
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });
});

describe("startSyncRepairDispatcher", () => {
  let dispatchFn: ReturnType<typeof vi.fn>;
  let store: ReturnType<typeof makeAgentStore>;
  let uuidStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchFn = vi.fn().mockResolvedValue(undefined);
    store = makeAgentStore({ alice: brokenAgent() });
    uuidStub = vi.fn().mockReturnValue("dispatch-repair-stub");
  });

  function start(over?: { dispatchFn?: typeof dispatchFn }) {
    unsubscribe = startSyncRepairDispatcher({
      repo: repo(),
      dispatchFn: (over?.dispatchFn ??
        dispatchFn) as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["dispatchFn"],
      mutateAgents: store.mutateAgents as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["mutateAgents"],
      readSettings: store.readSettings as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["readSettings"],
      uuid: uuidStub as unknown as () => string,
    });
  }

  function emit() {
    dispatchEvents.emit("sync-repair-needed", {
      repoName: "danxbot",
      agentName: "alice",
      abortReason: "ff-only pull rejected",
      abortDetails: "fatal: Not possible to fast-forward",
    });
  }

  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("dispatches worktree-repair workspace with the repair prompt", async () => {
    start();
    emit();
    await flush();

    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const call = dispatchFn.mock.calls[0][0];
    expect(call.workspace).toBe("worktree-repair");
    expect(call.dispatchId).toBe("dispatch-repair-stub");
    expect(call.task).toMatch(/Broken agent: `alice`/);
    expect(call.task).toMatch(/ff-only pull rejected/);
    expect(call.apiDispatchMeta.trigger).toBe("api");
    expect(call.apiDispatchMeta.metadata.workspace).toBe("worktree-repair");
    // No agent persona — repair dispatch is worker-initiated.
    expect(call.agent).toBeUndefined();
  });

  it("skips events for other repos", async () => {
    start();
    dispatchEvents.emit("sync-repair-needed", {
      repoName: "platform",
      agentName: "alice",
      abortReason: "x",
      abortDetails: "y",
    });
    await flush();

    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("skips events when the agent is no longer broken (race with operator clear)", async () => {
    store = makeAgentStore({
      alice: { ...brokenAgent(), broken: null } as AgentRecord,
    });
    start();
    emit();
    await flush();
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("onComplete with status=completed clears agent.broken + zeros strikes.count", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      return undefined;
    });
    // Seed a non-zero strike count + history so we observe the
    // clear-count + preserve-history contract.
    store = makeAgentStore({
      alice: {
        ...brokenAgent(),
        strikes: {
          count: 2,
          history: [
            {
              dispatch_id: "d-1",
              issue_id: "DX-1",
              terminal_status: "failed",
              timestamp: "2026-05-18T09:00:00Z",
              raw_error: "",
            },
          ],
        },
      },
    });
    start({ dispatchFn });
    emit();
    await flush();

    expect(onCompleteCb).toBeDefined();
    onCompleteCb!({ status: "completed", summary: "done" } as AgentJob);
    await flush();

    expect(store.state.agents.alice.broken).toBeNull();
    expect(store.state.agents.alice.strikes.count).toBe(0);
    // History preserved — the on-record audit window.
    expect(store.state.agents.alice.strikes.history).toHaveLength(1);
    expect(store.state.agents.alice.strikes.history[0].dispatch_id).toBe("d-1");
  });

  it("onComplete with status=failed leaves agent.broken in place (operator-gate fallback)", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      return undefined;
    });
    start({ dispatchFn });
    emit();
    await flush();

    expect(onCompleteCb).toBeDefined();
    onCompleteCb!({ status: "failed", summary: "conflict unreconcilable" } as AgentJob);
    await flush();

    // broken stamp persists for the operator to clear via dashboard.
    expect(store.state.agents.alice.broken).not.toBeNull();
    expect(store.state.agents.alice.broken?.reason).toMatch(/syncWorktree aborted/);
  });

  it("onComplete completed does NOT clear when broken record carries an evaluator binding (safety net)", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      return undefined;
    });
    // Simulate the rare case where a strike-3 evaluator dispatch
    // armed THIS broken record concurrently with the sync-repair
    // flow — the evaluator binding is the load-bearing signal a
    // human investigator should look at. Clearing here would lose
    // it; the dispatcher must skip.
    store = makeAgentStore({
      alice: {
        ...brokenAgent({ evaluator_dispatch_id: "eval-uuid-1", evaluator_status: "completed" }),
      },
    });
    start({ dispatchFn });
    emit();
    await flush();

    onCompleteCb!({ status: "completed", summary: "ok" } as AgentJob);
    await flush();

    expect(store.state.agents.alice.broken).not.toBeNull();
    expect(store.state.agents.alice.broken?.evaluator_dispatch_id).toBe(
      "eval-uuid-1",
    );
  });

  it("onComplete completed handles concurrent operator clear gracefully (no throw)", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      // Simulate operator clearing the broken field BEFORE onComplete
      // fires (rare — between dispatch start and dispatch end).
      store.state.agents.alice = {
        ...store.state.agents.alice,
        broken: null,
      };
      return undefined;
    });
    start({ dispatchFn });
    emit();
    await flush();

    // Should not throw; the dispatcher logs + moves on.
    expect(() => onCompleteCb!({ status: "completed", summary: "ok" } as AgentJob))
      .not.toThrow();
    await flush();
    expect(store.state.agents.alice.broken).toBeNull();
  });

  it("dispatch throws synchronously — logged + swallowed; broken stamp untouched", async () => {
    dispatchFn = vi.fn().mockRejectedValue(new Error("spawn failed"));
    start({ dispatchFn });
    emit();
    await flush();

    // No clear (no onComplete fires when dispatch throws); broken
    // stays as the operator-visible gate.
    expect(store.state.agents.alice.broken).not.toBeNull();
  });

  it("unsubscribe handle drops the listener", async () => {
    start();
    expect(dispatchEvents.listenerCount("sync-repair-needed")).toBe(1);
    unsubscribe?.();
    unsubscribe = null;
    expect(dispatchEvents.listenerCount("sync-repair-needed")).toBe(0);
  });

  // Defense-in-depth coverage (test-reviewer recommendations).
  it("loadBrokenRecord swallows readSettings throws — dispatch skipped", async () => {
    store.readSettings.mockImplementation(() => {
      throw new Error("settings corrupt");
    });
    start();
    emit();
    await flush();
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("agent missing from settings entirely → no-op (loadBrokenRecord !record branch)", async () => {
    store = makeAgentStore({});
    start();
    emit();
    await flush();
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("clearBrokenIfStillSyncRepair: mutateAgents rejection is caught, broken stays", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      // Arm the mutator to reject AFTER the dispatcher's read but
      // BEFORE the onComplete-driven clear runs.
      store.mutateAgents.mockRejectedValueOnce(new Error("disk full"));
      return undefined;
    });
    start({ dispatchFn });
    emit();
    await flush();

    expect(() => onCompleteCb!({ status: "completed", summary: "ok" } as AgentJob))
      .not.toThrow();
    await flush();
    // mutator threw — broken stays populated; the dispatcher logs a
    // warn and moves on.
    expect(store.state.agents.alice.broken).not.toBeNull();
  });

  it("agent record absent at onComplete time — clear no-ops via skipReason", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      // Simulate a concurrent operator delete of the entire agent
      // entry between dispatch start + onComplete.
      delete store.state.agents.alice;
      return undefined;
    });
    start({ dispatchFn });
    emit();
    await flush();

    expect(() => onCompleteCb!({ status: "completed", summary: "ok" } as AgentJob))
      .not.toThrow();
    await flush();
    expect(store.state.agents.alice).toBeUndefined();
  });

  it("non-completed-non-failed terminal status (cancelled) leaves broken in place", async () => {
    let onCompleteCb: ((job: AgentJob) => void) | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      return undefined;
    });
    start({ dispatchFn });
    emit();
    await flush();

    onCompleteCb!({ status: "cancelled", summary: "operator interrupt" } as unknown as AgentJob);
    await flush();
    // Cancelled is neither completed nor failed — broken stamp must
    // persist (the original gate condition was not resolved).
    expect(store.state.agents.alice.broken).not.toBeNull();
  });

  it("worktree path in prompt uses repo.hostPath, NOT repo.localPath", async () => {
    unsubscribe = startSyncRepairDispatcher({
      repo: makeRepoContext({
        name: "danxbot",
        localPath: "/container/repo",
        hostPath: "/host/repo",
        workerPort: 5562,
        issuePrefix: "DX",
      }),
      dispatchFn: dispatchFn as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["dispatchFn"],
      mutateAgents: store.mutateAgents as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["mutateAgents"],
      readSettings: store.readSettings as unknown as Parameters<
        typeof startSyncRepairDispatcher
      >[0]["readSettings"],
      uuid: uuidStub as unknown as () => string,
    });
    emit();
    await flush();

    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const task = dispatchFn.mock.calls[0][0].task as string;
    expect(task).toContain("/host/repo/.danxbot/worktrees/alice");
    expect(task).not.toContain("/container/repo/.danxbot/worktrees");
  });
});
