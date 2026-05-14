/**
 * Stamp `status: "Blocked"` + `blocked: {reason, timestamp}` on a
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { issuePath } from "../poller/yaml-lifecycle.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";

export interface StampIssueBlockedInput {
  repoLocalPath: string;
  candidateId: string;
  /** `<PREFIX>` for `parseIssue` validation (e.g. `"DX"`). Required — parseIssue rejects empty. */
  expectedPrefix: string;
  reason: string;
  /** ISO 8601 timestamp string. Caller controls so the same value lands on the row + the YAML. */
  timestamp: string;
}

export function stampIssueBlocked({
  repoLocalPath,
  candidateId,
  expectedPrefix,
  reason,
  timestamp,
}: StampIssueBlockedInput): void {
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
    blocked: { reason, timestamp },
  };
  writeFileSync(filePath, serializeIssue(next));
}
