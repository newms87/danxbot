/**
 * Type surface for the `reconcileIssue` chokepoint introduced by Phase 1
 * of the Event-Driven Worker epic (DX-215 / DX-216).
 *
 * `reconcileIssue` is the single function every entry point — chokidar
 * watcher, dispatch lifecycle, scheduler, cron audit, Trello inbound
 * hydration — calls when a card's state may have changed. Phase 1 wires
 * the chokepoint without moving any logic out of `runSync`. Steps 1, 2, 4,
 * 5, 6 of the body (load, validate, hash diff, atomic write, await DB
 * mirror) are real; steps 3 (compute derived state), 7 (tracker push),
 * 8 (scheduler poke), 9 (recurse on parent), 10 (recurse on dependents)
 * are TODO stubs filled by Phases 2-4.
 *
 * Splitting the types into their own module keeps `reconcile.ts` tightly
 * focused on the orchestration logic and lets future per-step helpers
 * (`reconcile/parent.ts`, `reconcile/trello.ts`, etc., per the epic) import
 * the result/error shapes without pulling the orchestrator's dependencies.
 */

/**
 * Why this reconcile was invoked. Drives metric tagging + log prefix; the
 * reconcile body itself is identical regardless of trigger.
 *
 *  - `watcher`   — chokidar `add`/`change`/`unlink` event after the DB
 *                  upsert lands (Phase 1 wires this).
 *  - `lifecycle` — dispatch start/stop hooks (Phase 4).
 *  - `scheduler` — picker drained the dispatchable set, asks reconcile to
 *                  re-eval one card (Phase 4).
 *  - `audit`     — slim 1-min cron sweep walking every open YAML to catch
 *                  drift (Phase 5).
 *  - `hydrate`   — Trello inbound brought a brand-new card into the local
 *                  store (Phase 5).
 */
export type ReconcileTrigger =
  | "watcher"
  | "lifecycle"
  | "scheduler"
  | "audit"
  | "hydrate";

export interface ReconcileError {
  /**
   * Step in the reconcile body that produced the error. Free-form string
   * — the orchestrator is the only writer. Useful for log filtering and
   * for the dashboard's `system-errors` surface in later phases.
   */
  step: string;
  message: string;
  /**
   * `true` when the error stopped the reconcile body (validation throw,
   * write failure). `false` when the body continued past the failure
   * (e.g. tracker push retry queued, scheduler poke logged + dropped).
   */
  fatal: boolean;
}

export interface ReconcileFanout {
  /** Parent id we should recurse on (null when this card has no parent). */
  parentId: string | null;
  /** Cards whose `waiting_on.by[]` references this id. */
  dependents: string[];
  /**
   * `true` when this reconcile flipped a field the dispatch scheduler
   * keys on (status, waiting_on, blocked, dispatch). Phase 4 wires this
   * to the scheduler's input edge.
   */
  dispatchableChanged: boolean;
  /**
   * Optional human-readable hint for why the scheduler should re-pick.
   * Carried alongside `dispatchableChanged` for log + observability.
   */
  schedulerPokeReason?: string;
}

export interface ReconcileResult {
  /**
   * `true` when the canonical content hash of the YAML on disk changed
   * during this reconcile (a write happened). `false` for the no-op
   * common case where the input already matches what's on disk.
   */
  changed: boolean;
  /** Content hash before this reconcile, or `null` for a freshly-created file. */
  prevHash: string | null;
  /** Content hash on disk after this reconcile completes. */
  nextHash: string;
  errors: ReconcileError[];
  fanout: ReconcileFanout;
}

/**
 * Thrown from inside `reconcileIssue` when the YAML on disk fails to
 * parse OR violates the strict `Issue` shape. The watcher's wiring point
 * catches this and routes through `recordSystemError({source:
 * "reconcile"})` so the dashboard banner surfaces the bad file. Other
 * triggers (lifecycle, scheduler, audit, hydrate) propagate the error
 * to their callers.
 */
export class ReconcileValidationError extends Error {
  readonly id: string;
  readonly path: string | null;

  constructor(message: string, opts: { id: string; path: string | null }) {
    super(message);
    this.name = "ReconcileValidationError";
    this.id = opts.id;
    this.path = opts.path;
  }
}
