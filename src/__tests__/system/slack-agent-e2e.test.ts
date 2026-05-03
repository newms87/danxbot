/**
 * Slack agent E2E test harness — Trello CudG7AJy
 *
 * Verifies the full "Slack message arrives → bot reply lands in thread"
 * chain on the danxbot side without spending Anthropic API tokens. Runs
 * the REAL listener, REAL worker `/api/slack/{reply,update}` handlers, and
 * REAL `processResponseWithAttachments` (sql:execute substitution). The
 * EDGES are faked:
 *
 *   - `@slack/bolt` → `FakeSlackApp` (captures + injects).
 *   - `mysql2/promise` Pool → `FakePlatformPool` (canned SELECT results).
 *   - `dispatches-db` → in-memory map.
 *   - `runRouter` (Anthropic Haiku) → vi.fn returning canned RouterResult.
 *   - `dispatch()` → controllable simulation that fires zero or more MCP
 *     callbacks at the real worker handlers, then resolves `onComplete`
 *     with a terminal `AgentJob`. (The real dispatch chain — fake-claude
 *     in PATH, real spawnAgent + JSONL watcher — is covered by
 *     `dispatch-pipeline.test.ts` and `fake-claude-slack-scenario.test.ts`
 *     at the integration layer; re-running it here would be redundant
 *     duplication, not added coverage.)
 *
 * Real-mode scenario #11 (Haiku router + Opus dispatch with real fake-claude
 * spawn) lands behind the `make test-system-slack REAL_CLAUDE=1` target —
 * not in this file's free-mode runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeRepoContext,
  makeRouterResult,
  makeThreadState,
} from "../helpers/fixtures.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../helpers/http-mocks.js";
import {
  installSlackBoltMock,
  getLatestFakeApp,
  resetFakeAppRegistry,
  type FakeSlackApp,
  type SlackMessageHandler,
} from "../integration/helpers/fake-slack-app.js";
import {
  createFakePlatformPool,
  type FakePlatformPool,
} from "../integration/helpers/fake-platform-pool.js";

// --- Module mocks (must hoist before any real-module import below) ---

vi.mock("@slack/bolt", () => installSlackBoltMock());

const mockConfig = {
  isHost: false,
  runtime: "docker",
  agent: {
    model: "test-model",
    routerModel: "test-router-model",
    maxTurns: 5,
    maxBudgetUsd: 1.0,
    maxThinkingTokens: 8000,
    timeoutMs: 300000,
    maxThreadMessages: 20,
    maxRetries: 1,
  },
  dispatch: {
    defaultApiUrl: "http://localhost:80",
    agentTimeoutMs: 3600000,
    mcpProbeTimeoutMs: 3000,
  },
  logsDir: "/tmp/danxbot-slack-e2e-logs",
};
vi.mock("../../config.js", () => ({ config: mockConfig }));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Router (Anthropic Haiku) — always mocked in free mode.
const mockRunRouter = vi.fn();
vi.mock("../../agent/router.js", () => ({
  runRouter: (...args: unknown[]) => mockRunRouter(...args),
}));

// Threads layer — keep the real interface but stub the DB-touching helpers.
const mockGetOrCreateThread = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockIsBotParticipant = vi.fn().mockResolvedValue(true);
const mockTrimThreadMessages = vi.fn().mockImplementation((msgs: unknown[]) => msgs);
vi.mock("../../threads.js", () => ({
  getOrCreateThread: (...a: unknown[]) => mockGetOrCreateThread(...a),
  addMessageToThread: (...a: unknown[]) => mockAddMessageToThread(...a),
  isBotParticipant: (...a: unknown[]) => mockIsBotParticipant(...a),
  trimThreadMessages: (...a: unknown[]) => mockTrimThreadMessages(...a),
}));

// User cache — bypassing the cache means no DB hit during user-name
// resolution. Returns synchronously so the listener doesn't block.
vi.mock("../../slack/user-cache.js", () => ({
  resolveUserName: vi.fn().mockResolvedValue("Test User"),
}));

// Settings file — feature toggle. Tests override per-scenario.
const mockIsFeatureEnabled = vi.fn().mockReturnValue(true);
vi.mock("../../settings-file.js", () => ({
  isFeatureEnabled: (...a: unknown[]) => mockIsFeatureEnabled(...a),
}));

// Critical-failure flag — present on disk halts the poller. Tests don't
// exercise it; stub everything to absent.
vi.mock("../../critical-failure.js", () => ({
  writeFlag: vi.fn(),
  readFlag: vi.fn().mockReturnValue(null),
  clearFlag: vi.fn().mockReturnValue(false),
  flagPath: (localPath: string) => `${localPath}/.danxbot/CRITICAL_FAILURE`,
}));

// Trello notifier — the listener calls this on non-transient errors.
const mockNotifyError = vi.fn().mockResolvedValue(undefined);
vi.mock("../../errors/trello-notifier.js", () => ({
  notifyError: (...a: unknown[]) => mockNotifyError(...a),
}));

// Message queue — keep the real implementation; it's pure in-memory.

// --- Dispatches DB (in-memory) ---

interface DispatchRecord {
  id: string;
  repoName: string;
  trigger: string;
  triggerMetadata: Record<string, unknown>;
  sessionUuid: string | null;
  status: string;
  parentJobId?: string | null;
}

const dispatchesDb = new Map<string, DispatchRecord>();
const mockGetDispatchById = vi.fn(async (id: string) => dispatchesDb.get(id) ?? null);
const mockFindLatestDispatchBySlackThread = vi.fn(async (threadTs: string) => {
  const matches = Array.from(dispatchesDb.values()).filter(
    (d) =>
      d.trigger === "slack" &&
      (d.triggerMetadata as { threadTs?: string }).threadTs === threadTs &&
      d.status === "completed",
  );
  return matches[matches.length - 1] ?? null;
});
vi.mock("../../dashboard/dispatches-db.js", () => ({
  getDispatchById: (...a: unknown[]) => mockGetDispatchById(...(a as [string])),
  findLatestDispatchBySlackThread: (...a: unknown[]) =>
    mockFindLatestDispatchBySlackThread(...(a as [string])),
  insertDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatch: vi.fn().mockResolvedValue(undefined),
  rowToDispatch: vi.fn(),
  dispatchToInsertParams: vi.fn(),
}));

// --- Platform pool (sql:execute substitution) ---

let fakePool: FakePlatformPool;
vi.mock("../../db/connection.js", () => ({
  getPlatformPool: () => fakePool,
  initPlatformPool: vi.fn(),
}));

// --- Dispatch core — controllable simulation ---

interface SimulatedAgent {
  /** Newline-delimited intermediate update texts (POSTed to handleSlackUpdate). */
  updates?: string[];
  /** Final reply text (POSTed to handleSlackReply). Optional — when omitted, the agent crashes mid-flight. */
  reply?: string;
  /** Replaces the sql:execute SQL injected into the reply. */
  sqlBlockSql?: string;
  /** Terminal AgentJob status. */
  status?: "completed" | "failed" | "timeout" | "canceled";
  /** Terminal summary string. */
  summary?: string | null;
  /** Pre-spawn error — `dispatch()` rejects synchronously instead of running. */
  spawnError?: Error;
}

