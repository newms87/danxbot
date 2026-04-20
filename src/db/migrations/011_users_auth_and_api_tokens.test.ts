import { describe, it, expect, vi, beforeEach } from "vitest";
import { up, down } from "./011_users_auth_and_api_tokens.js";

const mockQuery = vi.fn();

const mockPool = {
  query: mockQuery,
};

describe("011_users_auth_and_api_tokens migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([[], []]);
  });

  it("extends users with id PK, username, password_hash and relaxes slack_user_id to NULL UNIQUE", async () => {
    await up(mockPool as never);

    const alterCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("ALTER TABLE users"),
    );
    expect(alterCall).toBeDefined();

    const sql = alterCall![0] as string;
    expect(sql).toContain("DROP PRIMARY KEY");
    expect(sql).toContain("ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST");
    expect(sql).toContain("MODIFY slack_user_id VARCHAR(50) NULL");
    expect(sql).toContain("ADD UNIQUE KEY uq_users_slack_user_id (slack_user_id)");
    expect(sql).toContain("ADD COLUMN username VARCHAR(64) NULL");
    expect(sql).toContain("ADD UNIQUE KEY uq_users_username (username)");
    expect(sql).toContain("ADD COLUMN password_hash VARCHAR(255) NULL");
  });

  it("creates api_tokens with user_id FK, token_hash, lifecycle timestamps, and index", async () => {
    await up(mockPool as never);

    const createCall = mockQuery.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("CREATE TABLE IF NOT EXISTS api_tokens"),
    );
    expect(createCall).toBeDefined();

    const sql = createCall![0] as string;
    expect(sql).toContain("id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT");
    expect(sql).toContain("user_id BIGINT UNSIGNED NOT NULL");
    expect(sql).toContain("token_hash CHAR(64) NOT NULL UNIQUE");
    expect(sql).toContain("created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    expect(sql).toContain("last_used_at TIMESTAMP NULL");
    expect(sql).toContain("revoked_at TIMESTAMP NULL");
    expect(sql).toContain("INDEX idx_api_tokens_user_revoked (user_id, revoked_at)");
    expect(sql).toContain(
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
  });

  it("drops api_tokens first and then fully reverses the users ALTERs on down", async () => {
    await down(mockPool as never);

    const sqls = mockQuery.mock.calls.map((call: unknown[]) => call[0] as string);

    // api_tokens must be dropped before the users FK target can be altered back.
    const dropApiTokensIdx = sqls.findIndex((s) =>
      s.includes("DROP TABLE IF EXISTS api_tokens"),
    );
    expect(dropApiTokensIdx).toBeGreaterThanOrEqual(0);

    const revertUsersSql = sqls.find(
      (s) => s.includes("ALTER TABLE users") && s.includes("DROP COLUMN username"),
    );
    expect(revertUsersSql).toBeDefined();
    expect(sqls.indexOf(revertUsersSql!)).toBeGreaterThan(dropApiTokensIdx);

    // Down must fully undo up — indexes, columns, and the PK swap.
    expect(revertUsersSql).toContain("DROP COLUMN password_hash");
    expect(revertUsersSql).toContain("DROP INDEX uq_users_username");
    expect(revertUsersSql).toContain("DROP COLUMN username");
    expect(revertUsersSql).toContain("DROP INDEX uq_users_slack_user_id");
    expect(revertUsersSql).toContain("MODIFY slack_user_id VARCHAR(50) NOT NULL");
    expect(revertUsersSql).toContain("DROP PRIMARY KEY");
    expect(revertUsersSql).toContain("DROP COLUMN id");
    expect(revertUsersSql).toContain("ADD PRIMARY KEY (slack_user_id)");
  });
});
