import type {
  ThreadMessage,
  ThreadState,
  RouterResult,
  AgentResponse,
  AgentLogEntry,
  ComplexityLevel,
  RepoContext,
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
 * Creates a shared config object matching the shape of src/config.ts.
 * Only shared infrastructure — no per-repo config (trello, slack, platform).
 */
export function makeConfig(overrides?: Record<string, unknown>) {
  return {
    anthropic: { apiKey: "test-key" },
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
    github: { webhookSecret: "" },
    logLevel: "info",
    logsDir: "/test/logs",
    pollerIntervalMs: 60000,
    ...overrides,
  };
}

/**
 * Creates a RepoContext with sensible test defaults.
 */
export function makeRepoContext(overrides?: Partial<RepoContext>): RepoContext {
  return {
    name: "test-repo",
    url: "https://example.com/test.git",
    localPath: "/test/repos/test-repo",
    trello: {
      apiKey: "test-trello-key",
      apiToken: "test-trello-token",
      boardId: "test-board-id",
      reviewListId: "test-review-list-id",
      todoListId: "test-todo-list-id",
      inProgressListId: "test-in-progress-list-id",
      needsHelpListId: "test-needs-help-list-id",
      doneListId: "test-done-list-id",
      cancelledListId: "test-cancelled-list-id",
      actionItemsListId: "test-action-items-list-id",
      bugLabelId: "test-bug-label-id",
      featureLabelId: "test-feature-label-id",
      epicLabelId: "test-epic-label-id",
      needsHelpLabelId: "test-needs-help-label-id",
    },
    slack: {
      enabled: true,
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelId: "C-TEST",
    },
    db: {
      host: "localhost",
      user: "test",
      password: "test",
      database: "test",
      enabled: true,
    },
    githubToken: "test-github-token",
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
