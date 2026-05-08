import { randomBytes, createHash } from "crypto";
import bcrypt from "bcrypt";
import { getPool, query } from "../db/connection.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth-db");

const BCRYPT_ROUNDS = 12;
const TOKEN_BYTES = 36;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function generateRawToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Rotate-on-login is intentional: every successful login and every upsert
// revokes the user's existing active tokens and issues a fresh one. This is
// single-session-per-user by design — the DB never has to "return on login"
// a raw token it already forgot. Phase 2 middleware surfaces this as a
// 401 / "signed in from another session" on the losing tab.
async function issueFreshToken(userId: number): Promise<string> {
  await query(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  const rawToken = generateRawToken();
  await query(
    "INSERT INTO api_tokens (user_id, token_hash) VALUES ($1, $2)",
    [userId, hashToken(rawToken)],
  );
  return rawToken;
}

export async function upsertDashboardUser(
  username: string,
  plainPassword: string,
): Promise<{ userId: number; rawToken: string }> {
  const passwordHash = await hashPassword(plainPassword);

  await query(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, passwordHash],
  );

  const rows = await query<{ id: number }>(
    "SELECT id FROM users WHERE username = $1",
    [username],
  );
  const userId = rows[0]?.id;
  if (typeof userId !== "number") {
    throw new Error(`upsertDashboardUser: no id returned for username "${username}"`);
  }

  const rawToken = await issueFreshToken(userId);
  log.info(`Upserted dashboard user "${username}" (id=${userId}) and rotated token`);
  return { userId, rawToken };
}

export type EnsureUserAction = "created" | "rotated" | "unchanged";

export interface EnsureUserResult {
  userId: number;
  action: EnsureUserAction;
  rawToken?: string;
}

export async function ensureDashboardUser(
  username: string,
  plainPassword: string,
): Promise<EnsureUserResult> {
  const rows = await query<{ id: number; password_hash: string | null }>(
    "SELECT id, password_hash FROM users WHERE username = $1",
    [username],
  );
  const existing = rows[0];

  if (existing && existing.password_hash) {
    const ok = await verifyPassword(plainPassword, existing.password_hash);
    if (ok) {
      log.info(`Dashboard user "${username}" already up-to-date — no change`);
      return { userId: existing.id, action: "unchanged" };
    }
  }

  const { userId, rawToken } = await upsertDashboardUser(username, plainPassword);
  return {
    userId,
    rawToken,
    action: existing ? "rotated" : "created",
  };
}

export async function loginDashboardUser(
  username: string,
  plainPassword: string,
): Promise<{ userId: number; rawToken: string } | null> {
  const rows = await query<{ id: number; password_hash: string | null }>(
    "SELECT id, password_hash FROM users WHERE username = $1",
    [username],
  );
  const row = rows[0];
  if (!row || !row.password_hash) return null;

  const ok = await verifyPassword(plainPassword, row.password_hash);
  if (!ok) return null;

  const rawToken = await issueFreshToken(row.id);
  return { userId: row.id, rawToken };
}

export async function validateToken(
  rawToken: string,
): Promise<{ userId: number; username: string } | null> {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const rows = await query<{ user_id: number; username: string }>(
    `SELECT api_tokens.user_id AS user_id, users.username AS username
     FROM api_tokens
     JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token_hash = $1 AND api_tokens.revoked_at IS NULL`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;

  await query(
    "UPDATE api_tokens SET last_used_at = NOW() WHERE token_hash = $1",
    [tokenHash],
  );

  return { userId: row.user_id, username: row.username };
}

export async function revokeAllTokensForUser(userId: number): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );
  log.info(`Revoked ${result.rowCount ?? 0} token(s) for user id=${userId}`);
}
