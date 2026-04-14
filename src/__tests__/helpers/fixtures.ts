import type {
  ThreadMessage,
  ThreadState,
  RouterResult,
  AgentResponse,
  AgentLogEntry,
  ComplexityLevel,
} from "../../types.js";

/**
 * Creates a ThreadMessage with sensible defaults.
 */
export function msg(
  text: string,
  isBot: boolean,
  user = isBot ? "danxbot" : "U123",
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
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "698fc5b8847b787a3818ad82",
      todoListId: "698fc5be16a280cc321a13ec",
      bugLabelId: "698fc5b8847b787a3818adac",
      needsHelpListId: "6990129be21ee37b649281a5",
      needsHelpLabelId: "698fc5b8847b787a3818adaa",
    },
    logLevel: "info",
    logsDir: "/test/logs",
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
    complexity: "high" as ComplexityLevel,
    reason: "greeting",
    error: null,
    request: {},
    rawResponse: {},
    usage: null,
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
    subscriptionCostUsd: 0.05,
    turns: 2,
    config: {},
    usage: null,
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
    text: "Hello danxbot",
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
