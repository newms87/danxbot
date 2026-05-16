/**
 * DX-571 (Phase 1 of DX-570): per-worktree Postgres database + role.
 *
 * For connected Laravel-pgsql repos (gpt-manager, etc.), every git
 * worktree gets its OWN Postgres database AND its OWN Postgres role.
 * The worktree's `.env` is a REAL file (not a symlink) with the DB_*
 * keys rewritten to the worktree-scoped credentials. All other env
 * keys (Pusher, Redis, OpenAI, queue) inherit from the parent .env
 * — those services may legitimately be shared across worktrees and
 * the rewrite scope is DB-only.
 *
 * Goal: defeat the SG-162 outage class — an unscoped
 * `php artisan migrate:fresh --drop-views --drop-types` run from a
 * worktree must NOT touch the operator's primary `laravel` database.
 * The mechanism is two-fold:
 *   1. The worktree's `.env` points artisan at `laravel_<worktree>`
 *      so the unscoped command operates on the per-worktree DB.
 *   2. `REVOKE CONNECT ON DATABASE laravel FROM agent_<worktree>`
 *      defeats env-override workarounds — even with the operator's
 *      credentials, the worktree role cannot reach the primary DB.
 *
 * Non-Laravel consumer repos (no `DB_CONNECTION=pgsql` in parent
 * `.env`) see ZERO behavior change; the symlink path in
 * `provisionEnvFile` still applies.
 *
 * Idempotent — running twice against an already-provisioned worktree
 * is a no-op. The migration runner uses `php artisan migrate --force`
 * (NOT `migrate:fresh`) so re-running against a populated DB does
 * not destroy data.
 *
 * Schema migration is OUT OF SCOPE for danxbot. The dispatched agent
 * inherits the worktree's per-agent credentials via the rewritten
 * `.env` and runs the consumer repo's own migration commands itself
 * (e.g. `php artisan migrate --force` for Laravel, equivalent for
 * other stacks). Danxbot provisions the empty DB + role only.
 *
 * Injection seams (constructor-only — no module-level singletons):
 *   - `pgClientFactory` — produces a `PgAdminClient` for the root
 *     superuser connection. Default impl uses `pg.Pool`.
 *   - `secretStore` — reads/writes the per-worktree DB password.
 *     Default impl writes to `<repo>/.danxbot/worktree-secrets/<name>.json`
 *     (gitignored), mode 0600.
 *
 * Tests cover detection, identifier composition, idempotency, env-file
 * rewrite, and the non-Laravel skip path via injected fakes. The
 * integration suite exercises real Postgres + sail container against
 * gpt-manager-pgsql-1.
 */

import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { provisionWorktreePorts } from "./worktree-ports.js";

const log = createLogger("worktree-database");

// --------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------

export interface PgConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface PgAdminClient {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export type PgClientFactory = (
  cfg: PgConnectionConfig,
) => Promise<PgAdminClient>;

export interface WorktreeSecretStore {
  read(repoRoot: string, worktreeName: string): string | null;
  write(repoRoot: string, worktreeName: string, password: string): void;
  /**
   * Idempotent remove — used by the bootstrap rollback path and the
   * teardown path to drop a persisted password. Missing-file is success.
   */
  remove(repoRoot: string, worktreeName: string): void;
}

export interface ProvisionWorktreeDatabaseOpts {
  repoRoot: string;
  worktreePath: string;
  worktreeName: string;
  pgClientFactory?: PgClientFactory;
  secretStore?: WorktreeSecretStore;
  /**
   * Host the worker should use to reach the consumer Postgres. Falls
   * back to the value of `DB_HOST` parsed from the parent `.env`. The
   * docker worker resolves `pgsql` via DNS on the shared sail network;
   * a host-mode operator running provision directly needs to pass an
   * override that resolves locally (e.g. `localhost`).
   */
  pgHostOverride?: string;
  /** Port companion to `pgHostOverride` — falls back to `DB_PORT` or 5432. */
  pgPortOverride?: number;
}

export type ProvisionResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "provisioned";
      workerDb: string;
      workerRole: string;
      created: { database: boolean; role: boolean };
    };

export interface DropWorktreeDatabaseOpts {
  repoRoot: string;
  worktreeName: string;
  pgClientFactory?: PgClientFactory;
  secretStore?: WorktreeSecretStore;
  pgHostOverride?: string;
  pgPortOverride?: number;
}