/** Default simulation: completed reply, no updates, no SQL block. */
const DEFAULT_SIMULATED_AGENT: SimulatedAgent = {
  reply: "Done.",
  status: "completed",
};

let nextSimulatedAgent: SimulatedAgent = { ...DEFAULT_SIMULATED_AGENT };

/**
 * The shape of the input the listener passes to `dispatch()`. Mirrors the
 * subset of `DispatchInput` (from `src/dispatch/core.ts`) the e2e
 * scenarios assert on. Locking it down here means a `dispatch()` signature
 * change in the production code surfaces as a TS error in this file
 * instead of silently rotting the assertions.
 */
interface ObservedDispatchInput {
  workspace: string;
  task: string;
  overlay: Record<string, string>;
  apiDispatchMeta: { trigger: string; metadata: Record<string, string> };
  resumeSessionId?: string;
  parentJobId?: string;
  repo: { name: string; workerPort: number } & Record<string, unknown>;
  onComplete?: (job: {
    id: string;
    status: string;
    summary?: string | null;
  }) => void;
}

let lastDispatchInput: ObservedDispatchInput | null = null;

const mockDispatch = vi.fn();
vi.mock("../../dispatch/core.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

// --- Real imports (under test) ---

const { startSlackListener, resetListenerState } = await import(
  "../../slack/listener.js"
);
const { handleSlackReply, handleSlackUpdate } = await import(
  "../../worker/dispatch.js"
);

// --- Test helpers ---

function buildSlackDispatchRow(
  id: string,
  repoName: string,
  channelId: string,
  threadTs: string,
  messageTs: string,
  user: string,
  messageText: string,
): DispatchRecord {
  return {
    id,
    repoName,
    trigger: "slack",
    triggerMetadata: {
      channelId,
      threadTs,
      messageTs,
      user,
      userName: null,
      messageText,
    },
    sessionUuid: `session-${id}`,
    status: "running",
  };
}

async function postToWorker(
  handler: typeof handleSlackReply,
  dispatchId: string,
  body: Record<string, unknown>,
  repo: ReturnType<typeof makeRepoContext>,
): Promise<{ status: number; body: string }> {
  const req = createMockReqWithBody("POST", body);
  const res = createMockRes();
  await handler(req, res, dispatchId, repo);
  return { status: res._getStatusCode(), body: res._getBody() };
}

/**
 * Configure `mockDispatch` to simulate the agent. Each call resolves
 * synchronously then fires onComplete on a microtask, mirroring real
 * `dispatch()` semantics.
 */
function arrangeAgent(repo: ReturnType<typeof makeRepoContext>): void {
  mockDispatch.mockImplementation(async (input: ObservedDispatchInput) => {
    lastDispatchInput = input;
    if (nextSimulatedAgent.spawnError) {
      throw nextSimulatedAgent.spawnError;
    }
    const dispatchId = `dispatch-${dispatchesDb.size + 1}`;
    const meta = input.apiDispatchMeta.metadata;
    const row = buildSlackDispatchRow(
      dispatchId,
      repo.name,
      meta.channelId,
      meta.threadTs,
      meta.messageTs,
      meta.user,
      meta.messageText,
    );
    dispatchesDb.set(dispatchId, row);

    const sim = nextSimulatedAgent;
    // Microtask-deferred so dispatch() returns before onComplete fires —
    // mirrors real dispatch which spawns claude and then resolves the
    // launcher Promise on a later terminal event. Uncaught errors here
    // surface as `unhandledRejection` in vitest, which fails the test
    // loudly (no try/catch needed; swallowing would hide simulation bugs).
    queueMicrotask(async () => {
      for (const update of sim.updates ?? []) {
        await postToWorker(handleSlackUpdate, dispatchId, { text: update }, repo);
      }
      if (sim.reply !== undefined) {
        const text = sim.sqlBlockSql
          ? `${sim.reply}\n\n\`\`\`sql:execute\n${sim.sqlBlockSql}\n\`\`\``
          : sim.reply;
        await postToWorker(handleSlackReply, dispatchId, { text }, repo);
      }
      const status = sim.status ?? "completed";
      row.status = status;
      const finalSummary = sim.summary ?? sim.reply ?? null;
      input.onComplete?.({
        id: dispatchId,
        status,
        summary: finalSummary,
      });
    });

    return { dispatchId, job: {} };
  });
}

let fakeApp: FakeSlackApp;
let handler: SlackMessageHandler;
const repo = makeRepoContext();

beforeEach(async () => {
  vi.clearAllMocks();
  resetListenerState();
  resetFakeAppRegistry();
  dispatchesDb.clear();
  fakePool = createFakePlatformPool();
  lastDispatchInput = null;
  nextSimulatedAgent = { ...DEFAULT_SIMULATED_AGENT };

  // Default thread state: empty messages, single-message threads.
  mockGetOrCreateThread.mockResolvedValue(makeThreadState());
  mockIsFeatureEnabled.mockReturnValue(true);
  mockIsBotParticipant.mockResolvedValue(true);

  // Default router: needs agent (most scenarios). Quick-reply scenario
  // overrides this.
  mockRunRouter.mockResolvedValue(makeRouterResult({ needsAgent: true }));
  arrangeAgent(repo);

  await startSlackListener(repo);
  fakeApp = getLatestFakeApp()!;
  handler = fakeApp.getMessageHandler() as typeof handler;
  if (!handler) throw new Error("listener did not register a message handler");
});

afterEach(() => {
  // Drain any pending microtasks scheduled by the dispatch simulation.
  return new Promise<void>((r) => setImmediate(r));
});

/** Fire a Slack message and await the listener handler's full lifecycle. */
async function fireMessage(opts: {
  text?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  channel?: string;
  bot_id?: string;
  subtype?: string;
}): Promise<void> {
  await handler({
    message: {
      type: "message",
      channel: opts.channel ?? repo.slack.channelId,
      user: opts.user ?? "U-HUMAN",
      text: opts.text ?? "Hello danxbot",
      ts: opts.ts ?? "111.111",
      thread_ts: opts.thread_ts,
      bot_id: opts.bot_id,
      subtype: opts.subtype,
    },
    client: fakeApp.client,
  });
}

// ============================================================
// SCENARIO 1: Happy path with intermediate updates
// ============================================================

describe("scenario 1: happy path with intermediate updates", () => {
  it("router → dispatch → intermediate updates → final reply → reaction swap brain→white_check_mark", async () => {
    nextSimulatedAgent = {
      updates: ["Looking into it…", "Almost there…"],
      reply: "All done.",
      status: "completed",
    };

    await fireMessage({ ts: "555.111", text: "what's the count?" });

    expect(mockRunRouter).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    expect(lastDispatchInput!.apiDispatchMeta.trigger).toBe("slack");

    // Brain reaction added immediately; swapped to ✅ on completion.
    expect(fakeApp.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "brain", timestamp: "555.111" }),
    );
    // swapReaction calls reactions.remove("brain") + reactions.add("white_check_mark").
    expect(fakeApp.client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "brain", timestamp: "555.111" }),
    );
    expect(fakeApp.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "white_check_mark", timestamp: "555.111" }),
    );

    // Each intermediate + final update lands as a chat.postMessage in the thread.
    const postedTexts = fakeApp.client.chat.postMessage.mock.calls.map(
      (c) => (c[0] as { text: string }).text,
    );
    expect(postedTexts).toContain("Looking into it…");
    expect(postedTexts).toContain("Almost there…");
    expect(postedTexts).toContain("All done.");
  });
});

