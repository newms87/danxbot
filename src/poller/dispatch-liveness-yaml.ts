/**
 * YAML-based dispatch liveness check (ISS-92, Phase 2 of the poller-triage
 * rework).
 *
 * Lives outside `src/cron/sync-and-audit.ts` so the test file imports it without
 * dragging in the poller's config-chain load (which hard-requires
 * `DANXBOT_DB_*` at module-import time and breaks standalone unit tests —
 * see `danx-repo-workflow.md` "Isolate pure helpers from src/cron/sync-and-audit.ts").
 *
 * Pure: every input is supplied via `LivenessDeps` so tests can replay
 * arbitrary clock + hostname + isPidAlive states without monkey-patching
 * `node:os` or `node:process`.
 *
 * Sibling of `live-dispatch-guard.ts`. Both answer "is this dispatch
 * still alive" but for different sources of truth: the guard reads the
 * dispatches DB row's `host_pid` to gate the Trello-card pre-claim path
 * (ISS-69); this module reads the YAML's `dispatch{}` block to drive
 * startup reattach and per-tick liveness scans (ISS-92). The two
 * eventually converge but answer different questions on different
 * cadences — the DB guard fires only when a card looks dispatchable,
 * the YAML check fires for every card the poller already considers
 * "occupied" via in-memory `activeDispatches`.
 */

import type { IssueDispatch } from "../issue-tracker/interface.js";

/**
 * Discriminated union describing the liveness verdict on a single
 * `IssueDispatch` record. Callers route on `kind`:
 *
 *  - `alive` — same host, PID still alive, TTL not expired. Card is
 *    occupied; dispatch path skips it.
 *  - `dead-pid` — same host, PID gone (signal 0 returned ESRCH). Agent
 *    exited without clearing the YAML. Caller clears `dispatch: null`.
 *  - `dead-ttl` — TTL expired regardless of PID state. Treated as a
 *    hung dispatch — caller clears + WARN-logs (a still-running PID at
 *    TTL is the only failure mode that produces this branch and the
 *    cleanup path SIGKILLs the orphaned process via the regular
 *    cancellation flow).
 *  - `cross-host` — `dispatch.host` does not match the current host.
 *    Local-only deploys treat this as dead (operator intervention via
 *    the dashboard's Agents tab); multi-host deploys would extend this
 *    branch with a remote heartbeat probe before deciding.
 */
export type LivenessVerdict =
  | { kind: "alive" }
  | { kind: "dead-pid" }
  | { kind: "dead-ttl" }
  | { kind: "cross-host" };

export interface LivenessDeps {
  /** Hostname of the worker running this check. Typically `os.hostname()`. */
  currentHost: string;
  /** Timestamp the check runs at. Typically `Date.now()`. */
  now: number;
  /** Liveness probe — `process.kill(pid, 0)` style ESRCH detector. */
  isPidAlive: (pid: number) => boolean;
}

/**
 * Returns the liveness verdict for an `IssueDispatch` record.
 *
 * Decision order (matters — each branch shadows the next):
 *
 *   1. Empty `host` OR `host !== currentHost` → `cross-host`. Empty is
 *      treated as cross-host because Phase 1 migrated stamped rows with
 *      `host: ""` (no real PID was ever known). The reattach pass
 *      clears these explicitly so Phase 2 produces a clean baseline.
 *   2. TTL expiry — `started_at + ttl_seconds * 1000 < now` → `dead-ttl`.
 *      Runs BEFORE the PID check so a still-running PID past TTL is
 *      surfaced loudly (operator's hint to investigate the hang).
 *      `started_at: ""` and `ttl_seconds: 0` skip the check (Phase 1
 *      placeholder values — fall through to the PID branch).
 *   3. PID liveness — `pid <= 0` is sentinel/legacy (Phase 1 stamped
 *      `pid: 0`); same as a dead PID.
 *   4. Otherwise → `alive`.
 */
export function checkYamlDispatchLiveness(
  dispatch: IssueDispatch,
  deps: LivenessDeps,
): LivenessVerdict {
  if (!dispatch.host || dispatch.host !== deps.currentHost) {
    return { kind: "cross-host" };
  }

  if (dispatch.started_at && dispatch.ttl_seconds > 0) {
    const startedMs = Date.parse(dispatch.started_at);
    if (Number.isFinite(startedMs)) {
      const expiresAt = startedMs + dispatch.ttl_seconds * 1000;
      if (expiresAt < deps.now) {
        return { kind: "dead-ttl" };
      }
    }
  }

  if (dispatch.pid <= 0) {
    return { kind: "dead-pid" };
  }

  if (!deps.isPidAlive(dispatch.pid)) {
    return { kind: "dead-pid" };
  }

  return { kind: "alive" };
}

/**
 * Per-kind TTL defaults.
 *
 *  - `work`: 7200s (2h) — matches `AgentDispatch::MAX_RUNTIME_SECONDS`
 *    in gpt-manager. Most card-processing dispatches finish in 10–30
 *    minutes; the 2h budget covers Epic-split runs that fan out into
 *    phase cards.
 *  - `triage`: 600s (10m) — Phase 4 of ISS-90 made triage a per-card
 *    dispatch (one card per tick via `danx-triage-card`). A single
 *    decision-tree pass typically takes well under a minute; the 10m
 *    cap is the worst-case upper bound for the agent's read +
 *    decision + write turn.
 *  - `recovery`: 1800s (30m) — DX-161 branch-recovery dispatches finish
 *    one in-flight WIP card on the agent's worktree, commit, and exit.
 *    Bounded above by the same logic as triage (a single agent turn) but
 *    given a wider window because the recovery agent may need to rebase,
 *    resolve conflicts, and re-run tests before committing.
 */
export const TTL_SECONDS_BY_KIND: Readonly<Record<IssueDispatch["kind"], number>> = {
  work: 7200,
  triage: 600,
  recovery: 1800,
};

/**
 * Construct the "start stamp" `IssueDispatch` record the poller writes
 * onto a card's YAML BEFORE the spawn returns. `pid: 0` is the
 * sentinel — `checkYamlDispatchLiveness` treats it as `dead-pid` so a
 * crash between the stamp and the post-spawn pid update gets cleared
 * by the next reattach pass instead of leaving a permanent ghost
 * dispatch on disk.
 *
 * Centralized here (alongside `TTL_SECONDS_BY_KIND`) so every spawn
 * site that stamps a fresh dispatch — work primary, orphan resume,
 * triage — uses the identical shape and TTL contract. Any new `kind`
 * gets the same start-stamp guarantees by construction.
 */
export function buildStartStamp(
  dispatchId: string,
  kind: IssueDispatch["kind"],
  host: string,
): IssueDispatch {
  return {
    id: dispatchId,
    pid: 0,
    host,
    kind,
    started_at: new Date().toISOString(),
    ttl_seconds: TTL_SECONDS_BY_KIND[kind],
  };
}
