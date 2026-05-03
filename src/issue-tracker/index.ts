import type { TrelloConfig } from "../types.js";
import type { IssueTracker } from "./interface.js";
import { MemoryTracker } from "./memory.js";
import { TrelloTracker } from "./trello.js";

export type {
  Issue,
  IssueAcItem,
  IssueComment,
  IssuePhase,
  IssueRef,
  IssueRetro,
  IssueStatus,
  IssueTracker,
  IssueTriaged,
  IssueType,
  PhaseStatus,
  CreateCardInput,
} from "./interface.js";
export { ISSUE_STATUSES, ISSUE_TYPES, PHASE_STATUSES } from "./interface.js";
export { IssueParseError, ISSUE_ID_REGEX, createEmptyIssue, parseIssue, serializeIssue, validateIssue } from "./yaml.js";
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
 * - Otherwise, requires a TrelloConfig and returns TrelloTracker.
 * - Throws if neither path applies — failing loud beats a silent fallback
 *   that would surface only when an agent action hits the network.
 */
export function createIssueTracker(ctx: { trello: TrelloConfig | null }): IssueTracker {
  if (process.env.DANXBOT_TRACKER === MEMORY_TRACKER_ENV_VALUE) {
    return new MemoryTracker();
  }
  if (ctx.trello) {
    return new TrelloTracker(ctx.trello);
  }
  throw new Error(
    "createIssueTracker: no tracker available — set DANXBOT_TRACKER=memory or provide a TrelloConfig",
  );
}
