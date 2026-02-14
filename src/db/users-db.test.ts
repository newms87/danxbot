import { describe, it, expect, beforeEach, vi } from "vitest";

const mockExecute = vi.fn();
const mockGetPool = vi.fn(() => ({
  execute: mockExecute,
}));

vi.mock("./connection.js", () => ({
  getPool: () => mockGetPool(),
}));

const mockLogError = vi.fn();
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}));

import { upsertUser, getUser } from "./users-db.js";

describe("users-db", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([[], []]);
  });

  describe("upsertUser", () => {
    it("executes INSERT ... ON DUPLICATE KEY UPDATE with correct params", async () => {
      await upsertUser("U123", "Alice");

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("INSERT INTO users");
      expect(sql).toContain("ON DUPLICATE KEY UPDATE");
      expect(params).toContain("U123");
      expect(params).toContain("Alice");
    });

    it("throws when DB fails", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection refused"));

      await expect(upsertUser("U123", "Alice")).rejects.toThrow("connection refused");
    });
  });

  describe("getUser", () => {
    it("returns user when row exists", async () => {
      mockExecute.mockResolvedValueOnce([
        [
          {
            slack_user_id: "U123",
            display_name: "Alice",
            preferences: null,
          },
        ],
        [],
      ]);

      const result = await getUser("U123");

      expect(result).not.toBeNull();
      expect(result!.slackUserId).toBe("U123");
      expect(result!.displayName).toBe("Alice");
      expect(result!.preferences).toBeNull();
    });

    it("parses JSON preferences when present", async () => {
      const prefs = { theme: "dark" };
      mockExecute.mockResolvedValueOnce([
        [
          {
            slack_user_id: "U123",
            display_name: "Alice",
            preferences: JSON.stringify(prefs),
          },
        ],
        [],
      ]);

      const result = await getUser("U123");

      expect(result!.preferences).toEqual(prefs);
    });

    it("handles preferences already parsed as object", async () => {
      const prefs = { theme: "dark" };
      mockExecute.mockResolvedValueOnce([
        [
          {
            slack_user_id: "U123",
            display_name: "Alice",
            preferences: prefs,
          },
        ],
        [],
      ]);

      const result = await getUser("U123");

      expect(result!.preferences).toEqual(prefs);
    });

    it("returns null when no row exists", async () => {
      mockExecute.mockResolvedValueOnce([[], []]);

      const result = await getUser("nonexistent");

      expect(result).toBeNull();
    });

    it("throws when DB fails", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection refused"));

      await expect(getUser("U123")).rejects.toThrow("connection refused");
    });
  });
});