export type DropResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "dropped";
      workerDb: string;
      workerRole: string;
      dropped: { database: boolean; role: boolean };
    };

export class WorktreeDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeDatabaseError";
  }
}

// --------------------------------------------------------------------
// .env parsing + rewrite — narrow shape, dotenv-compatible enough for
// the keys we touch. Full POSIX-shell syntax (export, ${var}, command
// substitution) is out of scope — Laravel's own .env is a flat
// KEY=VALUE document and that's the only shape we read or write.
// --------------------------------------------------------------------

export type ParsedEnv = Record<string, string>;

export function parseDotenv(content: string): ParsedEnv {
  const out: ParsedEnv = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Replace KEY=... lines in-place; append missing keys at the end. Keeps
 * comments + unrelated lines verbatim so a hand-edited consumer .env
 * round-trips without losing the operator's notes.
 */
export function rewriteDotenv(
  content: string,
  overrides: Record<string, string>,
): string {
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const re = /^(\s*)([A-Z_][A-Z0-9_]*)\s*=/i;
  const next = lines.map((line) => {
    const m = re.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!(key in overrides)) return line;
    seen.add(key);
    return `${m[1]}${key}=${overrides[key]}`;
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (!seen.has(k)) next.push(`${k}=${v}`);
  }
  return next.join("\n");
}

// --------------------------------------------------------------------
// Detection
// --------------------------------------------------------------------

export function isLaravelPgsqlRepo(repoRoot: string): boolean {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return false;
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return false;
  }
  const parsed = parseDotenv(content);
  return parsed.DB_CONNECTION === "pgsql" && !!parsed.DB_DATABASE;
}

// --------------------------------------------------------------------
// Default secret store
// --------------------------------------------------------------------

const DEFAULT_SECRET_DIR = join(".danxbot", "worktree-secrets");

