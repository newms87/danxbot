import { describe, it, expect, beforeEach, vi } from "vitest";

const mockQuery = vi.fn();
const mockExecute = vi.fn();

vi.mock("../db/connection.js", () => ({
  getPool: () => ({
    query: mockQuery,
    execute: mockExecute,
  }),
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
  mockQuery.mockResolvedValue([[], []]);
  mockExecute.mockResolvedValue([{ affectedRows: 1, insertId: 1 }, []]);
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
  it("upserts the user by username, revokes old tokens, inserts a fresh token", async () => {
    // 1st execute: UPSERT user. 2nd query: SELECT id. 3rd execute: revoke.
    // 4th execute: INSERT api_token.
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 42 }, []]);
    mockQuery.mockResolvedValueOnce([[{ id: 42 }], []]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 7 }, []]);

    const result = await upsertDashboardUser("alice", "a-strong-password");

    expect(result.userId).toBe(42);
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // UPSERT SQL
    const upsertSql = mockExecute.mock.calls[0][0] as string;
    expect(upsertSql).toContain("INSERT INTO users");
    expect(upsertSql).toContain("ON DUPLICATE KEY UPDATE password_hash");
    const upsertParams = mockExecute.mock.calls[0][1] as unknown[];
    expect(upsertParams[0]).toBe("alice");
    // Second param is bcrypt hash (not plain password)
    expect(upsertParams[1]).not.toBe("a-strong-password");

    // Revoke SQL
    const revokeSql = mockExecute.mock.calls[1][0] as string;
    expect(revokeSql).toContain("UPDATE api_tokens");
    expect(revokeSql).toContain("revoked_at = NOW()");
    expect(revokeSql).toContain("WHERE user_id = ?");
    expect(mockExecute.mock.calls[1][1]).toEqual([42]);

    // Insert token SQL
    const insertTokenSql = mockExecute.mock.calls[2][0] as string;
    expect(insertTokenSql).toContain("INSERT INTO api_tokens");
    expect(insertTokenSql).toContain("user_id");
    expect(insertTokenSql).toContain("token_hash");
    const tokenParams = mockExecute.mock.calls[2][1] as unknown[];
    expect(tokenParams[0]).toBe(42);
    // Stored value is the SHA-256 hash, NEVER the raw token
    expect(tokenParams[1]).not.toBe(result.rawToken);
    expect(tokenParams[1]).toBe(hashToken(result.rawToken));
  });

  it("rotates tokens on the ON DUPLICATE KEY path for an existing username", async () => {
    // UPSERT resolves against existing id=99 (ON DUPLICATE KEY UPDATE).
    mockExecute.mockResolvedValueOnce([{ affectedRows: 2, insertId: 99 }, []]);
    mockQuery.mockResolvedValueOnce([[{ id: 99 }], []]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 3 }, []]); // 3 old tokens revoked
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 8 }, []]);

    const result = await upsertDashboardUser("alice", "new-password");

    expect(result.userId).toBe(99);
    // Revoke ran before the fresh INSERT
    expect(mockExecute.mock.calls[1][0]).toContain("UPDATE api_tokens");
    expect(mockExecute.mock.calls[1][0]).toContain("revoked_at = NOW()");
    expect(mockExecute.mock.calls[2][0]).toContain("INSERT INTO api_tokens");
  });

  it("throws when the post-INSERT lookup returns no row", async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }, []]);
    mockQuery.mockResolvedValueOnce([[], []]);

    await expect(
      upsertDashboardUser("alice", "a-strong-password"),
    ).rejects.toThrow(/no id returned/);
  });
});