// ============================================================
// SCENARIO 2: Quick reply (router decides needsAgent=false)
// ============================================================

describe("scenario 2: quick reply (router only)", () => {
  it("router's quickResponse is posted; no dispatch; no brain reaction", async () => {
    mockRunRouter.mockResolvedValue(
      makeRouterResult({ needsAgent: false, quickResponse: "Hi there!" }),
    );

    await fireMessage({ ts: "222.111", text: "hello" });

    const postedTexts = fakeApp.client.chat.postMessage.mock.calls.map(
      (c) => (c[0] as { text: string }).text,
    );
    expect(postedTexts).toContain("Hi there!");
    expect(mockDispatch).not.toHaveBeenCalled();
    // No brain reaction — quick replies skip the reaction lifecycle entirely.
    const reactionAddNames = fakeApp.client.reactions.add.mock.calls.map(
      (c) => (c[0] as { name: string }).name,
    );
    expect(reactionAddNames).not.toContain("brain");
  });
});

// ============================================================
// SCENARIO 3: Slack feature toggle off
// ============================================================

describe("scenario 3: Slack feature toggle off", () => {
  it("posts the disabled reply, reacts :no_entry_sign:, never invokes router or dispatch", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);

    await fireMessage({ ts: "333.111" });

    expect(fakeApp.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "no_entry_sign" }),
    );
    expect(fakeApp.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("currently disabled"),
      }),
    );
    expect(mockRunRouter).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ============================================================
