import type {
  ThreadMessage,
  ThreadState,
  RouterResult,
  AgentResponse,
  AgentLogEntry,
} from "../../types.js";

/**
 * Creates a ThreadMessage with sensible defaults.
 */
export function msg(
  text: string,
  isBot: boolean,
  user = isBot ? "flytebot" : "U123",
): ThreadMessage {
  return { user, text, ts: Date.now().toString(), isBot };
}

/**
 * Creates a full config object matching the shape of src/config.ts.
 * Pass overrides for any nested section.
 */
export function makeConfig(overrides?: Record<string, unknown>) {
  return {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelId: "C-TEST",
    },
    anthropic: { apiKey: "test-key" },
    agent: {
      model: "test-model",
      maxTurns: 5,
      maxBudgetUsd: 1.0,
      maxThinkingTokens: 8000,
      timeoutMs: 300000,
      maxThreadMessages: 20,
      maxRetries: 1,
    },
    platform: {
      repoUrl: "https://test.example.com",
      repoPath: "/test",
      db: {
        host: "localhost",
        user: "test",
        password: "test",
        database: "test",
      },
    },
    github: { webhookSecret: "" },
    rateLimitSeconds: 30,
    logLevel: "info",
    threadsDir: "/test/threads",
    logsDir: "/test/logs",
    eventsFile: "/test/data/events.json",
    ...overrides,
  };
}

/**
 * Creates a complete ThreadState with sensible defaults.
 */
export function makeThreadState(
  overrides?: Partial<ThreadState>,
): ThreadState {
  return {
    threadTs: "1234567890.000001",
    channelId: "C-TEST",
    sessionId: null,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates a RouterResult with sensible defaults.
 */
export function makeRouterResult(
  overrides?: Partial<RouterResult>,
): RouterResult {
  return {
    quickResponse: "Hello!",
    needsAgent: false,
    reason: "greeting",
    request: {},
    rawResponse: {},
    ...overrides,
  };
}

/**
 * Creates an AgentResponse with sensible defaults.
 */
export function makeAgentResponse(
  overrides?: Partial<AgentResponse>,
): AgentResponse {
  return {
    text: "Here is the answer.",
    sessionId: "sess-test-1",
    costUsd: 0.05,
    turns: 2,
    config: {},
    log: [
      {
        timestamp: Date.now(),
        type: "system",
        subtype: "init",
        summary: "Session initialized: test-model",
        data: { session_id: "sess-test-1" },
      },
      {
        timestamp: Date.now(),
        type: "result",
        subtype: "success",
        summary: "success: 2 turns, $0.0500, 1000ms (api: 800ms)",
        data: { total_cost_usd: 0.05, num_turns: 2 },
      },
    ],
    ...overrides,
  };
}

/**
 * Creates a realistic Slack message event matching what Bolt delivers
 * to app.message(). Defaults to the configured channelId.
 */
export function makeSlackMessage(overrides?: Record<string, unknown>) {
  return {
    user: "U-HUMAN",
    text: "Hello flytebot",
    ts: "1234567890.000100",
    channel: "C-TEST",
    type: "message" as const,
    ...overrides,
  };
}

/**
 * Same as makeSlackMessage but with thread_ts set (a thread reply).
 */
export function makeSlackThreadReply(overrides?: Record<string, unknown>) {
  return makeSlackMessage({
    thread_ts: "1234567890.000001",
    ts: "1234567890.000200",
    ...overrides,
  });
}
