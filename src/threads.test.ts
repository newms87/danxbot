import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadState, ThreadMessage } from "./types.js";

const mockLoadThreadFromDb = vi.fn();
const mockSaveThreadToDb = vi.fn();
const mockDeleteOldThreadsFromDb = vi.fn();
const mockIsBotInThread = vi.fn();

vi.mock("./db/threads-db.js", () => ({
  loadThreadFromDb: (...args: unknown[]) => mockLoadThreadFromDb(...args),
  saveThreadToDb: (...args: unknown[]) => mockSaveThreadToDb(...args),
  deleteOldThreadsFromDb: (...args: unknown[]) => mockDeleteOldThreadsFromDb(...args),
  isBotInThread: (...args: unknown[]) => mockIsBotInThread(...args),
}));

vi.mock("./logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  getOrCreateThread,
  addMessageToThread,
  updateSessionId,
  clearSessionId,
  cleanupOldThreads,
  isBotParticipant,
  startThreadCleanup,
  stopThreadCleanup,
  trimThreadMessages,
} = await import("./threads.js");

function makeThread(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadTs: "1234.5678",
    channelId: "C123",
    sessionId: null,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveThreadToDb.mockResolvedValue(undefined);
  mockDeleteOldThreadsFromDb.mockResolvedValue(0);
});

describe("getOrCreateThread", () => {
  it("returns existing thread from DB when found", async () => {
    const existing = makeThread({
      messages: [{ user: "U1", text: "hi", ts: "1", isBot: false }],
    });
    mockLoadThreadFromDb.mockResolvedValueOnce(existing);

    const mockClient = {} as any;
    const result = await getOrCreateThread("1234.5678", "C123", mockClient);

    expect(result.threadTs).toBe("1234.5678");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("hi");
    expect(mockLoadThreadFromDb).toHaveBeenCalledWith("1234.5678");
  });

  it("hydrates from Slack and saves to DB when not in DB", async () => {
    mockLoadThreadFromDb.mockResolvedValueOnce(null);

    const mockClient = {
      conversations: {
        replies: vi.fn().mockResolvedValue({
          messages: [
            { user: "U1", text: "hello", ts: "1" },
            { bot_id: "B1", text: "hi back", ts: "2" },
          ],
        }),
      },
    } as any;

    const result = await getOrCreateThread("1234.5678", "C123", mockClient);

    expect(mockClient.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1234.5678",
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].isBot).toBe(false);
    expect(result.messages[1].isBot).toBe(true);
    expect(mockSaveThreadToDb).toHaveBeenCalled();
  });

  it("returns empty thread when Slack API errors", async () => {
    mockLoadThreadFromDb.mockResolvedValueOnce(null);

    const mockClient = {
      conversations: {
        replies: vi.fn().mockRejectedValue(new Error("Slack API error")),
      },
    } as any;

    const result = await getOrCreateThread("1234.5678", "C123", mockClient);

    expect(result.messages).toHaveLength(0);
    expect(result.threadTs).toBe("1234.5678");
  });
});

describe("addMessageToThread", () => {
  it("pushes message to the thread messages array", () => {
    const thread = makeThread();
    addMessageToThread(thread, {
      user: "U1",
      text: "new message",
      ts: "999",
      isBot: false,
    });

    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].text).toBe("new message");
  });

  it("triggers a save to DB (fire-and-forget)", async () => {
    const thread = makeThread();
    addMessageToThread(thread, {
      user: "U1",
      text: "test",
      ts: "999",
      isBot: false,
    });

    await vi.waitFor(() => {
      expect(mockSaveThreadToDb).toHaveBeenCalled();
    });
  });
});