// SCENARIO 4: Concurrent messages on same thread
// ============================================================

describe("scenario 4: concurrent messages on same thread", () => {
  it("second message in-flight is enqueued with 'I'll get to this…' and does NOT spawn a second dispatch", async () => {
    // The first dispatch must be in-flight — i.e. the listener has hit
    // `markProcessing(threadTs)` — BEFORE the second message fires.
    // A `setImmediate` poll relies on microtask ordering luck; under load
    // it could pass for the wrong reason if the second handler short-
    // circuits on a regression that drops thread replies. Resolve a
    // promise the moment dispatch is invoked, then `await` it before
    // firing the second message.
    let firstDispatchEntered: () => void;
    const firstDispatchInFlight = new Promise<void>((resolve) => {
      firstDispatchEntered = resolve;
    });
    let pendingResolve: (() => void) | null = null;
    mockDispatch.mockImplementation(async (input: ObservedDispatchInput) => {
      lastDispatchInput = input;
      const dispatchId = `dispatch-${dispatchesDb.size + 1}`;
      const meta = input.apiDispatchMeta.metadata;
      dispatchesDb.set(
        dispatchId,
        buildSlackDispatchRow(
          dispatchId,
          repo.name,
          meta.channelId,
          meta.threadTs,
          meta.messageTs,
          meta.user,
          meta.messageText,
        ),
      );
      firstDispatchEntered();
      // Park the onComplete — listener.launchSlackDispatch awaits it.
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
      input.onComplete?.({ id: dispatchId, status: "completed", summary: "Done." });
      return { dispatchId, job: {} };
    });

    // Both messages share thread_ts via Slack's convention: ts is the
    // thread's parent for the first message; subsequent in-thread messages
    // carry the parent ts as thread_ts.
    const firstPromise = fireMessage({ ts: "T.1", text: "first" });
    // Wait for the listener to have entered launchSlackDispatch — i.e.
    // markProcessing has fired and dispatch() is parked.
    await firstDispatchInFlight;

    await fireMessage({ ts: "T.2", thread_ts: "T.1", text: "second" });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const queueAcks = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .filter((t) => t.includes("I'll get to this"));
    expect(queueAcks.length).toBeGreaterThanOrEqual(1);

    // Release the first dispatch so the test cleans up.
    pendingResolve!();
    await firstPromise;
  });
});