describe("loginDashboardUser", () => {
  it("returns null when no user matches the username", async () => {
    mockQuery.mockResolvedValueOnce([[], []]);
    const result = await loginDashboardUser("ghost", "pw");
    expect(result).toBeNull();
    // No token rotation attempted
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns null when password does not match the stored hash", async () => {
    const wrongPwHash = await hashPassword("the-actual-password");
    mockQuery.mockResolvedValueOnce([
      [{ id: 42, password_hash: wrongPwHash }],
      [],
    ]);

    const result = await loginDashboardUser("alice", "guess-password");
    expect(result).toBeNull();
    // No token rotation attempted on bad password
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("on success: revokes prior tokens, issues fresh token, returns {userId, rawToken}", async () => {
    const pwHash = await hashPassword("the-actual-password");
    mockQuery.mockResolvedValueOnce([
      [{ id: 42, password_hash: pwHash }],
      [],
    ]);
    // revoke + insert token
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 99 }, []]);

    const result = await loginDashboardUser("alice", "the-actual-password");
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(42);
    expect(result!.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // Revoke then insert, in order
    expect(mockExecute.mock.calls[0][0]).toContain("UPDATE api_tokens");
    expect(mockExecute.mock.calls[0][0]).toContain("revoked_at = NOW()");
    expect(mockExecute.mock.calls[1][0]).toContain("INSERT INTO api_tokens");
  });

  it("returns null when the user has no password_hash (slack-only user)", async () => {
    // A user created via Slack flow has only slack_user_id populated.
    // They must not be able to log in to the dashboard.
    mockQuery.mockResolvedValueOnce([
      [{ id: 42, password_hash: null }],
      [],
    ]);

    const result = await loginDashboardUser("alice", "any-password");
    expect(result).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("validateToken", () => {
  it("returns null when token is empty / malformed (skips DB entirely)", async () => {
    const r = await validateToken("");
    expect(r).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns null when the DB lookup finds nothing", async () => {
    mockQuery.mockResolvedValueOnce([[], []]);
    const r = await validateToken("some-token");
    expect(r).toBeNull();
    // No last_used_at update on miss
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns {userId, username} and updates last_used_at on hit", async () => {
    mockQuery.mockResolvedValueOnce([
      [{ user_id: 42, username: "alice" }],
      [],
    ]);
    mockExecute.mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    const r = await validateToken("valid-raw-token");
    expect(r).toEqual({ userId: 42, username: "alice" });

    // Looks up by HASH, not raw token
    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toContain("api_tokens");
    expect(selectSql).toContain("token_hash = ?");
    expect(selectSql).toContain("revoked_at IS NULL");
    expect(selectSql).toContain("JOIN users");
    const selectParams = mockQuery.mock.calls[0][1] as unknown[];
    expect(selectParams[0]).toBe(hashToken("valid-raw-token"));

    // last_used_at touch
    const updateSql = mockExecute.mock.calls[0][0] as string;
    expect(updateSql).toContain("UPDATE api_tokens");
    expect(updateSql).toContain("last_used_at = NOW()");
  });

  it("returns null for a revoked token AND does not touch last_used_at", async () => {
    // Revoked rows are filtered by `revoked_at IS NULL` in the SELECT, so the
    // DB returns empty. This is the security-critical gate — last_used_at must
    // NOT be updated (that would signal the token still exists).
    mockQuery.mockResolvedValueOnce([[], []]);

    const r = await validateToken("revoked-raw-token");
    expect(r).toBeNull();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("revokeAllTokensForUser", () => {
  it("revokes all non-revoked tokens for the user", async () => {
    await revokeAllTokensForUser(42);

    expect(mockExecute).toHaveBeenCalledOnce();
    const sql = mockExecute.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE api_tokens");
    expect(sql).toContain("revoked_at = NOW()");
    expect(sql).toContain("WHERE user_id = ?");
    expect(sql).toContain("revoked_at IS NULL");
    expect(mockExecute.mock.calls[0][1]).toEqual([42]);
  });

  it("returns cleanly when the user has no active tokens", async () => {
    mockExecute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    await expect(revokeAllTokensForUser(42)).resolves.toBeUndefined();
  });
});
