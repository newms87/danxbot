/**
 * Per-dispatch TTL `setTimeout` — Phase 4b.2 of the Event-Driven Worker
 * epic (DX-289). Replaces the per-tick `evictDeadDispatches` walk in
 * `src/poller/index.ts` with an event-driven timer per dispatch.
 *
 * Contract:
 *   - `armTtlTimer(args)` — schedule expiry for a dispatch's TTL. Called
 *     by `dispatch()` once the dispatch row + YAML `dispatch{}` stamp
 *     are committed. Idempotent — re-arming the same `dispatchId`
 *     clears the prior timer first.
 *   - `rearmTtlTimer(dispatchId, ttlMs)` — clear + re-arm with a fresh
 *     `ttlMs` budget. Called from the launcher's heartbeat tick so a
 *     long-running healthy dispatch never trips the timer.
 *   - `clearTtlTimer(dispatchId)` — terminal-state clear; called from
 *     the dispatch onComplete chain.
 *   - `_clearAllTtlTimers()` — test seam.
 *
 * On expiry:
 *   1. Look up the entry's PID via the injected `isPidAlive` dep.
 *   2. **Live PID** — re-arm a fresh `ttlMs` window. The dispatch is
 *      still doing work; the next heartbeat will re-arm again. Loop
 *      until the PID dies or the dispatch ends naturally.
 *   3. **Dead PID** — clear the YAML's `dispatch{}` field via the
 *      injected `clearDispatch` dep, then call `reconcileIssue(...,
 *      "audit")` so the resulting `DispatchableChanged` fanout re-
 *      offers the card to the scheduler. Drop the in-memory entry.
 *
 * `isPidAlive` + `reconcile` + `clearDispatch` are deps (not module
 * imports) so tests can fake them. Production wires:
 *   - `isPidAlive` from `src/agent/host-pid.ts`.
 *   - `reconcile`  from `src/issue/reconcile.ts`.
 *   - `clearDispatch` from `src/poller/yaml-lifecycle.ts`
 *     (`clearDispatchAndWrite`).
 *
 * Module-scoped Map<dispatchId, ArmedEntry>. Tests use
 * `vi.useFakeTimers()`.
 */

import { createLogger } from "../logger.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";
import type { Issue } from "../issue-tracker/interface.js";

const log = createLogger("ttl-timer");

export type IsPidAliveFn = (pid: number) => boolean;
export type TtlReconcileFn = (
  repo: ReconcileRepoContext,
  id: string,
  trigger: "audit",
) => Promise<ReconcileResult>;
export type ClearDispatchFn = (
  repoLocalPath: string,
  issue: Issue,
) => Promise<Issue>;
export type LoadIssueFn = (
  repoLocalPath: string,
  cardId: string,
  issuePrefix: string,
) => Promise<Issue | null>;

export interface TtlTimerDeps {
  isPidAlive: IsPidAliveFn;
  reconcile: TtlReconcileFn;
  clearDispatch: ClearDispatchFn;
  loadIssue: LoadIssueFn;
}

export interface ArmTtlTimerArgs {
  dispatchId: string;
  repo: ReconcileRepoContext;
  cardId: string;
  /** Dispatch PID — `pid > 0` once the spawn pid update lands. `0` is the
   *  pre-spawn sentinel; the timer treats `0` as "not yet alive" and
   *  defers the dead-PID branch until the next re-arm sees a real PID. */
  pid: number;
  ttlMs: number;
  deps: TtlTimerDeps;
}

interface ArmedEntry {
  timer: NodeJS.Timeout;
  args: ArmTtlTimerArgs;
}

const armed = new Map<string, ArmedEntry>();

/**
 * Arm (or re-arm) the TTL timer for a dispatch. Clears any existing
 * timer for the same `dispatchId` before scheduling the fresh one.
 *
 * `ttlMs` is the absolute window — the timer fires `ttlMs` after the
 * call, regardless of when the dispatch started. Heartbeat re-arms
 * call `rearmTtlTimer` to push this window forward.
 */
