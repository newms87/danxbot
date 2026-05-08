import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockQuery, mockGetPool } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockGetPool = vi.fn(() => ({
    query: mockQuery,
  }));
  return { mockQuery, mockGetPool };
});

vi.mock("./connection.js", () => ({
  getPool: mockGetPool,
  query: mockQuery,
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
    mockQuery.mockResolvedValue([]);
  });

  describe("loadThreadFromDb", () => {
    it("returns parsed ThreadState when row exists", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockQuery.mockResolvedValueOnce([
        {
          thread_ts: "1234.5678",
          channel_id: "C123",
          session_id: "sess-1",
          messages,  // DB returns JSONB as parsed object
          created_at: new Date("2026-01-01"),
          updated_at: new Date("2026-01-02"),
        },
      ]);

      const result = await loadThreadFromDb("1234.5678");

      expect(result).not.toBeNull();
      expect(result!.threadTs).toBe("1234.5678");
      expect(result!.channelId).toBe("C123");
      expect(result!.sessionId).toBe("sess-1");
      expect(result!.messages).toEqual(messages);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT"),
        ["1234.5678"],
      );
    });

    it("returns null when no row exists", async () => {
      mockQuery.mockResolvedValueOnce([]);

      const result = await loadThreadFromDb("nonexistent");

      expect(result).toBeNull();
    });

    it("throws when DB fails", async () => {
      mockQuery.mockRejectedValueOnce(new Error("connection refused"));

      await expect(loadThreadFromDb("1234.5678")).rejects.toThrow("connection refused");
    });

    it("handles messages stored as array", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockQuery.mockResolvedValueOnce([
        {
          thread_ts: "1234.5678",
          channel_id: "C123",
          session_id: null,
          messages,
          created_at: new Date("2026-01-01"),
          updated_at: new Date("2026-01-02"),
        },
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

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("INSERT INTO threads");
      expect(sql).toContain("ON CONFLICT");
      expect(params).toContain("1234.5678");
      expect(params).toContain("C123");
      expect(params).toContain("sess-abc");
    });

    it("JSON-stringifies the messages array", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      const thread = makeThread({ messages });

      await saveThreadToDb(thread);

      const [, params] = mockQuery.mock.calls[0];
      expect(params).toContain(JSON.stringify(messages));
    });

    it("throws when DB fails", async () => {
      mockQuery.mockRejectedValueOnce(new Error("connection refused"));

      await expect(saveThreadToDb(makeThread())).rejects.toThrow("connection refused");
    });
  });

  describe("deleteOldThreadsFromDb", () => {
    it("returns affected row count from pool.query", async () => {
      // deleteOldThreadsFromDb calls getPool().query directly, not the query() wrapper
      const mockPoolQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 5 });
      mockGetPool.mockReturnValueOnce({ query: mockPoolQuery });

      const result = await deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000);

      expect(result).toBe(5);
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE"),
        expect.any(Array),
      );
    });

    it("returns 0 when no rows are deleted", async () => {
      const mockPoolQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockGetPool.mockReturnValueOnce({ query: mockPoolQuery });

      const result = await deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000);

      expect(result).toBe(0);
    });

    it("throws when DB fails", async () => {
      const mockPoolQuery = vi.fn().mockRejectedValueOnce(new Error("connection refused"));
      mockGetPool.mockReturnValueOnce({ query: mockPoolQuery });

      await expect(deleteOldThreadsFromDb(7 * 24 * 60 * 60 * 1000)).rejects.toThrow("connection refused");
    });
  });

  describe("isBotInThread", () => {
    it("returns true when thread has bot messages", async () => {
      const messages = [
        { user: "U1", text: "hi", ts: "1", isBot: false },
        { user: "B1", text: "hello", ts: "2", isBot: true },
      ];
      mockQuery.mockResolvedValueOnce([
        {
          thread_ts: "1234.5678",
          channel_id: "C123",
          session_id: null,
          messages,  // DB returns JSONB as parsed object
          created_at: new Date("2026-01-01"),
          updated_at: new Date("2026-01-02"),
        },
      ]);

      const result = await isBotInThread("1234.5678");

      expect(result).toBe(true);
    });

    it("returns false when thread has no bot messages", async () => {
      const messages = [{ user: "U1", text: "hi", ts: "1", isBot: false }];
      mockQuery.mockResolvedValueOnce([
        {
          thread_ts: "1234.5678",
          channel_id: "C123",
          session_id: null,
          messages,  // DB returns JSONB as parsed object
          created_at: new Date("2026-01-01"),
          updated_at: new Date("2026-01-02"),
        },
      ]);

      const result = await isBotInThread("1234.5678");

      expect(result).toBe(false);
    });

    it("returns null when thread not found", async () => {
      mockQuery.mockResolvedValueOnce([]);

      const result = await isBotInThread("nonexistent");

      expect(result).toBeNull();
    });
  });
});
