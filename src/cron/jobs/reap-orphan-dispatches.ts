/**
 * DX-327 / DX-323 Phase 4 — orphan dispatch reaper.
 *
 * A cron job (registered in `./index.ts`, fired every 60s by
 * `src/cron/worker-loop.ts`) that joins live `danxbot-dispatch-<id>.scope`
 * systemd transient units with the `dispatches` Postgres table and
 * `systemctl --user stop`s every scope whose dispatch row is
 * terminal-or-missing AND whose scope age clears the 60s race-window
 * guard.
 *
 * Why this exists: the worker can die uncleanly (OOM, kill -9, host
 * reboot, container abort, power loss) without running `job.stop`.
 * The scope's cgroup persists with its process tree; the dispatch
 * row's status remains `running` until the worker's boot
 * reconciliation flips it (or never, if the worker doesn't come
 * back). This job is the safety net that prevents leaked dispatches
 * from accumulating in `systemctl --user list-units --all` and
 * keeping their child processes alive indefinitely.
 *
 * Contracts pinned by the unit tests in
 * `reap-orphan-dispatches.test.ts`:
 *
 *   1. Env gate is fail-loud. Missing `DANXBOT_DB_USER` or
 *      `DANXBOT_DB_PASSWORD` at job runtime throws BEFORE any
 *      systemctl call — the reaper never silently skips a tick.
 *   2. Live dispatches (status ∈ {`queued`, `running`}) are NEVER
 *      reaped.
 *   3. Fresh scopes (age ≤ 60s, strictly ≤) are NEVER reaped — the
 *      DB row may not have committed yet for a newly-spawned
 *      dispatch.
 *   4. Reap reason is structured: `terminal-row` (DB row exists +
 *      status is in `TERMINAL_STATUSES`) vs `missing-row` (DB row
 *      not found).
 *   5. A reap-action failure on one unit does NOT block the rest.
 *      The error is logged in the same structured-line shape; the
 *      loop continues.
 *   6. Anti-goals: no DB writes, no env-variable scan / proc-tree
 *      walk for non-scope orphans, no "kill anything older than X
 *      regardless of DB" path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query as defaultQuery } from "../../db/connection.js";
import { TERMINAL_STATUSES } from "../../dashboard/dispatches.js";
import {
  listDispatchScopes as defaultListDispatchScopes,
  type DispatchScopeUnit,
  type ExecFn,
  type ListDispatchScopesOptions,
} from "../scope-list.js";
import type { CronJob } from "../types.js";

/**
 * Scope must be strictly older than 60s before reap is allowed.
 * Guards the race where systemd-run started the scope but the DB row
 * insert hasn't committed yet (same window also covers a freshly-
 * restarted worker still hydrating its rows from prior dispatches).
 */
export const SCOPE_AGE_THRESHOLD_MS = 60_000;

const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_STATUSES);
if (TERMINAL_STATUS_SET.size === 0) {
  // Defense-in-depth — if a future refactor empties TERMINAL_STATUSES,
  // every scope with a DB row would silently pass through the reaper
  // (the only reap path left would be missing-row). Fail at module
  // load so the regression surfaces on the next worker boot.
  throw new Error(
    "reap-orphan-dispatches: TERMINAL_STATUSES is empty — refusing to load",
  );
}

const REQUIRED_ENV = ["DANXBOT_DB_USER", "DANXBOT_DB_PASSWORD"] as const;

export type ReapReason = "terminal-row" | "missing-row";

export interface DispatchRowSlim {
  readonly id: string;
  readonly status: string;
}

export type QueryDispatchesFn = (
  ids: readonly string[],
) => Promise<DispatchRowSlim[]>;

export type ReapFn = (unit: string) => Promise<void>;

export interface ReapLogLineSuccess {
  readonly name: "reap-orphan-dispatches";
  readonly dispatchId: string;
  readonly unit: string;
  readonly reason: ReapReason;
  readonly killedAtIso: string;
}

export interface ReapLogLineError {
  readonly name: "reap-orphan-dispatches";
  readonly dispatchId: string;
  readonly unit: string;
  readonly reason: ReapReason;
  readonly error: string;
}