export function armTtlTimer(args: ArmTtlTimerArgs): void {
  const { dispatchId, ttlMs } = args;
  const prior = armed.get(dispatchId);
  if (prior) {
    clearTimeout(prior.timer);
  }
  const delayMs = Math.max(0, ttlMs);
  const timer = setTimeout(() => {
    void handleExpiry(dispatchId);
  }, delayMs);
  armed.set(dispatchId, { timer, args });
}

/**
 * Re-arm the timer for an already-armed dispatch using its prior
 * arming args + a fresh `ttlMs`. Called from the launcher's heartbeat
 * tick. Silent no-op when no timer is armed (the heartbeat may fire
 * once after the terminal-state cleanup cleared it).
 */
export function rearmTtlTimer(dispatchId: string, ttlMs: number): void {
  const prior = armed.get(dispatchId);
  if (!prior) return;
  armTtlTimer({ ...prior.args, ttlMs });
}

/**
 * Clear the timer for a dispatch. Idempotent — silent no-op when no
 * timer is armed. Called from the dispatch onComplete chain.
 */
export function clearTtlTimer(dispatchId: string): void {
  const prior = armed.get(dispatchId);
  if (prior) {
    clearTimeout(prior.timer);
    armed.delete(dispatchId);
  }
}

/** Visible for tests. */
export function _isTtlTimerArmed(dispatchId: string): boolean {
  return armed.has(dispatchId);
}

/** Visible for tests — read the armed entry's ttlMs target. */
export function _getTtlTimerArgs(
  dispatchId: string,
): ArmTtlTimerArgs | undefined {
  return armed.get(dispatchId)?.args;
}

/** Test seam — drain every armed timer. */
export function _clearAllTtlTimers(): void {
  for (const entry of armed.values()) {
    clearTimeout(entry.timer);
  }
  armed.clear();
}

/**
 * Expiry handler. Drops the in-memory entry FIRST so a re-arm during
 * the await chain (rare) does not race the cleanup. Then:
 *
 *  - `pid > 0 && isPidAlive(pid)` → re-arm with the same `ttlMs`
 *    window. The dispatch is still doing work; if its heartbeat is
 *    healthy, the next heartbeat will re-arm too — this branch is
 *    the safety net for when the heartbeat stops firing but the
 *    process is still alive.
 *  - `pid === 0` (pre-spawn sentinel) — treat as live, re-arm. The
 *    spawn pid update happens within seconds of `dispatch()`
 *    returning; a TTL fire at pid=0 means the timer was armed
 *    with `ttlMs === 0` or very small, almost certainly a test.
 *  - `pid > 0 && !isPidAlive(pid)` → dead. Clear the YAML's
 *    `dispatch{}` field, then audit-reconcile so the scheduler is
 *    poked to re-offer the card.
 */
async function handleExpiry(dispatchId: string): Promise<void> {
  const entry = armed.get(dispatchId);
  if (!entry) return;
  armed.delete(dispatchId);

  const { args } = entry;
  const { repo, cardId, pid, ttlMs, deps } = args;

  if (pid === 0 || deps.isPidAlive(pid)) {
    // Live (or pre-spawn) — re-arm a fresh window. Heartbeat will
    // typically have re-armed already; this is the failsafe.
    armTtlTimer({ ...args, ttlMs });
    return;
  }

  // Dead PID — clear the dispatch stamp on disk so the next reconcile
  // re-derives dispatch-eligibility without the stale `dispatch{}` block.
  let issue: Issue | null;
  try {
    issue = await deps.loadIssue(repo.localPath, cardId, repo.issuePrefix);
  } catch (err) {
    log.warn(
      `[${repo.name}] ttl-timer expiry: failed to load ${cardId} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!issue) {
    // YAML is gone (operator deleted, archive). Nothing to clear.
    return;
  }
  try {
    await deps.clearDispatch(repo.localPath, issue);
  } catch (err) {
    log.warn(
      `[${repo.name}] ttl-timer expiry: clearDispatch failed for ${cardId} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  // Audit reconcile — re-derive state + poke the scheduler.
  try {
    await deps.reconcile(repo, cardId, "audit");
  } catch (err) {
    log.warn(
      `[${repo.name}] ttl-timer expiry: audit reconcile failed for ${cardId} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  log.info(
    `[${repo.name}] ttl-timer expiry: cleared dispatch ${dispatchId} on ${cardId} (pid ${pid} dead)`,
  );
}
