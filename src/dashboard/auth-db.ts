import { randomBytes, createHash } from "crypto";
import bcrypt from "bcrypt";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getPool } from "../db/connection.js";
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
  const pool = getPool();
  await pool.execute(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
    [userId],
  );
  const rawToken = generateRawToken();
  await pool.execute(
    "INSERT INTO api_tokens (user_id, token_hash) VALUES (?, ?)",
    [userId, hashToken(rawToken)],
  );
  return rawToken;
}

export async function upsertDashboardUser(
  username: string,
  plainPassword: string,
): Promise<{ userId: number; rawToken: string }> {
  const pool = getPool();
  const passwordHash = await hashPassword(plainPassword);

  await pool.execute(
    `INSERT INTO users (username, password_hash)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [username, passwordHash],
  );

  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM users WHERE username = ?",
    [username],
  );
  const userId = (rows[0] as { id: number } | undefined)?.id;
  if (typeof userId !== "number") {
    throw new Error(`upsertDashboardUser: no id returned for username "${username}"`);
  }

  const rawToken = await issueFreshToken(userId);
  log.info(`Upserted dashboard user "${username}" (id=${userId}) and rotated token`);
  return { userId, rawToken };
}

export async function loginDashboardUser(
  username: string,
  plainPassword: string,
): Promise<{ userId: number; rawToken: string } | null> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, password_hash FROM users WHERE username = ?",
    [username],
  );
  const row = rows[0] as { id: number; password_hash: string | null } | undefined;
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

  const pool = getPool();
  const tokenHash = hashToken(rawToken);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT api_tokens.user_id AS user_id, users.username AS username
     FROM api_tokens
     JOIN users ON users.id = api_tokens.user_id
     WHERE api_tokens.token_hash = ? AND api_tokens.revoked_at IS NULL`,
    [tokenHash],
  );
  const row = rows[0] as { user_id: number; username: string } | undefined;
  if (!row) return null;

  await pool.execute(
    "UPDATE api_tokens SET last_used_at = NOW() WHERE token_hash = ?",
    [tokenHash],
  );

  return { userId: row.user_id, username: row.username };
}

export async function revokeAllTokensForUser(userId: number): Promise<void> {
  const pool = getPool();
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
    [userId],
  );
  log.info(`Revoked ${result.affectedRows} token(s) for user id=${userId}`);
}