describe("isBotParticipant", () => {
  it("delegates to isBotInThread from DB module", async () => {
    mockIsBotInThread.mockResolvedValueOnce(true);

    const result = await isBotParticipant("1234.5678");

    expect(result).toBe(true);
    expect(mockIsBotInThread).toHaveBeenCalledWith("1234.5678");
  });

  it("returns false when thread not found (null from DB)", async () => {
    mockIsBotInThread.mockResolvedValueOnce(null);

    const result = await isBotParticipant("nonexistent");

    expect(result).toBe(false);
  });

  it("returns false when thread has no bot messages", async () => {
    mockIsBotInThread.mockResolvedValueOnce(false);

    const result = await isBotParticipant("1234.5678");

    expect(result).toBe(false);
  });
});

describe("updateSessionId", () => {
  it("sets sessionId on thread and triggers DB save", async () => {
    const thread = makeThread();
    expect(thread.sessionId).toBeNull();

    updateSessionId(thread, "sess-abc");

    expect(thread.sessionId).toBe("sess-abc");
    await vi.waitFor(() => {
      expect(mockSaveThreadToDb).toHaveBeenCalled();
    });
  });
});

describe("clearSessionId", () => {
  it("sets sessionId to null and triggers DB save", async () => {
    const thread = makeThread({ sessionId: "sess-abc" });

    clearSessionId(thread);

    expect(thread.sessionId).toBeNull();
    await vi.waitFor(() => {
      expect(mockSaveThreadToDb).toHaveBeenCalled();
    });
  });
});

describe("cleanupOldThreads", () => {
  it("delegates to deleteOldThreadsFromDb", async () => {
    mockDeleteOldThreadsFromDb.mockResolvedValueOnce(3);

    await cleanupOldThreads();

    expect(mockDeleteOldThreadsFromDb).toHaveBeenCalledWith(
      7 * 24 * 60 * 60 * 1000,
    );
  });
});

describe("startThreadCleanup", () => {
  it("returns an interval reference", () => {
    const interval = startThreadCleanup();
    expect(interval).toBeDefined();
    clearInterval(interval);
  });

  it("runs cleanup immediately on startup", async () => {
    vi.useFakeTimers();

    const interval = startThreadCleanup();

    await vi.waitFor(() => {
      expect(mockDeleteOldThreadsFromDb).toHaveBeenCalled();
    });

    clearInterval(interval);
    vi.useRealTimers();
  });
});

describe("stopThreadCleanup", () => {
  it("clears the interval", () => {
    vi.useFakeTimers();
    const interval = startThreadCleanup();

    stopThreadCleanup(interval);

    vi.clearAllMocks();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockDeleteOldThreadsFromDb).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("trimThreadMessages", () => {
  function makeMessages(count: number): ThreadMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      user: `U${i}`,
      text: `message ${i}`,
      ts: String(i),
      isBot: i % 2 === 1,
    }));
  }

  it("returns all messages when under the limit", () => {
    const messages = makeMessages(5);
    const result = trimThreadMessages(messages, 20);
    expect(result).toHaveLength(5);
    expect(result).toEqual(messages);
  });

  it("returns all messages when exactly at the limit", () => {
    const messages = makeMessages(20);
    const result = trimThreadMessages(messages, 20);
    expect(result).toHaveLength(20);
    expect(result).toEqual(messages);
  });

  it("trims to limit, preserving first message and last N-1 messages", () => {
    const messages = makeMessages(25);
    const result = trimThreadMessages(messages, 20);

    expect(result).toHaveLength(20);
    expect(result[0]).toEqual(messages[0]);
    expect(result.slice(1)).toEqual(messages.slice(-19));
  });

  it("preserves the first message (original question) when trimming", () => {
    const messages = makeMessages(30);
    messages[0].text = "original question";
    const result = trimThreadMessages(messages, 10);

    expect(result[0].text).toBe("original question");
    expect(result).toHaveLength(10);
  });

  it("returns empty array when given empty array", () => {
    const result = trimThreadMessages([], 20);
    expect(result).toEqual([]);
  });

  it("returns only first message when limit is 1", () => {
    const messages = makeMessages(10);
    const result = trimThreadMessages(messages, 1);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(messages[0]);
  });
});
