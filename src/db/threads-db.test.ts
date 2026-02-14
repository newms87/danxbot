import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();
const mockGetPool = vi.fn(() => ({
  query: mockQuery,
  execute: mockExecute,
}));

vi.mock("./connection.js", () => ({
  getPool: () => mockGetPool(),
}));

const mockLogError = vi.fn();
const mockLogInfo = vi.fn();
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

import {
  loadThreadFromDb,
  saveThreadToDb,
  deleteOldThreadsFromDb,
  isBotInThread,
} from "./threads-db.js";
import type { ThreadState } from "../types.js";

function makeThread(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadTs: "1234.5678",
    channelId: "C123",
    sessionId: null,
    messages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("threads-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([[], []]);
    mockQuery.mockResolvedValue([[], []]);
  });

  describe("loadThreadFromDb", () => {
    it("returns parsed ThreadState when row exists", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockExecute.mockResolvedValueOnce([
        [
          {
            thread_ts: "1234.5678",
            channel_id: "C123",
            session_id: "sess-1",
            messages: JSON.stringify(messages),
            created_at: new Date("2026-01-01"),
            updated_at: new Date("2026-01-02"),
          },
        ],
        [],
      ]);

      const result = await loadThreadFromDb("1234.5678");

      expect(result).not.toBeNull();
      expect(result!.threadTs).toBe("1234.5678");
      expect(result!.channelId).toBe("C123");
      expect(result!.sessionId).toBe("sess-1");
      expect(result!.messages).toEqual(messages);
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("SELECT"),
        ["1234.5678"],
      );
    });

    it("returns null when no row exists", async () => {
      mockExecute.mockResolvedValueOnce([[], []]);

      const result = await loadThreadFromDb("nonexistent");

      expect(result).toBeNull();
    });

    it("returns null and logs error when DB fails", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection refused"));

      const result = await loadThreadFromDb("1234.5678");

      expect(result).toBeNull();
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("load thread"),
        expect.any(Error),
      );
    });

    it("handles messages stored as already-parsed object", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockExecute.mockResolvedValueOnce([
        [
          {
            thread_ts: "1234.5678",
            channel_id: "C123",
            session_id: null,
            messages,
            created_at: new Date("2026-01-01"),
            updated_at: new Date("2026-01-02"),
          },
        ],
        [],
      ]);

      const result = await loadThreadFromDb("1234.5678");

      expect(result).not.toBeNull();
      expect(result!.messages).toEqual(messages);
    });
  });

  describe("saveThreadToDb", () => {
    it("executes upsert with correct SQL and parameters", async () => {
      const thread = makeThread({
        sessionId: "sess-abc",
        messages: [{ user: "U1", text: "hello", ts: "1", isBot: false }],
      });

      await saveThreadToDb(thread);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("INSERT INTO threads");
      expect(sql).toContain("ON DUPLICATE KEY UPDATE");
      expect(params).toContain("1234.5678");
      expect(params).toContain("C123");
      expect(params).toContain("sess-abc");
    });

    it("JSON-stringifies the messages array", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      const thread = makeThread({ messages });

      await saveThreadToDb(thread);

      const [, params] = mockExecute.mock.calls[0];
      expect(params).toContain(JSON.stringify(messages));
    });

    it("logs error but does not throw when DB fails", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection refused"));

      await saveThreadToDb(makeThread());

      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("save thread"),
        expect.any(Error),
      );
    });
  });

  describe("deleteOldThreadsFromDb", () => {
    it("returns affected row count", async () => {
      mockExecute.mockResolvedValueOnce([{ affectedRows: 5 }, []]);

      const result = await deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000);

      expect(result).toBe(5);
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining("DELETE"),
        expect.any(Array),
      );
    });

    it("returns 0 when no rows are deleted", async () => {
      mockExecute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);

      const result = await deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000);

      expect(result).toBe(0);
    });

    it("returns 0 and logs error when DB fails", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection refused"));

      const result = await deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000);

      expect(result).toBe(0);
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining("delete old threads"),
        expect.any(Error),
      );
    });
  });

  describe("isBotInThread", () => {
    it("returns true when thread has bot messages", async () => {
      const messages = [
        { user: "U1", text: "hi", ts: "1", isBot: false },
        { user: "B1", text: "hello", ts: "2", isBot: true },
      ];
      mockExecute.mockResolvedValueOnce([
        [
          {
            thread_ts: "1234.5678",
            channel_id: "C123",
            session_id: null,
            messages: JSON.stringify(messages),
            created_at: new Date("2026-01-01"),
            updated_at: new Date("2026-01-02"),
          },
        ],
        [],
      ]);

      const result = await isBotInThread("1234.5678");

      expect(result).toBe(true);
    });

    it("returns false when thread has no bot messages", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockExecute.mockResolvedValueOnce([
        [
          {
            thread_ts: "1234.5678",
            channel_id: "C123",
            session_id: null,
            messages: JSON.stringify(messages),
            created_at: new Date("2026-01-01"),
            updated_at: new Date("2026-01-02"),
          },
        ],
        [],
      ]);

      const result = await isBotInThread("1234.5678");

      expect(result).toBe(false);
    });

    it("returns null when thread not found", async () => {
      mockExecute.mockResolvedValueOnce([[], []]);

      const result = await isBotInThread("nonexistent");

      expect(result).toBeNull();
    });
  });
});
