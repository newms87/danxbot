import type { TrelloConfig } from "../types.js";
import type { IssueTracker } from "./interface.js";
import { TrelloTracker } from "./trello.js";

export type {
  Issue,
  IssueAcItem,
  IssueComment,
  IssueDispatch,
  IssueIce,
  IssueRef,
  IssueRetro,
  IssueStatus,
  IssueTracker,
  IssueTriage,
  IssueTriageHistoryEntry,
  IssueType,
  CreateCardInput,
} from "./interface.js";
export { ISSUE_STATUSES, ISSUE_TYPES } from "./interface.js";
export {
  IssueParseError,
  ISSUE_PREFIX_SHAPE,
  buildIssueIdRegex,
  createEmptyIssue,
  parseIssue,
  serializeIssue,
  validateIssue,
} from "./yaml.js";
export type { ParseIssueOptions } from "./yaml.js";
export { maxIssueNumber, nextIssueId } from "./id-generator.js";
export { syncIssue } from "./sync.js";
export { TrelloTracker } from "./trello.js";

let warnedLegacyMemoryEnv = false;

/**
 * Build the active IssueTracker for a worker.
 *
 * - Returns a `TrelloTracker` when a `TrelloConfig` is provided.
 * - Returns `null` when no Trello config is provided — the worker
 *   boots in YAML-only mode (DX-342). Local-only state (chokidar
 *   mirror, reconcile derive, audit pass, dispatch scheduler) all
 *   still run; tracker-touching stages skip cleanly via callsite
 *   null-checks.
 *
 * DX-343 retired the `DANXBOT_TRACKER=memory` test-only branch. If
 * the legacy env var is still set in an operator's `.env` we ignore
 * it and emit a one-shot deprecation warn so the operator notices and
 * removes it. The var has no other supported value.
 */
export function createIssueTracker(ctx: { trello: TrelloConfig | null }): IssueTracker | null {
  if (process.env.DANXBOT_TRACKER === "memory" && !warnedLegacyMemoryEnv) {
    warnedLegacyMemoryEnv = true;
    console.warn(
      "DANXBOT_TRACKER=memory is retired (DX-343); ignoring. Remove the env var from your .env to silence this warning.",
    );
  }
  if (ctx.trello) {
    return new TrelloTracker(ctx.trello);
  }
  return null;
}

/**
 * Test-only — reset the one-shot DX-343 deprecation warn latch so
 * suites that exercise the legacy-env branch can assert the warn
 * fires fresh. Production code never calls this. Naming matches the
 * existing reset hooks in `circuit-breaker.ts` + `settings-file.ts`.
 */
export function _resetForTesting(): void {
  warnedLegacyMemoryEnv = false;
}

/**
 * DX-346 — operator-facing boot log line per repo. Format matches the
 * AC verbatim so multi-repo deployments can confirm the active tracker
 * mode at a glance from worker logs. Pure helper so tests pin the
 * string shape without spinning up the worker boot stack.
 *
 * Takes the `TrelloConfig | null` directly so the helper cannot be
 * called with a mismatched (null tracker + non-empty boardId) combo
 * — the boardId lives on the same object that signals mode.
 */
export function formatTrackerBootLog(
  repoName: string,
  trello: TrelloConfig | null,
): string {
  if (trello !== null) {
    return `[${repoName}] Tracker: trello (board ${trello.boardId})`;
  }
  return `[${repoName}] Tracker: none — YAML-only mode`;
}
