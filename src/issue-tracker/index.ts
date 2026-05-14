import type { TrelloConfig } from "../types.js";
import type { IssueTracker } from "./interface.js";
import { MemoryTracker } from "./memory.js";
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
export { MemoryTracker } from "./memory.js";
export type { RequestLogEntry } from "./memory.js";
export { TrelloTracker } from "./trello.js";

/**
 * Value of `DANXBOT_TRACKER` that switches `createIssueTracker` to the
 * in-memory implementation. Exposed as a constant so tests reference the
 * same source of truth as the production code path.
 */
export const MEMORY_TRACKER_ENV_VALUE = "memory";

/**
 * Build the active IssueTracker for a worker.
 *
 * - `DANXBOT_TRACKER === MEMORY_TRACKER_ENV_VALUE` always wins (used by
 *   tests + dev loops to bypass the real tracker entirely).
 * - Otherwise, returns TrelloTracker when TrelloConfig is provided.
 * - Returns `null` when neither path applies — the worker boots in
 *   YAML-only mode. Local-only state (chokidar mirror, reconcile derive,
 *   audit pass, dispatch scheduler) all still run; tracker-touching
 *   stages skip cleanly via callsite null-checks. See DX-341 epic.
 */
export function createIssueTracker(ctx: { trello: TrelloConfig | null }): IssueTracker | null {
  if (process.env.DANXBOT_TRACKER === MEMORY_TRACKER_ENV_VALUE) {
    return new MemoryTracker();
  }
  if (ctx.trello) {
    return new TrelloTracker(ctx.trello);
  }
  return null;
}