// ============================================================
// SCENARIO 5: Dispatch spawn-time failure
// ============================================================

describe("scenario 5: dispatch spawn-time failure", () => {
  it("non-transient spawn error → :x: + 'couldn't launch the agent' line + Trello notify", async () => {
    nextSimulatedAgent = {
      spawnError: new Error("schema server missing apiUrl (SCHEMA_API_URL)"),
    };
    await fireMessage({ ts: "555.444" });

    expect(fakeApp.client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "brain" }),
    );
    expect(fakeApp.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
    const failureLine = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .find((t) => t.includes("couldn't launch the agent"));
    expect(failureLine).toBeDefined();
    expect(mockNotifyError).toHaveBeenCalled();
  });
});

// ============================================================
// SCENARIO 6: Agent times out without posting
// ============================================================

describe("scenario 6: agent times out without posting", () => {
  it("terminal status='timeout' → 'Timed out' failure line + brain→x reaction swap", async () => {
    nextSimulatedAgent = {
      // No reply, no updates — agent died silently.
      status: "timeout",
      summary: "no activity for 600s",
      reply: undefined,
    };
    await fireMessage({ ts: "666.111" });

    expect(fakeApp.client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
    const timeoutLine = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .find((t) => t.includes("Timed out"));
    expect(timeoutLine).toBeDefined();
    // Trello notify fires (timeout is operational, not user-cancelled).
    expect(mockNotifyError).toHaveBeenCalled();
  });
});

// ============================================================
// SCENARIO 7: SQL substitution path (K2zQYIdX regression guard)
// ============================================================

describe("scenario 7: SQL substitution path (K2zQYIdX regression guard)", () => {
  it("agent emits ```sql:execute SELECT…``` → bolt receives substituted text (no `sql:execute` substring) + filesUploadV2 with CSV", async () => {
    fakePool.registerQuery("SELECT id, name FROM users LIMIT 1", [
      { id: 1, name: "alice" },
    ]);

    nextSimulatedAgent = {
      reply: "Here you go:",
      sqlBlockSql: "SELECT id, name FROM users LIMIT 1",
      status: "completed",
    };
    await fireMessage({ ts: "777.111" });

    // The text bolt receives must NOT contain the verbatim sql:execute
    // block — that's the K2zQYIdX bug. Substitution replaces it with
    // a "Query returned N row(s) — see attached CSV." line.
    const slackPosts = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .filter((t) => t.includes("Here you go:"));
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0]).not.toContain("sql:execute");
    expect(slackPosts[0]).toMatch(/Query returned 1 row/);

    // CSV attachment uploaded to the same thread.
    expect(fakeApp.client.filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringMatching(/^query-result-\d+-1\.csv$/),
        content: expect.stringContaining("id,name"),
      }),
    );
  });
});