export const defaultSecretStore: WorktreeSecretStore = {
  read(repoRoot, worktreeName) {
    const path = join(repoRoot, DEFAULT_SECRET_DIR, `${worktreeName}.txt`);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf-8").trim() || null;
    } catch {
      return null;
    }
  },
  write(repoRoot, worktreeName, password) {
    const dir = join(repoRoot, DEFAULT_SECRET_DIR);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    const path = join(dir, `${worktreeName}.txt`);
    writeFileSync(path, `${password}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  remove(repoRoot, worktreeName) {
    const path = join(repoRoot, DEFAULT_SECRET_DIR, `${worktreeName}.txt`);
    rmSync(path, { force: true });
  },
};

export function generatePassword(): string {
  // 24 url-safe bytes → ~32 chars. Postgres accepts arbitrary printable
  // bytes; the URL-safe slice avoids quoting in shell / docker exec.
  return randomBytes(24).toString("base64url");
}

// --------------------------------------------------------------------
// Default pg client factory
// --------------------------------------------------------------------

export const defaultPgClientFactory: PgClientFactory = async (cfg) => {
  const pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  return {
    async query(sql, params) {
      const result = await pool.query(sql, params ? [...params] : undefined);
      return { rows: result.rows };
    },
    async end() {
      await pool.end();
    },
  };
};

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// --------------------------------------------------------------------
// Identifier validation — Postgres role + DB names land in dynamic SQL
// (Postgres has no parameter binding for object names). The agent name
// shape from `assertAgentName` already restricts to `[a-z0-9-]`, but
// defend at the SQL boundary so a future caller passing an unchecked
// name fails loud instead of silently shipping injection-prone DDL.
// --------------------------------------------------------------------

const PG_IDENT_SHAPE = /^[a-z_][a-z0-9_]*$/;

function assertPgIdent(name: string, role: string): void {
  if (!PG_IDENT_SHAPE.test(name)) {
    throw new WorktreeDatabaseError(
      `Refusing to use ${role}=${JSON.stringify(name)} as a Postgres identifier — must match ${PG_IDENT_SHAPE}`,
    );
  }
}

export function deriveWorktreeIdentifiers(
  primaryDb: string,
  worktreeName: string,
): { workerDb: string; workerRole: string } {
  // Worktree names allow `-`; Postgres identifiers do not. Translate to
  // `_` so `agent-foo` becomes role `agent_agent_foo` and DB
  // `laravel_agent_foo`. The translation is local to the SQL boundary
  // — the worktree dir name + filesystem identifiers keep the `-`.
  const sanitized = worktreeName.replace(/-/g, "_");
  const workerDb = `${primaryDb}_${sanitized}`;
  const workerRole = `agent_${sanitized}`;
  assertPgIdent(workerDb, "worker_db");
  assertPgIdent(workerRole, "worker_role");
  return { workerDb, workerRole };
}

// --------------------------------------------------------------------
// Core provisioner
// --------------------------------------------------------------------

export async function provisionWorktreeDatabase(
  opts: ProvisionWorktreeDatabaseOpts,
): Promise<ProvisionResult> {
  if (!isLaravelPgsqlRepo(opts.repoRoot)) {
    return { kind: "skipped", reason: "not a Laravel-pgsql consumer repo" };
  }

  const parentEnvPath = join(opts.repoRoot, ".env");
  const parentContent = readFileSync(parentEnvPath, "utf-8");
  const parentEnv = parseDotenv(parentContent);

  const primaryDb = parentEnv.DB_DATABASE;
  const rootUser = parentEnv.DB_USERNAME;
  const rootPassword = parentEnv.DB_PASSWORD;
  if (!primaryDb || !rootUser || rootPassword === undefined) {
    throw new WorktreeDatabaseError(
      `Parent .env at ${parentEnvPath} is missing DB_DATABASE / DB_USERNAME / DB_PASSWORD; cannot provision`,
    );
  }

  const dbHost = opts.pgHostOverride ?? parentEnv.DB_HOST ?? "localhost";
  const dbPort = opts.pgPortOverride ?? Number(parentEnv.DB_PORT ?? "5432");
  if (!Number.isInteger(dbPort) || dbPort <= 0) {
    throw new WorktreeDatabaseError(
      `Invalid DB_PORT ${parentEnv.DB_PORT} — must be a positive integer`,
    );
  }

  // Defense-in-depth — `primaryDb` flows from the operator-authored
  // parent `.env` into dynamic DDL (`REVOKE CONNECT ON DATABASE "<primaryDb>" ...`).
  // PG has no parameter binding for object names, so the only safe
  // posture is reject-on-shape at the SQL boundary.
  assertPgIdent(primaryDb, "primary_db");

  const { workerDb, workerRole } = deriveWorktreeIdentifiers(
    primaryDb,
    opts.worktreeName,
  );

  const secretStore = opts.secretStore ?? defaultSecretStore;
  // Read first; defer the write until AFTER the DB connection succeeds.
  // Writing the secret on read-miss BEFORE the DDL succeeds would leave a
  // password file on disk for a role the provisioner never managed to
  // create — a re-run would then rotate an unrelated existing role to
  // that secret. Generate-in-memory, persist on success.
  let workerPassword = secretStore.read(opts.repoRoot, opts.worktreeName);
  const generatedPassword = workerPassword === null;
  if (workerPassword === null) {
    workerPassword = generatePassword();
  }

  const factory = opts.pgClientFactory ?? defaultPgClientFactory;
  const client = await factory({
    host: dbHost,
    port: dbPort,
    database: primaryDb,
    user: rootUser,
    password: rootPassword,
  });

  let created: { database: boolean; role: boolean };
  try {
    created = await provisionDdl(client, {
      primaryDb,
      workerDb,
      workerRole,
      workerPassword,
    });
  } finally {
    await client.end();
  }

  if (generatedPassword) {
    secretStore.write(opts.repoRoot, opts.worktreeName, workerPassword);
  }

  // Per-worktree host-port overrides. The consumer's docker-compose.yml
  // declares every host-port mapping via `${VAR:-default}` env
  // interpolation, so the worktree's .env is the single source of truth
  // for which host port its compose stack binds. Without these overrides
  // every worktree inherits the operator's root ports and races for the
  // same host binding. See `worktree-ports.ts` for the registry + range
  // design.
  const portOverrides = provisionWorktreePorts(
    opts.repoRoot,
    opts.worktreeName,
  );

  writeWorktreeEnvFile(opts.worktreePath, parentContent, {
    DB_DATABASE: workerDb,
    DB_USERNAME: workerRole,
    DB_PASSWORD: workerPassword,
    ...portOverrides,
  });

  log.info(
    `provisionWorktreeDatabase(${opts.worktreeName}): ${workerDb} / ${workerRole} ready ` +
      `(created db=${created.database}, role=${created.role})`,
  );

  return { kind: "provisioned", workerDb, workerRole, created };
}

interface DdlContext {
  primaryDb: string;
  workerDb: string;
  workerRole: string;
  workerPassword: string;
}

async function provisionDdl(
  client: PgAdminClient,
  ctx: DdlContext,
): Promise<{ database: boolean; role: boolean }> {
  // Role first — CREATE DATABASE with OWNER=<role> would need the role to
  // exist, and we want consistent ownership for cleanest GRANTs.
  const roleExists = await client.query(
    `SELECT 1 FROM pg_roles WHERE rolname = $1`,
    [ctx.workerRole],
  );
  let createdRole = false;
  if (roleExists.rows.length === 0) {
    // The role password is `randomBytes(24).toString("base64url")` (~32
    // bytes of `[A-Za-z0-9_-]` — no quotes, no shell metacharacters), and
    // the role name passed `assertPgIdent` so it's `[a-z_][a-z0-9_]*`.
    // `CREATE ROLE` has no parameter binding for object names; the
    // password literal is the only quoted scalar and the charset
    // guarantees the single-quote escape below is sufficient.
    await client.query(
      `CREATE ROLE "${ctx.workerRole}" WITH LOGIN PASSWORD '${ctx.workerPassword.replace(/'/g, "''")}'`,
    );
    createdRole = true;
  } else {
    // Rotate password to whatever the secret store has. Idempotent — re-
    // running bootstrap with the same secret is a no-op cost.
    await client.query(
      `ALTER ROLE "${ctx.workerRole}" WITH LOGIN PASSWORD '${ctx.workerPassword.replace(/'/g, "''")}'`,
    );
  }

  const dbExists = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [ctx.workerDb],
  );
  let createdDb = false;
  if (dbExists.rows.length === 0) {
    // CREATE DATABASE cannot run inside a transaction; the pg pool runs
    // each query in its own implicit transaction, so this is fine as a
    // standalone statement.
    await client.query(
      `CREATE DATABASE "${ctx.workerDb}" OWNER "${ctx.workerRole}"`,
    );
    createdDb = true;
  } else {
    // Idempotent: ensure ownership is correct even when the DB pre-existed.
    await client.query(
      `ALTER DATABASE "${ctx.workerDb}" OWNER TO "${ctx.workerRole}"`,
    );
  }

  await client.query(
    `GRANT ALL PRIVILEGES ON DATABASE "${ctx.workerDb}" TO "${ctx.workerRole}"`,
  );

  // Critical isolation step — defeat env-override workarounds. Even if
  // an agent overrides DB_DATABASE=laravel in their shell, the role
  // itself cannot CONNECT to the primary.
  //
  // Postgres detail: `REVOKE CONNECT ... FROM <role>` is a NO-OP when
  // the role has no explicit GRANT — `pg_database.datacl` only tracks
  // deviations from the default, and the default grants CONNECT to
  // PUBLIC (which every role inherits). The actual lock is `REVOKE
  // CONNECT ... FROM PUBLIC`; the database OWNER retains CONNECT
  // implicitly (owner privileges are not subject to PUBLIC revokes),
  // so the operator's `sail` role on the primary `laravel` DB stays
  // unaffected. The per-role REVOKE that follows is defense-in-depth
  // — redundant once PUBLIC is locked but cheap insurance against a
  // future GRANT that mistakenly re-opens PUBLIC.
  //
  // Idempotency: REVOKE FROM PUBLIC on every provision is safe — the
  // first call locks the door, subsequent calls are no-ops.
  await client.query(
    `REVOKE CONNECT ON DATABASE "${ctx.primaryDb}" FROM PUBLIC`,
  );
  await client.query(
    `REVOKE CONNECT ON DATABASE "${ctx.primaryDb}" FROM "${ctx.workerRole}"`,
  );

  return { database: createdDb, role: createdRole };
}

