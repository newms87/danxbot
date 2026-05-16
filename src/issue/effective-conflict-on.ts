/**
 * Effective `conflict_on` derivation. Single source of truth for "is
 * this issue's dispatch gated by an active conflict partner?" —
 * consumed by the poller's dispatch filter and the dashboard reader.
 *
 * Two-way semantics. A candidate is "effectively conflicted" iff at
 * least one of:
 *   (a) some entry in `issue.conflict_on[]` points at a card that is
 *       currently In Progress, OR
 *   (b) some OTHER open card has THIS issue's id in ITS
 *       `conflict_on[]` AND is currently In Progress.
 *
 * The single declaration on either side is enough — symmetric
 * enforcement so an agent declaring "I conflict with DX-N" doesn't
 * also have to mutate DX-N's YAML.
 *
 * Terminal partners (Done / Cancelled) are ignored — the conflict
 * record on disk is a durable audit trail, but the dispatch gate auto-
 * opens the moment a partner reaches terminal. Missing partners (id
 * doesn't resolve in the supplied `byId` map) are ALSO ignored: the
 * partner may have been hard-deleted; nothing to gate against.
 *
 * Distinct from `effectiveWaitingOn`:
 *   - waiting_on: one-way precedence (A consumes B's output, A waits
 *     for B to be terminal). Terminal partner unblocks A.
 *   - conflict_on: two-way mutual exclusion (A and B cannot be
 *     concurrently In Progress). The In Progress partner blocks the
 *     ToDo partner from dispatch this tick; the next time both are
 *     not-In-Progress, both are eligible.
 */

import type { ConflictOnEntry, Issue } from "../issue-tracker/interface.js";
import { deriveStatus } from "./derive-status.js";

export interface EffectiveConflictReport {
  /** Forward direction — entries from THIS issue's `conflict_on[]`
   *  whose partner is currently In Progress. */
  forward: readonly ConflictOnEntry[];
  /** Reverse direction — entries from OTHER open issues' `conflict_on[]`
   *  pointing at THIS issue, where the OTHER issue is In Progress.
   *  The `id` field is the OTHER issue's id; `reason` is whatever the
   *  other issue declared. */
  reverse: readonly ConflictOnEntry[];
}

/**
 * Compute the effective conflict report for `issue` against the supplied
 * `allOpen` set. Pure — no I/O. Caller responsible for sourcing the open
 * set; the dispatch filter passes the same set it uses for
 * `effectiveWaitingOn`.
 */
export function effectiveConflictOn(
  issue: Issue,
  allOpen: readonly Issue[],
): EffectiveConflictReport {
  const byId = new Map<string, Issue>();
  for (const i of allOpen) byId.set(i.id, i);

  // DX-584 (Phase 4) — partner gates on derived semantic state, not
  // raw `status`. A terminal-stamped partner (completed_at / cancelled_at
  // / blocked.at set) derives to its terminal state even if the raw
  // status still says "In Progress"; the conflict gate clears as soon
  // as the partner's lifecycle truly ended.
  const forward: ConflictOnEntry[] = [];
  for (const entry of issue.conflict_on) {
    if (entry.id === issue.id) continue; // self-ref guard
    const partner = byId.get(entry.id);
    if (!partner) continue; // missing / hard-deleted
    if (deriveStatus(partner) === "In Progress") {
      forward.push(entry);
    }
  }

  const reverse: ConflictOnEntry[] = [];
  for (const other of allOpen) {
    if (other.id === issue.id) continue;
    if (deriveStatus(other) !== "In Progress") continue;
    for (const entry of other.conflict_on) {
      if (entry.id === issue.id) {
        // Surface the OTHER issue's id (the live blocker), not the
        // entry's id (which IS this issue). reason carries forward.
        reverse.push({ id: other.id, reason: entry.reason });
        break; // one entry per partner; dedup
      }
    }
  }

  return { forward, reverse };
}

/**
 * Convenience boolean: is this issue blocked by ANY active conflict
 * partner? True iff `forward.length + reverse.length > 0`. Equivalent
 * to "the poller must skip this card this tick on the conflict_on
 * gate."
 */
export function isEffectivelyConflicted(
  issue: Issue,
  allOpen: readonly Issue[],
): boolean {
  const r = effectiveConflictOn(issue, allOpen);
  return r.forward.length > 0 || r.reverse.length > 0;
}