// ============================================================
// SCENARIO 8: Thread continuity / resume
// ============================================================

describe("scenario 8: thread continuity / resume", () => {
  it("second message in same thread → dispatch carries parentJobId + resumeSessionId from prior completed dispatch", async () => {
    // Pre-seed: a prior completed dispatch on the same thread.
    dispatchesDb.set("prior-1", {
      id: "prior-1",
      repoName: repo.name,
      trigger: "slack",
      triggerMetadata: {
        channelId: repo.slack.channelId,
        threadTs: "888.000",
        messageTs: "888.000",
        user: "U-HUMAN",
        userName: null,
        messageText: "first",
      },
      sessionUuid: "session-prior-1",
      status: "completed",
    });

    // Populate thread state with multiple messages so the resume
    // short-circuit in `buildSlackAgentPrompt` is actually exercised —
    // without priors > 1, the function returns text unchanged
    // regardless of the resume gate, which would let a buggy gate pass.
    mockGetOrCreateThread.mockResolvedValue(
      makeThreadState({
        threadTs: "888.000",
        messages: [
          { user: "U-HUMAN", text: "first", ts: "888.000", isBot: false },
          { user: "danxbot", text: "answer 1", ts: "888.000-bot", isBot: true },
          { user: "U-HUMAN", text: "follow-up", ts: "888.001", isBot: false },
        ],
      }),
    );

    nextSimulatedAgent = { reply: "Continuing.", status: "completed" };
    await fireMessage({ ts: "888.001", thread_ts: "888.000", text: "follow-up" });

    expect(lastDispatchInput!.parentJobId).toBe("prior-1");
    expect(lastDispatchInput!.resumeSessionId).toBe("session-prior-1");
    // Resumed dispatches must NOT re-prepend thread history (the resumed
    // session already has it). Thread state above has 3 messages, so
    // a buggy resume gate would prepend "[Thread context]" — the
    // not.toContain assertion makes that regression fail loudly.
    expect(lastDispatchInput!.task).toBe("follow-up");
    expect(lastDispatchInput!.task).not.toContain("[Thread context]");
  });
});

// ============================================================
// SCENARIO 9: MCP cross-worker guard
// ============================================================

