import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  buildEvaluatorPrompt,
  startEvaluatorDispatcher,
} from "./evaluator-dispatcher.js";
import { dispatchEvents } from "../dispatch/events.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type {
  AgentBrokenState,
  AgentRecord,
  AgentStrikeEntry,
} from "../settings-file.js";

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

function strikeEntry(over?: Partial<AgentStrikeEntry>): AgentStrikeEntry {
  return {
    dispatch_id: "d-1",
    issue_id: "DX-100",
    terminal_status: "failed",
    timestamp: "2026-05-14T10:00:00Z",
    raw_error: "",
    ...over,
  };
}

function brokenAgent(over?: Partial<AgentBrokenState>): AgentRecord {
  const broken: AgentBrokenState = {
    reason: "Agent dispatch failing — investigation pending",
    suggested_steps: [],
    set_at: "2026-05-14T10:00:00Z",
    evaluator_status: "pending",
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
    strikes: {
      count: 3,
      history: [
        strikeEntry({ dispatch_id: "d-1", issue_id: "DX-100" }),
        strikeEntry({ dispatch_id: "d-2", issue_id: "DX-101" }),
        strikeEntry({ dispatch_id: "d-3", issue_id: "DX-102" }),
      ],
    },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-14T10:00:00Z",
  } as AgentRecord;
}

let unsubscribe: (() => void) | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  dispatchEvents.removeAllListeners();
});

