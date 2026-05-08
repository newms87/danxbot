import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPool, MockPoolCtor, mockQuery } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
  const MockPoolCtor = vi.fn().mockImplementation(() => mockPool);
  const mockQuery = vi.fn();
  return { mockPool, MockPoolCtor, mockQuery };
});

vi.mock("pg", () => ({
  Pool: MockPoolCtor,
  types: { setTypeParser: vi.fn() },
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => mockPool,
  query: mockQuery,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  hashPassword,
  verifyPassword,
  generateRawToken,
  hashToken,
  upsertDashboardUser,
  loginDashboardUser,
  validateToken,
  revokeAllTokensForUser,
} from "./auth-db.js";

beforeEach(() => {
  vi.clearAllMocks();
  // Default to empty rows for any unmocked call
  mockQuery.mockResolvedValue([]);
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("hashPassword + verifyPassword", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).not.toBe("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("rejects a wrong password against a hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

});

describe("generateRawToken + hashToken", () => {
  it("produces a URL-safe string of at least 40 chars", () => {
    const t = generateRawToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it("hashToken returns stable 64-char hex sha256", () => {
    const t = "a-known-token";
    const h1 = hashToken(t);
    const h2 = hashToken(t);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("upsertDashboardUser", () => {
  it("upserts the user and returns user id", async () => {
    // 4 calls: UPSERT, SELECT id, REVOKE, INSERT token
    mockQuery.mockResolvedValueOnce([])           // UPSERT
      .mockResolvedValueOnce([{ id: 42 }])       // SELECT id - THIS IS THE IMPORTANT ONE
      .mockResolvedValueOnce([])                  // REVOKE
      .mockResolvedValueOnce([]);                 // INSERT token

    const result = await upsertDashboardUser("alice", "a-strong-password");
    expect(result.userId).toBe(42);
    expect(result.rawToken).toBeTruthy();
  });

  it("returns userId for existing user", async () => {
    mockQuery.mockResolvedValueOnce([])           // UPSERT
      .mockResolvedValueOnce([{ id: 99 }])       // SELECT id
      .mockResolvedValueOnce([])                  // REVOKE
      .mockResolvedValueOnce([]);                 // INSERT token

    const result = await upsertDashboardUser("alice", "new-password");
    expect(result.userId).toBe(99);
  });

  it("throws when SELECT returns no row", async () => {
    mockQuery.mockResolvedValueOnce([])           // UPSERT
      .mockResolvedValueOnce([]);                 // SELECT id returns empty

    await expect(
      upsertDashboardUser("alice", "a-strong-password"),
    ).rejects.toThrow(/no id returned/);
  });
});

describe("loginDashboardUser", () => {
  it("returns null when no user matches the username", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await loginDashboardUser("ghost", "pw");
    expect(result).toBeNull();
    // No token rotation attempted
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("returns null when password does not match the stored hash", async () => {
    const wrongPwHash = await hashPassword("the-actual-password");
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, password_hash: wrongPwHash }], rowCount: 0 });

    const result = await loginDashboardUser("alice", "guess-password");
    expect(result).toBeNull();
    // No token rotation attempted on bad password
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("on success: revokes prior tokens, issues fresh token, returns {userId, rawToken}", async () => {
    const pwHash = await hashPassword("the-actual-password");
    // 3 calls: SELECT for password lookup, REVOKE, INSERT token
    mockQuery.mockResolvedValueOnce([{ id: 42, password_hash: pwHash }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await loginDashboardUser("alice", "the-actual-password");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(42);
    expect(result!.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("returns null when the user has no password_hash (slack-only user)", async () => {
    // A user created via Slack flow has only slack_user_id populated.
    // They must not be able to log in to the dashboard.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 42, password_hash: null }], rowCount: 0 });

    const result = await loginDashboardUser("alice", "any-password");
    expect(result).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});

describe("validateToken", () => {
  it("returns null when token is empty / malformed (skips DB entirely)", async () => {
    const r = await validateToken("");
    expect(r).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns null when the DB lookup finds nothing", async () => {
    mockQuery.mockResolvedValueOnce([]);
    const r = await validateToken("some-token");
    expect(r).toBeNull();
    // No last_used_at update on miss
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  it("returns {userId, username} and updates last_used_at on hit", async () => {
    // 2 calls: SELECT, UPDATE last_used_at
    mockQuery.mockResolvedValueOnce([{ user_id: 42, username: "alice" }])
      .mockResolvedValueOnce([]);

    const r = await validateToken("valid-raw-token");
    expect(r).toEqual({ userId: 42, username: "alice" });
  });

  it("returns null for a revoked token AND does not touch last_used_at", async () => {
    // Revoked rows are filtered by `revoked_at IS NULL` in the SELECT, so the
    // DB returns empty. This is the security-critical gate — last_used_at must
    // NOT be updated (that would signal the token still exists).
    mockQuery.mockResolvedValueOnce([]);

    const r = await validateToken("revoked-raw-token");
    expect(r).toBeNull();
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});

describe("revokeAllTokensForUser", () => {
  it("revokes all non-revoked tokens for the user", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await revokeAllTokensForUser(42);

    expect(mockPool.query).toHaveBeenCalledOnce();
    const sql = mockPool.query.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE api_tokens");
    expect(sql).toContain("revoked_at = NOW()");
    expect(sql).toContain("WHERE user_id = $1");
    expect(sql).toContain("revoked_at IS NULL");
    expect(mockPool.query.mock.calls[0][1]).toEqual([42]);
  });

  it("returns cleanly when the user has no active tokens", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(revokeAllTokensForUser(42)).resolves.toBeUndefined();
  });
});
