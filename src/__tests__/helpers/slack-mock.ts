import { vi } from "vitest";

/**
 * Creates a mock WebClient matching the subset of @slack/web-api
 * used by listener.ts and helpers.ts.
 */
export function createMockWebClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "mock-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
  };
}

/**
 * Creates a mock App class that captures the message handler
 * registered via app.message(handler).
 *
 * After calling startSlackListener(), retrieve the handler:
 *   const handler = mockApp.message.mock.calls[0][0]
 */
export function createMockApp() {
  return {
    message: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  };
}