describe("scenario 9: MCP cross-worker guard", () => {
  it("POST /api/slack/reply/:foreign-id with a dispatchId belonging to a different repo → 404, no chat.postMessage from this worker's bolt client", async () => {
    // Insert a dispatch row that belongs to OTHER repo.
    dispatchesDb.set("foreign-dispatch", {
      id: "foreign-dispatch",
      repoName: "other-repo", // <-- intentionally different
      trigger: "slack",
      triggerMetadata: {
        channelId: "C-OTHER",
        threadTs: "FOREIGN.0",
        messageTs: "FOREIGN.0",
        user: "U-OTHER",
        userName: null,
        messageText: "hi",
      },
      sessionUuid: "foreign-session",
      status: "running",
    });

    const result = await postToWorker(
      handleSlackReply,
      "foreign-dispatch",
      { text: "this should not post" },
      repo,
    );

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body).error).toMatch(/not owned by this worker/);
    expect(fakeApp.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

// ============================================================
// SCENARIO 10: Slack-worker dispatch contract
// ============================================================
//
// The launcher's heartbeat PUT-running/PUT-completed loop is the
// dispatch-pipeline test's territory (see `make test-system-heartbeat`)
// — this test does NOT cover that lifecycle. What it DOES cover is the
// shape of every `dispatch()` invocation the listener emits: workspace
// name, trigger metadata, and the worker-port overlay placeholder.
// That shape is the contract the launcher relies on to wire up MCP
// subprocess env / statusUrl callbacks. A regression that drops any
// one of these would silently break the downstream heartbeat in prod
// — that's why this test exists, even though it doesn't observe the
// PUT loop directly.

describe("scenario 10: Slack-worker dispatch contract", () => {
  it("every Slack-triggered dispatch arrives with workspace=slack-worker, apiDispatchMeta.trigger=slack, and an empty caller overlay (DANXBOT_WORKER_PORT auto-injected by dispatch core)", async () => {
    nextSimulatedAgent = { reply: "Done.", status: "completed" };
    await fireMessage({ ts: "10.10", text: "trigger me" });

    expect(lastDispatchInput!.workspace).toBe("slack-worker");
    expect(lastDispatchInput!.apiDispatchMeta.trigger).toBe("slack");
    // Phase 5 hotfix: dispatch() auto-injects DANXBOT_WORKER_PORT from
    // `repo.workerPort`. The slack listener no longer pre-stamps it
    // into the overlay — observe an empty overlay coming out of the
    // listener; verifying the actual port lands in the resolved
    // settings.json belongs in dispatch-core integration tests.
    expect(lastDispatchInput!.overlay).toEqual({});
  });
});

// ============================================================
// Worker-handler edge cases — round out the substitution +
// validation surface that the K2zQYIdX-class regression guard
// (scenario 7) only partially covers.
// ============================================================

describe("scenario 7b: SQL substitution rejects unsafe queries", () => {
  it("agent emits a non-SELECT sql:execute block → bolt receives 'Only SELECT queries are allowed' + no filesUploadV2", async () => {
    // No fake-pool fixture registered — `isSafeQuery` rejects this
    // BEFORE `executeQuery` is called, so a missing fixture would NOT
    // cause a problem. The assertion is on the substituted text.
    nextSimulatedAgent = {
      reply: "Result:",
      sqlBlockSql: "DROP TABLE users",
      status: "completed",
    };

    await fireMessage({ ts: "7b.111", text: "drop it please" });

    const slackPosts = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .filter((t) => t.includes("Result:"));
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0]).toContain("Only SELECT queries are allowed");
    // No CSV upload — the rejection path skips the attachment branch.
    expect(fakeApp.client.filesUploadV2).not.toHaveBeenCalled();
  });
});

describe("scenario 7c: SQL substitution with empty result set", () => {
  it("agent emits a SELECT that returns zero rows → bolt receives '*No results found.*' + no filesUploadV2", async () => {
    fakePool.registerQuery("SELECT id FROM users WHERE 1=0", []);

    nextSimulatedAgent = {
      reply: "Tally:",
      sqlBlockSql: "SELECT id FROM users WHERE 1=0",
      status: "completed",
    };

    await fireMessage({ ts: "7c.111", text: "any?" });

    const slackPosts = fakeApp.client.chat.postMessage.mock.calls
      .map((c) => (c[0] as { text: string }).text)
      .filter((t) => t.includes("Tally:"));
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0]).toContain("No results found");
    expect(fakeApp.client.filesUploadV2).not.toHaveBeenCalled();
  });
});

