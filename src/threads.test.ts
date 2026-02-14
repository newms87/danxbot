import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadState, ThreadMessage } from "./types.js";

// Mock fs/promises before importing the module under test
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./config.js", () => ({
  config: { threadsDir: "/test/threads" },
}));

const fs = await import("fs/promises");
const {
  getOrCreateThread,
  addMessageToThread,
  updateSessionId,
  cleanupOldThreads,
  isBotParticipant,
  startThreadCleanup,
  stopThreadCleanup,
  trimThreadMessages,
} = await import("./threads.js");

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockReaddir = vi.mocked(fs.readdir);
const mockUnlink = vi.mocked(fs.unlink);

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
});

describe("getOrCreateThread", () => {
  it("returns existing thread from disk when file exists", async () => {
    const existing = makeThread({ messages: [{ user: "U1", text: "hi", ts: "1", isBot: false }] });
    mockReadFile.mockResolvedValueOnce(JSON.stringify(existing));

    const mockClient = {} as any;
    const result = await getOrCreateThread("1234.5678", "C123", mockClient);

    expect(result.threadTs).toBe("1234.5678");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe("hi");
  });

  it("hydrates from Slack when file is missing, saves to disk", async () => {
    // File doesn't exist
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

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
    // Verify it was saved to disk
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("returns empty thread when Slack API errors", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

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

  it("triggers a save to disk (fire-and-forget)", async () => {
    const thread = makeThread();
    addMessageToThread(thread, {
      user: "U1",
      text: "test",
      ts: "999",
      isBot: false,
    });

    // saveThread is fire-and-forget — flush the microtask queue
    await vi.waitFor(() => {
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe("isBotParticipant", () => {
  it("returns true when thread has bot messages", async () => {
    const thread = makeThread({
      messages: [
        { user: "U1", text: "hi", ts: "1", isBot: false },
        { user: "flytebot", text: "hello", ts: "2", isBot: true },
      ],
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify(thread));

    expect(await isBotParticipant("1234.5678")).toBe(true);
  });

  it("returns false when thread has no bot messages", async () => {
    const thread = makeThread({
      messages: [{ user: "U1", text: "hi", ts: "1", isBot: false }],
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify(thread));

    expect(await isBotParticipant("1234.5678")).toBe(false);
  });

  it("returns false when thread file does not exist", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    expect(await isBotParticipant("nonexistent")).toBe(false);
  });
});

describe("updateSessionId", () => {
  it("sets sessionId on thread and triggers disk save", async () => {
    const thread = makeThread();
    expect(thread.sessionId).toBeNull();

    updateSessionId(thread, "sess-abc");

    expect(thread.sessionId).toBe("sess-abc");
    await vi.waitFor(() => {
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });
});

describe("cleanupOldThreads", () => {
  it("deletes threads older than 7 days", async () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const oldThread = makeThread({ updatedAt: oldDate });

    mockReaddir.mockResolvedValueOnce(["old.json"] as any);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(oldThread));

    await cleanupOldThreads();

    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it("keeps threads newer than 7 days", async () => {
    const recentThread = makeThread({ updatedAt: new Date().toISOString() });

    mockReaddir.mockResolvedValueOnce(["recent.json"] as any);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(recentThread));

    await cleanupOldThreads();

    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("skips non-JSON files", async () => {
    mockReaddir.mockResolvedValueOnce(["readme.txt", "notes.md"] as any);

    await cleanupOldThreads();

    // Should not attempt to read non-JSON files
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

describe("startThreadCleanup", () => {
  it("returns an interval reference", () => {
    const interval = startThreadCleanup();
    expect(interval).toBeDefined();
    // Clean up
    clearInterval(interval);
  });

  it("runs cleanup immediately on startup", async () => {
    vi.useFakeTimers();
    mockReaddir.mockResolvedValue([]);

    const interval = startThreadCleanup();

    // Should trigger cleanup immediately
    await vi.waitFor(() => {
      expect(mockReaddir).toHaveBeenCalled();
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

    // Fast-forward time - cleanup should not run again
    vi.clearAllMocks();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockReaddir).not.toHaveBeenCalled();

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
    // First message is the original first message
    expect(result[0]).toEqual(messages[0]);
    // Last 19 messages are from the end of the original array
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