describe("buildEvaluatorPrompt", () => {
  it("names the target agent + repo and lists every strike's dispatch_id", () => {
    const prompt = buildEvaluatorPrompt({
      agentName: "alice",
      repoName: "danxbot",
      strikes: [
        strikeEntry({ dispatch_id: "d-1", issue_id: "DX-100" }),
        strikeEntry({ dispatch_id: "d-2", issue_id: "DX-101" }),
        strikeEntry({ dispatch_id: "d-3", issue_id: "DX-102" }),
      ],
    });
    expect(prompt).toMatch(/Agent: `alice`/);
    expect(prompt).toMatch(/Repo: `danxbot`/);
    expect(prompt).toMatch(/dispatch_id=d-1/);
    expect(prompt).toMatch(/dispatch_id=d-2/);
    expect(prompt).toMatch(/dispatch_id=d-3/);
    // Names the tool the evaluator MUST call.
    expect(prompt).toMatch(/danxbot_set_evaluator_summary/);
    // Tells the evaluator where to find the JSONL files.
    expect(prompt).toMatch(/danxbot-dispatch:/);
    // Specifies the exact markdown section headers the dashboard banner
    // depends on — regression target if anyone reflows the template.
    expect(prompt).toMatch(/## Root cause\(s\)/);
    expect(prompt).toMatch(/## Per-strike detail/);
    expect(prompt).toMatch(/## Recommended human action/);
  });

  it("emits the defensive empty-history line when strikes are missing", () => {
    const prompt = buildEvaluatorPrompt({
      agentName: "alice",
      repoName: "danxbot",
      strikes: [],
    });
    expect(prompt).toMatch(/defensive empty case/);
  });

  it("truncates a long raw_error to 200 chars", () => {
    const longErr = "x".repeat(500);
    const prompt = buildEvaluatorPrompt({
      agentName: "alice",
      repoName: "danxbot",
      strikes: [strikeEntry({ raw_error: longErr })],
    });
    // The prompt embeds the first 200 chars of raw_error and nothing more.
    expect(prompt).toContain("x".repeat(200));
    expect(prompt).not.toContain("x".repeat(201));
  });
});

describe("startEvaluatorDispatcher", () => {
  let dispatchFn: ReturnType<typeof vi.fn>;
  let store: ReturnType<typeof makeAgentStore>;
  let uuidStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchFn = vi.fn().mockResolvedValue(undefined);
    store = makeAgentStore({ alice: brokenAgent() });
    uuidStub = vi.fn().mockReturnValue("dispatch-eval-stub");
  });

  function start(over?: { dispatchFn?: typeof dispatchFn }) {
    unsubscribe = startEvaluatorDispatcher({
      repo: repo(),
      dispatchFn: (over?.dispatchFn ??
        dispatchFn) as unknown as Parameters<
        typeof startEvaluatorDispatcher
      >[0]["dispatchFn"],
      mutateAgents: store.mutateAgents as unknown as Parameters<
        typeof startEvaluatorDispatcher
      >[0]["mutateAgents"],
      readSettings: store.readSettings as unknown as Parameters<
        typeof startEvaluatorDispatcher
      >[0]["readSettings"],
      uuid: uuidStub as unknown as () => string,
    });
  }

  async function flush() {
    // Event handlers are fire-and-forget Promises. Resolve the
    // microtask queue twice — once for the read+stamp, once for the
    // dispatch call — so assertions observe the post-emit state.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("stamps evaluator_status=running + evaluator_dispatch_id and calls dispatch", async () => {
    start();
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    expect(store.mutateAgents).toHaveBeenCalled();
    const stampedBroken = store.state.agents.alice.broken!;
    expect(stampedBroken.evaluator_dispatch_id).toBe("dispatch-eval-stub");

    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const call = dispatchFn.mock.calls[0][0];
    expect(call.workspace).toBe("system-evaluator");
    expect(call.dispatchId).toBe("dispatch-eval-stub");
    expect(call.evaluatorSummaryUrl).toBe(
      "http://localhost:5562/api/evaluator-summary/dispatch-eval-stub",
    );
    expect(call.task).toMatch(/Agent: `alice`/);
    expect(call.apiDispatchMeta.trigger).toBe("api");
    expect(call.apiDispatchMeta.metadata.workspace).toBe("system-evaluator");
  });

  it("skips events for other repos", async () => {
    start();
    dispatchEvents.emit("broken-transition", {
      repoName: "platform",
      agentName: "alice",
    });
    await flush();

    expect(store.mutateAgents).not.toHaveBeenCalled();
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("skips events when the agent is no longer broken (race)", async () => {
    store = makeAgentStore({
      alice: { ...brokenAgent(), broken: null } as AgentRecord,
    });
    start();
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("flips evaluator_status to failed when dispatch throws synchronously", async () => {
    dispatchFn = vi.fn().mockRejectedValue(new Error("spawn failed"));
    start({ dispatchFn });
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    expect(store.state.agents.alice.broken?.evaluator_status).toBe("failed");
    // The default reason from Phase 2 stays.
    expect(store.state.agents.alice.broken?.reason).toBe(
      "Agent dispatch failing — investigation pending",
    );
    // Dispatch id stays — operator can still re-run via dashboard.
    expect(store.state.agents.alice.broken?.evaluator_dispatch_id).toBe(
      "dispatch-eval-stub",
    );
  });

  it("flips evaluator_status to failed in onComplete when the evaluator never wrote a summary", async () => {
    // The dispatch resolves successfully but the evaluator dispatch
    // ended without calling `danxbot_set_evaluator_summary`. The
    // dispatch.onComplete handler the dispatcher installs flips the
    // status to "failed".
    let onCompleteCb:
      | ((job: unknown) => void | Promise<void>)
      | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      return undefined;
    });
    start({ dispatchFn });
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    expect(onCompleteCb).toBeDefined();
    // The worker-route happy path would have flipped evaluator_status
    // to "completed". Since onCompleteCb runs without that side-effect,
    // status is still "running" — fire onComplete and observe the flip.
    await onCompleteCb!({});
    expect(store.state.agents.alice.broken?.evaluator_status).toBe("failed");
  });

  it("onComplete leaves evaluator_status alone when summary already landed (status=completed)", async () => {
    let onCompleteCb:
      | ((job: unknown) => void | Promise<void>)
      | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      // Simulate the worker route flipping status to "completed"
      // BEFORE onComplete fires (the real worker route runs during the
      // agent's tool call, which happens before the dispatch ends).
      store.state.agents.alice = {
        ...store.state.agents.alice,
        broken: {
          ...store.state.agents.alice.broken!,
          reason: "## Root cause\nReal summary",
          evaluator_status: "completed",
        },
      };
      return undefined;
    });
    start({ dispatchFn });
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    await onCompleteCb!({});
    expect(store.state.agents.alice.broken?.evaluator_status).toBe(
      "completed",
    );
    expect(store.state.agents.alice.broken?.reason).toBe(
      "## Root cause\nReal summary",
    );
  });

  it("onComplete short-circuits when evaluator_dispatch_id no longer matches (re-run race)", async () => {
    let onCompleteCb:
      | ((job: unknown) => void | Promise<void>)
      | undefined;
    dispatchFn = vi.fn(async (input: { onComplete?: typeof onCompleteCb }) => {
      onCompleteCb = input.onComplete;
      // Simulate the operator triggering re-run mid-flight — the
      // dispatch_id no longer matches our dispatcher's stamped id.
      store.state.agents.alice = {
        ...store.state.agents.alice,
        broken: {
          ...store.state.agents.alice.broken!,
          evaluator_status: "running",
          evaluator_dispatch_id: "dispatch-eval-FRESH",
        },
      };
      return undefined;
    });
    start({ dispatchFn });
    dispatchEvents.emit("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
    await flush();

    await onCompleteCb!({});
    // Status STAYS at "running" — the fresh re-run dispatch will
    // produce its own terminal state. A stale onComplete must not
    // flip the fresh re-run's status.
    expect(store.state.agents.alice.broken?.evaluator_status).toBe(
      "running",
    );
    expect(store.state.agents.alice.broken?.evaluator_dispatch_id).toBe(
      "dispatch-eval-FRESH",
    );
  });

  it("unsubscribe handle drops the listener", async () => {
    start();
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(1);
    unsubscribe?.();
    unsubscribe = null;
    expect(dispatchEvents.listenerCount("broken-transition")).toBe(0);
  });
});