// --------------------------------------------------------------------
// Worktree .env file write — replaces any existing symlink or real
// file. Atomic via tmp+rename so a crashed mid-write does not leave a
// half-populated .env.
// --------------------------------------------------------------------

export function writeWorktreeEnvFile(
  worktreePath: string,
  parentContent: string,
  overrides: Record<string, string>,
): void {
  const target = join(worktreePath, ".env");
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (existing) {
    rmSync(target, { force: true });
  }
  const next = rewriteDotenv(parentContent, overrides);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, next, { mode: 0o600 });
  // Atomic rename — POSIX guarantees same-filesystem rename is atomic.
  // Worktree + parent .env always live on the same filesystem.
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// --------------------------------------------------------------------
// Symmetric inverse of provisionWorktreeDatabase.
//
// Called by:
//   - WorktreeManager.bootstrap rollback when a later provision step
//     throws after the DB step succeeded
//   - WorktreeManager.teardown when an agent is deleted via the
//     dashboard
//
// Idempotent — running against an already-cleaned worktree returns
// `{ kind: "dropped", dropped: { database: false, role: false } }`
// without throwing. Partial-state recovery is supported (DB gone but
// role still around, vice versa).
// --------------------------------------------------------------------

export async function dropWorktreeDatabase(
  opts: DropWorktreeDatabaseOpts,
): Promise<DropResult> {
  if (!isLaravelPgsqlRepo(opts.repoRoot)) {
    return { kind: "skipped", reason: "not a Laravel-pgsql consumer repo" };
  }

  const parentEnvPath = join(opts.repoRoot, ".env");
  const parentContent = readFileSync(parentEnvPath, "utf-8");
  const parentEnv = parseDotenv(parentContent);

  const primaryDb = parentEnv.DB_DATABASE;
  const rootUser = parentEnv.DB_USERNAME;
  const rootPassword = parentEnv.DB_PASSWORD;
  if (!primaryDb || !rootUser || rootPassword === undefined) {
    throw new WorktreeDatabaseError(
      `Parent .env at ${parentEnvPath} is missing DB_DATABASE / DB_USERNAME / DB_PASSWORD; cannot drop`,
    );
  }

  const dbHost = opts.pgHostOverride ?? parentEnv.DB_HOST ?? "localhost";
  const dbPort = opts.pgPortOverride ?? Number(parentEnv.DB_PORT ?? "5432");
  if (!Number.isInteger(dbPort) || dbPort <= 0) {
    throw new WorktreeDatabaseError(
      `Invalid DB_PORT ${parentEnv.DB_PORT} — must be a positive integer`,
    );
  }

  assertPgIdent(primaryDb, "primary_db");
  const { workerDb, workerRole } = deriveWorktreeIdentifiers(
    primaryDb,
    opts.worktreeName,
  );

  const secretStore = opts.secretStore ?? defaultSecretStore;
  const factory = opts.pgClientFactory ?? defaultPgClientFactory;
  const client = await factory({
    host: dbHost,
    port: dbPort,
    database: primaryDb,
    user: rootUser,
    password: rootPassword,
  });

  let dropped: { database: boolean; role: boolean };
  try {
    dropped = await dropDdl(client, { workerDb, workerRole });
  } finally {
    await client.end();
  }

  // Remove the secret file LAST — only after the DB-side teardown has
  // returned. Removing first would leave a credentialled role on the
  // server with no operator record of its password.
  secretStore.remove(opts.repoRoot, opts.worktreeName);

  log.info(
    `dropWorktreeDatabase(${opts.worktreeName}): ${workerDb} / ${workerRole} cleared ` +
      `(dropped db=${dropped.database}, role=${dropped.role})`,
  );

  return { kind: "dropped", workerDb, workerRole, dropped };
}

async function dropDdl(
  client: PgAdminClient,
  ctx: { workerDb: string; workerRole: string },
): Promise<{ database: boolean; role: boolean }> {
  // Database first — DROP ROLE with active OWNER-of relationships throws.
  // Dropping the database removes the OWNER relationship, then ROLE drops
  // cleanly.
  const dbExists = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [ctx.workerDb],
  );
  let droppedDb = false;
  if (dbExists.rows.length > 0) {
    // Cancel any lingering sessions on the per-worktree DB so DROP doesn't
    // race a still-open connection. Defense-in-depth — the per-worktree DB
    // should be quiescent by the time teardown fires, but a leaked agent
    // PID is exactly the kind of orphan this cleanup exists to handle.
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [ctx.workerDb],
    );
    await client.query(`DROP DATABASE "${ctx.workerDb}"`);
    droppedDb = true;
  }

  const roleExists = await client.query(
    `SELECT 1 FROM pg_roles WHERE rolname = $1`,
    [ctx.workerRole],
  );
  let droppedRole = false;
  if (roleExists.rows.length > 0) {
    await client.query(`DROP ROLE "${ctx.workerRole}"`);
    droppedRole = true;
  }

  return { database: droppedDb, role: droppedRole };
}