describe("scenario 11: chat.postMessage failure surfaces as 500 from the worker handler", () => {
  it("bolt's chat.postMessage throws → handleSlackReply returns 500 with 'Failed to post to Slack'", async () => {
    // Pre-seed a slack dispatch row this worker owns.
    dispatchesDb.set("ch-fail", {
      id: "ch-fail",
      repoName: repo.name,
      trigger: "slack",
      triggerMetadata: {
        channelId: repo.slack.channelId,
        threadTs: "ch.fail",
        messageTs: "ch.fail",
        user: "U-HUMAN",
        userName: null,
        messageText: "doesn't matter",
      },
      sessionUuid: "ch-fail-session",
      status: "running",
    });
    fakeApp.client.chat.postMessage.mockRejectedValueOnce(new Error("rate_limited"));

    const result = await postToWorker(
      handleSlackReply,
      "ch-fail",
      { text: "hello" },
      repo,
    );

    expect(result.status).toBe(500);
    expect(JSON.parse(result.body).error).toMatch(/Failed to post to Slack/);
  });
});

describe("scenario 12: parseSlackText rejects empty body field", () => {
  it("POST /api/slack/reply/:id with body {text:''} → 400", async () => {
    dispatchesDb.set("empty-text", {
      id: "empty-text",
      repoName: repo.name,
      trigger: "slack",
      triggerMetadata: {
        channelId: repo.slack.channelId,
        threadTs: "et.0",
        messageTs: "et.0",
        user: "U-HUMAN",
        userName: null,
        messageText: "x",
      },
      sessionUuid: "empty-text-session",
      status: "running",
    });

    const result = await postToWorker(
      handleSlackReply,
      "empty-text",
      { text: "" },
      repo,
    );

    expect(result.status).toBe(400);
    // chat.postMessage must NOT have been called for an empty-text post.
    expect(fakeApp.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe("scenario 13: dispatch.trigger !== 'slack' returns 404 from slack endpoint", () => {
  it("POST /api/slack/reply/:id with a Trello-triggered dispatch → 404", async () => {
    dispatchesDb.set("trello-triggered", {
      id: "trello-triggered",
      repoName: repo.name,
      trigger: "trello", // <-- not slack
      triggerMetadata: { cardId: "abc" },
      sessionUuid: "tt-session",
      status: "running",
    });

    const result = await postToWorker(
      handleSlackReply,
      "trello-triggered",
      { text: "should be rejected" },
      repo,
    );

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body).error).toMatch(/not a Slack dispatch/);
    expect(fakeApp.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe("scenario 14: filesUploadV2 failure does NOT silence the reply", () => {
  it("CSV upload throws → reply text already POSTed, handler still 200, warn-only branch", async () => {
    fakePool.registerQuery("SELECT id FROM users", [{ id: 1 }]);
    fakeApp.client.filesUploadV2.mockRejectedValueOnce(new Error("file_upload_failed"));

    dispatchesDb.set("upload-fail", {
      id: "upload-fail",
      repoName: repo.name,
      trigger: "slack",
      triggerMetadata: {
        channelId: repo.slack.channelId,
        threadTs: "uf.0",
        messageTs: "uf.0",
        user: "U-HUMAN",
        userName: null,
        messageText: "x",
      },
      sessionUuid: "uf-session",
      status: "running",
    });

    const replyText =
      "Here:\n\n```sql:execute\nSELECT id FROM users\n```";
    const result = await postToWorker(
      handleSlackReply,
      "upload-fail",
      { text: replyText },
      repo,
    );

    // The reply post itself succeeded; only the attachment failed.
    expect(result.status).toBe(200);
    expect(fakeApp.client.chat.postMessage).toHaveBeenCalled();
    expect(fakeApp.client.filesUploadV2).toHaveBeenCalled();
  });
});
