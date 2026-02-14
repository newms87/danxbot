/**
 * Creates an async generator from an array of items.
 * Used to mock the Claude Agent SDK's query() return value.
 */
export async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * Creates an Anthropic Messages API response (used by the router).
 * Returns the shape that `client.messages.create()` resolves to.
 */
export function makeRouterApiResponse(overrides?: {
  quickResponse?: string;
  needsAgent?: boolean;
  reason?: string;
}) {
  const json = {
    quickResponse: overrides?.quickResponse ?? "Hello!",
    needsAgent: overrides?.needsAgent ?? false,
    reason: overrides?.reason ?? "greeting",
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(json),
      },
    ],
  };
}

/**
 * Creates an array of SDK query events representing a complete successful
 * agent run. Returns an array ready for asyncIter().
 */
export function makeAgentStream(overrides?: {
  sessionId?: string;
  result?: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  durationApiMs?: number;
  toolUseMessages?: Array<{
    type: string;
    message?: { content: Array<Record<string, unknown>> };
  }>;
}) {
  const sessionId = overrides?.sessionId ?? "sess-test-1";
  const events: Record<string, unknown>[] = [
    { type: "system", subtype: "init", session_id: sessionId },
  ];

  if (overrides?.toolUseMessages) {
    events.push(...overrides.toolUseMessages);
  }

  events.push({
    type: "result",
    subtype: "success",
    result: overrides?.result ?? "Here is the answer.",
    total_cost_usd: overrides?.costUsd ?? 0.05,
    num_turns: overrides?.turns ?? 2,
    duration_ms: overrides?.durationMs ?? 1000,
    duration_api_ms: overrides?.durationApiMs ?? 800,
  });

  return events;
}

/**
 * Creates an array of SDK query events representing a failed agent run.
 * The stream ends with result/error containing the provided errors.
 */
export function makeAgentErrorStream(
  errors: string[],
  overrides?: {
    sessionId?: string;
    costUsd?: number;
    turns?: number;
  },
) {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: overrides?.sessionId ?? "sess-err-1",
    },
    {
      type: "result",
      subtype: "error",
      result: "",
      total_cost_usd: overrides?.costUsd ?? 0.01,
      num_turns: overrides?.turns ?? 1,
      errors,
      duration_ms: 100,
      duration_api_ms: 80,
    },
  ];
}
