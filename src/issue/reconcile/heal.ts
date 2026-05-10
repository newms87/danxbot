/**
 * Pure helper for the file-location heal decision. Phase 2 of the
 * Event-Driven Worker epic (DX-215 / DX-217).
 *
 * Given an issue + its current bucket (`open` or `closed`), decide
 * whether the file should be moved to the other bucket and whether the
 * move warrants a `worker:heal` history entry. Pure — no fs, no logger,
 * no `node:fs` import. Returns `null` when the file is in the right
 * bucket already (idempotency).
 *
 * Two directions:
 *
 *  - `open → closed` — issue.status is terminal (`Done` / `Cancelled`)
 *    but the file lives in `open/`. The move is a janitorial fix; no
 *    history entry (DX-147 AC #3: history reflects real state changes,
 *    not filesystem noise).
 *  - `closed → open` — issue.status is non-terminal but the file lives
 *    in `closed/`. The card was once terminal, then drifted back; this
 *    IS a real state delta. Move back AND stamp a `worker:heal`
 *    `status_change` entry attributing the inverse transition. The
 *    `from` field of that entry is inferred from the most recent
 *    terminal `status_change` in `history[]` (or defaults to `Done`
 *    for legacy YAMLs whose history is empty).
 *
 * The orchestrator (`reconcileIssue`) reads the decision and performs
 * the actual write + unlink + history-append inside its mutex. Keeping
 * the decision pure means tests can sweep every (status × currentDir)
 * combination without touching disk.
 */

import type {
  Issue,
  IssueHistoryEntry,
  IssueStatus,
} from "../../issue-tracker/interface.js";

export type IssueBucket = "open" | "closed";

export interface FileMoveDecision {
  /**
   * Where the file should live after this reconcile. Always different
   * from the `currentDir` the caller supplied (otherwise the helper
   * returns `null`).
   */
  targetDir: IssueBucket;
  /**
   * Optional `worker:heal` history entry to append BEFORE the write.
   * Present only on the `closed → open` direction (real state delta);
   * absent on `open → closed` (filesystem-noise fix).
   *
   * `timestamp` is left empty here so the orchestrator can stamp the
   * write-time clock; everything else is fully populated.
   */
  healEntry: IssueHistoryEntry | null;
}

/**
 * Closed/-direction default for the `from` field of the heal-pass
 * `status_change` entry. The card's history is the primary source —
 * the most recent terminal `to` wins. When history is empty (pre-DX-145
 * legacy YAMLs, hand-written test fixtures), fall back to `"Done"` as
 * the more common terminal across the codebase. Either way the field is
 * a definite `IssueStatus`, satisfying `appendHistory`'s `status_change
 * requires from` invariant.
 */
function inferPriorTerminalStatus(
  history: IssueHistoryEntry[],
): IssueStatus {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.event !== "status_change") continue;
    if (entry.to === "Done" || entry.to === "Cancelled") return entry.to;
  }
  return "Done";
}

export function decideFileMove(
  issue: Issue,
  currentDir: IssueBucket,
): FileMoveDecision | null {
  const isTerminal = issue.status === "Done" || issue.status === "Cancelled";

  if (isTerminal && currentDir === "open") {
    // Janitorial fix — no history entry per DX-147 AC #3.
    return { targetDir: "closed", healEntry: null };
  }

  if (!isTerminal && currentDir === "closed") {
    const priorTerminal = inferPriorTerminalStatus(issue.history);
    return {
      targetDir: "open",
      healEntry: {
        timestamp: "",
        actor: "worker:heal",
        event: "status_change",
        from: priorTerminal,
        to: issue.status,
        note: "Healer moved closed → open to match status",
      },
    };
  }

  return null;
}
