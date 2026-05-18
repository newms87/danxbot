/**
 * DX-584 (Phase 4 of DX-575 — Computed card state) — single auto-resolve
 * write path for `Issue.list_name`. Workers never READ `.list_name`
 * (the static guard in `src/__tests__/no-list-name-reads.test.ts`
 * pins that contract); the field is a denormalized projection
 * computed from the card's derived semantic state at the moment of
 * each lifecycle transition.
 *
 * Two helpers ship here:
 *
 *  - `resolveListNameForType(repoLocalPath, type)` — wraps
 *    `getDefaultListForType` from `src/lists-file.ts` and returns the
 *    default list's NAME for the given semantic type. The lists.yaml
 *    file is the operator-owned source of truth — its 7-default seed
 *    (Backlog/Review/To Do/Blocked/In Progress/Done/Cancelled) maps
 *    1:1 to the `ListType` enum, and `ensureListsFile` plants the
 *    seed on first boot so this lookup is hot-path safe.
 *
 *  - `deriveListTypeFromSemanticStatus(status)` — small enum map from
 *    the derived semantic `IssueStatus` (Backlog/Review/ToDo/In Progress/
 *    Done/Cancelled) to the lists.yaml `ListType` enum
 *    (archived/review/ready/in_progress/completed/cancelled). Pure
 *    function; the worker calls it when it needs to recompute
 *    `list_name` from the card's derived state. DX-658 / Phase 2 of
 *    "Blocked becomes a dispatch gate, not a status" retired both the
 *    `"Blocked"` IssueStatus and the `"blocked"` ListType, so this
 *    function now totals over 6 values on each side.
 *
 * Together these support the three transitional writes Phase 4 introduces:
 *   - dispatch start (auto-flip):   `in_progress` list
 *   - terminal completed:           `completed` list
 *   - terminal cancelled / failed:  `cancelled` list
 *
 * The exact name resolution is per-repo because operators may rename
 * lists (e.g. "Backlog" → "Icebox"). `resolveListNameForType` always
 * reads the current file rather than caching at module init.
 */

import { getDefaultListForType, type ListType } from "../lists-file.js";
import type { IssueStatus } from "../issue-tracker/interface.js";

export function resolveListNameForType(
  repoLocalPath: string,
  type: ListType,
): string {
  return getDefaultListForType(repoLocalPath, type).name;
}

/**
 * Map the derived `IssueStatus` (the semantic enum the worker reads via
 * `deriveStatus`) to the `ListType` enum the lists.yaml file uses.
 * Total: every `IssueStatus` value maps to exactly one `ListType`.
 *
 * Lockstep contract (DX-639): mirrored byte-identically in
 * `dashboard/src/composables/derive-status.ts#deriveListTypeFromStatus`
 * — the SPA cannot import this module (browser bundle), so the switch
 * is duplicated. Any change to the mapping MUST land on BOTH sides in
 * the same commit. TypeScript catches additions to the `IssueStatus`
 * enum (exhaustive switch becomes a compile error on either side);
 * silent mapping changes have no compile guard, hence this comment.
 */
export function deriveListTypeFromSemanticStatus(
  status: IssueStatus,
): ListType {
  switch (status) {
    case "Backlog":
      return "archived";
    case "Review":
      return "review";
    case "ToDo":
      return "ready";
    case "In Progress":
      return "in_progress";
    case "Done":
      return "completed";
    case "Cancelled":
      return "cancelled";
  }
}
