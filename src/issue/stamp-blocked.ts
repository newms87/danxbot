/**
 * Stamp `status: "Blocked"` + `blocked: {reason, at}` on a
 * candidate YAML at `<repo>/.danxbot/issues/open/<id>.yml`.
 *
 * Single source for the self-block YAML mutation. Two callers:
 *
 *   - `src/worker/prep-verdict-route.ts` (`blocked` verdict from
 *     `danxbot_prep_verdict`).
 *   - `src/worker/dispatch.ts` (`agent_blocked` status from
 *     `danxbot_complete`).
 *
 * The function is idempotent: re-stamps overwrite the timestamp but
 * leave status + reason at the new values. Any pre-existing
 * `waiting_on` record is preserved (independent durable dep-chain
 * note; not coupled to status).
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
    status: "Blocked",
    blocked: { reason, at },
  };
  await writeIssue(repoLocalPath, next);
}
