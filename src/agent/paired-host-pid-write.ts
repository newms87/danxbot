/**
 * Paired-write of a dispatch's `host_pid` (DB row) + `dispatch.pid`
 * (YAML) — Phase 1 of the DB-as-dispatch-registry epic (DX-139 / DX-140).
 *
 * Today's spawn flow inserts the DB row with a placeholder PID and
 * stamps the YAML's `dispatch.pid` post-spawn from a separate code
 * path. Until both stamps land, the worker has divergent truth — the
 * exact failure mode that produced the May-7 incident:
 *
 *     Reconciled orphaned dispatch 26dbeb33 (host_pid=35761) → failed
 *     reattach: DX-90 alive (pid=33130, dispatch=26dbeb33) — registered
 *
 * Same dispatch UUID, two different PIDs, opposite verdicts.
 *
 * `pairedWriteHostPid` writes both stamps in the same logical block
 * with mutual rollback. After the runtime fork resolves the agent
 * script PID, callers invoke this helper with the dispatchId, the
 * resolved PID, and (for poller-path dispatches) a YAML write/clear
 * pair. Both stamps succeed (commit) or both are torn down (rollback)
 * and the dispatch row is marked failed with a "paired-write rollback"
 * summary so reconcile + dashboards see a consistent terminal record.
 *
 * Slack and `/api/launch` paths today have no per-dispatch YAML — they
 * pass `yaml: undefined` and only get the DB-side stamp. The same
 * function shape stays correct for them; rollback is DB-only, and the
 * helper still marks the dispatch failed loudly when the DB write
 * itself fails (no silent fallback — see `.claude/rules/code-quality.md`
 * "fallbacks are bugs").
 */

import { updateDispatch as defaultUpdateDispatch } from "../dashboard/dispatches-db.js";
import { createLogger } from "../logger.js";

const log = createLogger("paired-host-pid");

/**
 * YAML-side callback pair for the paired write. The poller wires the
 * `stampDispatchAndWrite` / `clearDispatchAndWrite` calls in here so the
 * launcher does not need to import the issue tracker.
 *
 * `write` MUST throw on failure — a silent failure would leave the YAML
 * unstamped while the DB carries a real PID, recreating the divergent
 * truth this epic exists to eliminate. `clear` is best-effort (rollback
 * path); errors are logged but do not propagate, because the rollback
 * is already consequence of an upstream failure and adding a second
 * exception would mask the first.
 */
export interface YamlPairedWrite {
  write(pid: number): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface PairedHostPidWriteOptions {
  dispatchId: string;
  /** Agent process PID (host: `script -q -f` wrapper; docker: claude child). */
  pid: number;
  /** Optional YAML stamp pair. Omit for non-poller dispatches. */
  yaml?: YamlPairedWrite;
  /** Injectable for tests; defaults to the live DB updater. */
  updateDispatchFn?: typeof defaultUpdateDispatch;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Thrown when either the DB or YAML half of the paired write fails.
 * `dbError` and `yamlError` are surfaced individually so the caller can
 * log the underlying root cause; the throw itself is a single error so
 * upstream `try/catch` blocks stay simple.
 */
export class PairedHostPidWriteError extends Error {
  constructor(
    message: string,
    readonly dbError: Error | null,
    readonly yamlError: Error | null,
  ) {
    super(message);
    this.name = "PairedHostPidWriteError";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Stamp `host_pid` + `host_pid_at` on the DB row AND `dispatch.pid` on
 * the YAML in one logical operation. On any failure: roll back whichever
 * half succeeded, mark the dispatch row `failed` with summary
 * `"Paired host_pid write rolled back"`, and throw `PairedHostPidWriteError`.
 *
 * Ordering: YAML write first (synchronous, fast), then DB UPDATE. With
 * this order:
 *   - YAML throws → DB stamp never runs → no DB rollback needed; the
 *     dispatch is marked failed and we throw.
 *   - YAML succeeds, DB throws → YAML rollback fires (`yaml.clear()`),
 *     the dispatch is marked failed, and we throw.
 *
 * Rollback writes are wrapped in their own try/catch so a transient DB
 * hiccup during rollback can't shadow the original failure — we still
 * log + throw with the root cause attached.
 */
export async function pairedWriteHostPid(
  opts: PairedHostPidWriteOptions,
): Promise<void> {
  const updateDispatch = opts.updateDispatchFn ?? defaultUpdateDispatch;
  const now = opts.now ?? Date.now;
  const stampedAt = now();

  let yamlWritten = false;
  let yamlError: Error | null = null;
  let dbError: Error | null = null;

  if (opts.yaml) {
    try {
      await opts.yaml.write(opts.pid);
      yamlWritten = true;
    } catch (err) {
      yamlError = asError(err);
    }
  }

  if (yamlError === null) {
    try {
      await updateDispatch(opts.dispatchId, {
        hostPid: opts.pid,
        hostPidAt: stampedAt,
      });
    } catch (err) {
      dbError = asError(err);
    }
  }

  if (yamlError === null && dbError === null) {
    return;
  }

  // Rollback whichever half succeeded.
  if (yamlWritten && dbError !== null) {
    try {
      await opts.yaml!.clear();
    } catch (rollbackErr) {
      log.error(
        `[${opts.dispatchId}] paired-write YAML rollback failed`,
        rollbackErr,
      );
    }
  }

  // Mark the dispatch failed so reconcile + dashboards see a consistent
  // terminal record. `pidTerminatedAt` is set so the row has a complete
  // lifecycle stamp even though host_pid was never successfully bound.
  try {
    const terminatedAt = now();
    await updateDispatch(opts.dispatchId, {
      status: "failed",
      summary: "Paired host_pid write rolled back",
      completedAt: terminatedAt,
      hostPid: null,
      hostPidAt: null,
      pidTerminatedAt: terminatedAt,
    });
  } catch (markErr) {
    log.error(
      `[${opts.dispatchId}] failed to mark paired-write rollback`,
      markErr,
    );
  }

  throw new PairedHostPidWriteError(
    yamlError !== null
      ? `paired-write rollback (YAML): ${yamlError.message}`
      : `paired-write rollback (DB): ${dbError!.message}`,
    dbError,
    yamlError,
  );
}
