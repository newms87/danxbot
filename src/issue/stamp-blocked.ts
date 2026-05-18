/**
 * Stamp `blocked: {at, reason}` on a candidate YAML at
 * `<repo>/.danxbot/issues/open/<id>.yml`.
 *
 * DX-658 (Phase 2 of "Blocked becomes a dispatch gate, not a status",
 * parent epic DX-656) — this stamp is now a pure gate write. `status`,
 * `dispatch`, and `list_name` on the saved YAML are byte-identical to
 * their pre-stamp values. The picker's `blocked?.at != null` filter
 * skips the card while the gate is populated; the card keeps its
 * derived semantic column (Review / In Progress / ToDo / …) and the
 * worker's normal dispatch lifecycle still clears `dispatch` on the
 * terminal save that follows the self-block signal.
 *
 * Single source for the self-block YAML mutation. Two callers:
 *
 *   - `src/worker/prep-verdict-route.ts` (`blocked` verdict from
 *     `danxbot_prep_verdict`).
 *   - `src/worker/dispatch.ts` (`agent_blocked` status from
 *     `danxbot_complete`).
 *
 * Idempotent: re-stamps overwrite the timestamp + reason but never
 * touch any other field. Any pre-existing `waiting_on` /
 * `requires_human` / `conflict_on[]` record is preserved (independent
 * durable gates; not coupled).
 *
 * Throws when the YAML does not exist or fails schema validation —
 * the caller path is responsible for surfacing the error as the right
 * HTTP status (400 vs 500) on the route.
 */
import { existsSync, readFileSync } from "node:fs";
import { issuePath, writeIssue } from "../poller/yaml-lifecycle.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";

export interface StampIssueBlockedInput {
  repoLocalPath: string;
  candidateId: string;
  /** `<PREFIX>` for `parseIssue` validation (e.g. `"DX"`). Required — parseIssue rejects empty. */
  expectedPrefix: string;
  reason: string;
  /**
   * ISO 8601 timestamp string. Caller controls so the same value lands
   * on the row + the YAML. Stored on `Issue.blocked.at` (v10 — renamed
   * from `Issue.blocked.timestamp` in DX-592).
   */
  at: string;
}

// DX-552 — writes go through `writeIssue` so the synchronous DB upsert
// lands in lockstep with the file write. A bare `writeFileSync` leaves
// the DB row stale; the picker's onComplete → loadLocal →
// clearDispatchAndWrite chain in `multi-agent-pick.ts` then reads the
// stale row and writes it back, clobbering this stamp.
export async function stampIssueBlocked({
  repoLocalPath,
  candidateId,
  expectedPrefix,
  reason,
  at,
}: StampIssueBlockedInput): Promise<void> {
  const filePath = issuePath(repoLocalPath, candidateId, "open");
  if (!existsSync(filePath)) {
    throw new Error(
      `candidate YAML not found at ${filePath} — cannot stamp blocked`,
    );
  }
  const issue = parseIssue(readFileSync(filePath, "utf-8"), {
    expectedPrefix,
  });
  const next: Issue = {
    ...issue,
    blocked: { reason, at },
  };
  await writeIssue(repoLocalPath, next);
}