export type ReapLogLine = ReapLogLineSuccess | ReapLogLineError;

export type LogFn = (line: ReapLogLine) => void;

export interface ReapDeps {
  /** Override the scope-list enumerator (defaults to `listDispatchScopes`). */
  listScopes?: (
    opts?: ListDispatchScopesOptions,
  ) => Promise<DispatchScopeUnit[]>;
  /** Override the DB query — receives the eligible dispatch ids. */
  queryDispatches?: QueryDispatchesFn;
  /** Override the reap action (defaults to `systemctl --user stop <unit>`). */
  reap?: ReapFn;
  /** Inject a clock for deterministic age math. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Inject the exec wrapper used by BOTH the default scope-list
   * (when `listScopes` is not overridden) AND the default reap
   * action (when `reap` is not overridden). Tests use this to pin
   * the systemctl argv without a real shell-out.
   */
  exec?: ExecFn;
  /** Structured logger — emits one object per reap decision or error. */
  log?: LogFn;
}

function assertEnv(): void {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `reap-orphan-dispatches: missing required env vars at job runtime: ${missing.join(", ")}`,
    );
  }
}

async function defaultQueryDispatches(
  ids: readonly string[],
): Promise<DispatchRowSlim[]> {
  if (ids.length === 0) return [];
  return defaultQuery<DispatchRowSlim>(
    "SELECT id, status FROM dispatches WHERE id = ANY($1::text[])",
    [[...ids]],
  );
}

const execFileAsync = promisify(execFile);

function buildDefaultReap(exec: ExecFn | undefined): ReapFn {
  if (exec) {
    return async (unit: string) => {
      await exec("systemctl", ["--user", "stop", unit]);
    };
  }
  return async (unit: string) => {
    await execFileAsync("systemctl", ["--user", "stop", unit]);
  };
}

function defaultLog(line: ReapLogLine): void {
  // Structured JSON line to stdout — DX-551 folded the cron tick
  // into the worker, so this writes into the worker's stdout (visible
  // via `make logs REPO=<name>`). Other danxbot modules use
  // `createLogger`, but the cron tick already isolates failures at
  // the per-job boundary and we want the operator-facing log line to
  // be plain JSON, not the logger's wrapper shape.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export async function runReapOrphanDispatches(
  deps: ReapDeps = {},
): Promise<void> {
  assertEnv();

  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? defaultLog;
  const reap = deps.reap ?? buildDefaultReap(deps.exec);
  const listScopes = deps.listScopes ?? defaultListDispatchScopes;
  const queryDispatches = deps.queryDispatches ?? defaultQueryDispatches;
  const listScopesOptions: ListDispatchScopesOptions = deps.exec
    ? { exec: deps.exec }
    : {};

  const scopes = await listScopes(listScopesOptions);
  if (scopes.length === 0) return;

  const eligible = scopes.filter(
    (s) => now - s.activeEnterEpochMs > SCOPE_AGE_THRESHOLD_MS,
  );
  if (eligible.length === 0) return;

  const rows = await queryDispatches(eligible.map((s) => s.dispatchId));
  const statusById = new Map<string, string>(
    rows.map((r) => [r.id, r.status]),
  );

  for (const scope of eligible) {
    const status = statusById.get(scope.dispatchId);
    let reason: ReapReason | null = null;
    if (status === undefined) reason = "missing-row";
    else if (TERMINAL_STATUS_SET.has(status)) reason = "terminal-row";
    if (reason === null) continue;

    try {
      await reap(scope.unit);
      log({
        name: "reap-orphan-dispatches",
        dispatchId: scope.dispatchId,
        unit: scope.unit,
        reason,
        killedAtIso: new Date(now).toISOString(),
      });
    } catch (err) {
      log({
        name: "reap-orphan-dispatches",
        dispatchId: scope.dispatchId,
        unit: scope.unit,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const reapOrphanDispatches: CronJob = {
  name: "reap-orphan-dispatches",
  intervalSec: 60,
  run: () => runReapOrphanDispatches(),
};
