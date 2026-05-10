/**
 * DX-242: fallback paths for `danxbot_complete` when the worker's
 * `DANXBOT_STOP_URL` is unreachable (worker crashed, OOM-killed,
 * `make stop-worker`, host reboot). Without these the dispatch sits
 * with `status = running` until the row's TTL, the auto-sync to the
 * tracker never fires, and the YAML / Trello state is half-applied.
 *
 * Strategy chosen (option 3 from the card body): try a direct DB write
 * first, then a filesystem queue file the worker replays on boot. The
 * DB path covers the 99% case (worker dies, postgres is healthy); the
 * filesystem queue covers the 1% (postgres also unreachable). The MCP
 * server already inherits the credentials it needs via env.
 *
 * Both fallbacks are best-effort: each returns `true` on success and
 * `false` on any error. The caller chains them (HTTP → DB → fs) and
 * surfaces a single error to the agent only when EVERY path fails.
 *
 * Why a separate file: keeps the danxbot-server core small (still no
 * runtime DB dependency for non-fallback paths) and lets unit tests
 * exercise the fallback chain in isolation against a local pg / tmpdir
 * without spawning the full MCP stdio server.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { TERMINAL_STATUSES } from "../dashboard/dispatches.js";

/**
 * `dispatches` table fields the fallback writes. Mirrors the worker
 * `handleStopFromDb` shape: terminal status (collapsed from agent
 * `CompleteStatus` to DB `DispatchStatus`), summary, completed_at,
 * pid_terminated_at. We deliberately do NOT update tracker state here
 * — that's the worker's boot-replay job (auto-sync needs in-process
 * tracker bindings the MCP server doesn't carry).
 */
interface DbWriteShape {
  dispatchId: string;
  /** Already-collapsed DB status: `completed` or `failed`. */
  dbStatus: "completed" | "failed";
  summary: string;
}

export interface FallbackDbConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
}

/**
 * Attempt a direct UPDATE on the dispatches row. Returns true when the
 * row was non-terminal and we transitioned it; false on any error or
 * when the row was already terminal (idempotent — preserves the
 * original terminal reason).
 *
 * Tight timeouts (3s connect, 1s idle): the agent is blocking on
 * `danxbot_complete`'s response, so a stuck DB call would just hang
 * the dispatch. Better to fall through to the filesystem queue
 * quickly.
 */
export async function tryDirectDbWrite(
  shape: DbWriteShape,
  db: FallbackDbConfig,
): Promise<boolean> {
  let pool: Pool | undefined;
  try {
    pool = new Pool({
      host: db.host,
      ...(db.port ? { port: db.port } : {}),
      user: db.user,
      password: db.password,
      ...(db.database ? { database: db.database } : {}),
      max: 1,
      idleTimeoutMillis: 1_000,
      connectionTimeoutMillis: 3_000,
    });

    const completedAt = Date.now();
    // Idempotent: skip already-terminal rows. Mirrors the worker-side
    // `handleStopFromDb` which short-circuits on
    // `isTerminalStatus(dispatch.status)`. The `NOT IN (...)` clause
    // is built from `TERMINAL_STATUSES` (the canonical list in
    // `dashboard/dispatches.ts`) so a future status addition (e.g.
    // a new terminal value) automatically participates without
    // touching this SQL — no `cancelled`-row corruption regression.
    const placeholders = TERMINAL_STATUSES.map(
      (_, i) => `$${i + 5}`,
    ).join(", ");
    const result = await pool.query(
      `UPDATE dispatches
       SET "status" = $1,
           summary = $2,
           completed_at = $3,
           pid_terminated_at = $3
       WHERE id = $4
         AND "status" NOT IN (${placeholders})`,
      [
        shape.dbStatus,
        shape.summary,
        completedAt,
        shape.dispatchId,
        ...TERMINAL_STATUSES,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    // Connection refused, table missing, auth failure, anything — we
    // do NOT distinguish. The next fallback (fs queue) handles it.
    return false;
  } finally {
    if (pool) {
      await pool.end().catch(() => {
        /* swallow shutdown errors */
      });
    }
  }
}

export interface FsQueueShape {
  dispatchId: string;
  /** Original agent-facing `CompleteStatus` — preserved for the boot replay. */
  status: string;
  summary: string;
}

/**
 * Write a queued-stop file at
 * `<repoRoot>/.danxbot/dispatch-stops/<dispatchId>.json`. Atomic write
 * via tempfile + rename so the worker's boot replay never reads a
 * half-written body. Returns true on success, false on any IO error.
 *
 * Body shape (read by the worker's boot replay path):
 *   {dispatchId, status, summary, timestamp}
 *
 * `status` is the agent-facing `CompleteStatus` (not the collapsed DB
 * status) — the worker's replay path mirrors the in-memory handleStop
 * branching for `critical_failure` correctly.
 */
export function writeFsQueueEntry(
  shape: FsQueueShape,
  repoRoot: string,
): boolean {
  try {
    const dir = join(repoRoot, ".danxbot", "dispatch-stops");
    mkdirSync(dir, { recursive: true });
    const finalPath = join(dir, `${shape.dispatchId}.json`);
    const tempPath = `${finalPath}.tmp.${process.pid}`;
    const body = JSON.stringify({
      dispatchId: shape.dispatchId,
      status: shape.status,
      summary: shape.summary,
      timestamp: new Date().toISOString(),
    });
    writeFileSync(tempPath, body, { encoding: "utf-8" });
    renameSync(tempPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read DB credentials from process.env using the same `DANXBOT_DB_*`
 * vars the worker reads. Returns undefined when any required field is
 * absent — the caller treats that as "DB fallback not available" and
 * skips straight to the filesystem queue.
 */
export function readFallbackDbConfig(
  env: NodeJS.ProcessEnv = process.env,
): FallbackDbConfig | undefined {
  const host = env.DANXBOT_DB_HOST;
  const user = env.DANXBOT_DB_USER;
  const password = env.DANXBOT_DB_PASSWORD;
  if (!host || !user || !password) return undefined;
  const portRaw = env.DANXBOT_DB_PORT;
  const port = portRaw ? parseInt(portRaw, 10) : undefined;
  const database = env.DANXBOT_DB_NAME;
  return {
    host,
    ...(port && Number.isFinite(port) ? { port } : {}),
    user,
    password,
    ...(database ? { database } : {}),
  };
}
