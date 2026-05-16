export type {
  Dispatch,
  DispatchStatus,
  DispatchTriggerMetadata,
  DispatchFilters,
  SlackTriggerMetadata,
  TrelloTriggerMetadata,
  ApiTriggerMetadata,
  TriggerType,
  RuntimeMode,
} from "@backend/dashboard/dispatches.js";

export type {
  JsonlBlock,
  JsonlTotals,
  JsonlReadResult,
  SubagentTimeline,
  UsageTotals,
  UserBlock,
  AssistantTextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  SystemBlock,
  UsageBlock,
} from "@backend/dashboard/jsonl-reader.js";

import type { Dispatch } from "@backend/dashboard/dispatches.js";
import type {
  JsonlBlock,
  JsonlTotals,
} from "@backend/dashboard/jsonl-reader.js";

export interface DispatchDetail {
  dispatch: Dispatch;
  timeline: JsonlBlock[];
  totals: JsonlTotals | null;
}

export type { AgentSnapshot, WorkerHealth } from "@backend/dashboard/agents-list.js";
export type {
  RepoRootSyncError,
  RepoRootSyncReason,
} from "@backend/worker/sync-root-types.js";
export type {
  SyncRootStateEntry,
} from "@backend/dashboard/sync-root-routes.js";
export type {
  CriticalFailurePayload,
  CriticalFailureSource,
} from "@backend/critical-failure.js";
export type {
  AgentBrokenState,
  AgentCapability,
  AgentDefaults,
  AgentEvaluatorStatus,
  AgentRecord,
  AgentRecordWithName,
  AgentSchedule,
  AgentStrikeEntry,
  AgentStrikeTerminalStatus,
  AgentStrikes,
  EffortKnob,
  EffortLevelMapping,
  EffortLevelName,
  Feature,
  FeatureOverride,
  Settings,
  SettingsOverrides,
  SettingsDisplay,
  SettingsDisplaySection,
  SettingsDisplayWorker,
  SettingsMeta,
} from "@backend/settings-file.js";

/**
 * Effort-level canonical name list, redeclared here so the Vue layer
 * doesn't pull the backend module into its runtime bundle. Stays in
 * lockstep with `EFFORT_LEVEL_NAMES` in `src/settings-file.ts` —
 * adding a row is a two-file edit. The order is the ladder rendered
 * by `EffortLevelsSection.vue` and the dropdown in `AgentCard.vue`.
 */
export const EFFORT_LEVEL_NAMES = [
  "min",
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
  "max",
] as const;

export const DEFAULT_AGENT_EFFORT_LEVEL = "medium" as const;
export type {
  AgentRosterEntry,
  AgentRosterResponse,
} from "@backend/dashboard/agents-toggles.js";
export type { AgentBusyOn } from "@backend/dashboard/dispatches-db.js";
export type { RepoInfo } from "./api";
export type { RepoDispatchCounts, DispatchCountsByTrigger } from "@backend/dashboard/dispatches-db.js";
export type {
  IssueListItem,
  IssueListChild,
  IssueListChildAssignment,
  IssueDetail,
} from "@backend/dashboard/issues-reader.js";
export { ISSUE_TYPES, ISSUE_STATUSES } from "@backend/issue-tracker/interface.js";
export type {
  Issue,
  IssueStatus,
  IssueType,
  IssueAcItem,
  IssueComment,
  IssueCopyPayload,
  IssueRetro,
  IssueHistoryEntry,
  IssueHistoryEvent,
  IssueIce,
  IssueTriage,
  IssueTriageHistoryEntry,
  WaitingOn,
  Blocked,
  ConflictOnEntry,
  RequiresHuman,
} from "@backend/issue-tracker/interface.js";
export type {
  IssuePatch,
  RequiresHumanPatchInput,
} from "@backend/dashboard/issue-write.js";
export type {
  SystemError,
  SystemErrorSource,
  SystemErrorSeverity,
} from "@backend/dashboard/system-errors.js";
export type {
  SystemErrorRow,
  SystemErrorRepairRow,
  SystemErrorStatus,
  SystemErrorRepairVerdict,
  SystemErrorSamplePayload,
} from "@backend/system-repair/types.js";
export type { RepairErrorWithAttempts } from "@backend/system-repair/db-reads.js";
export type {
  List,
  ListType,
  ListsFile,
  CreateListInput,
  UpdateListInput,
} from "@backend/lists-types.js";
export { LIST_TYPES } from "@backend/lists-types.js";

/**
 * UI-side ladder ordering for the seven semantic types. Matches the
 * derivation precedence + move-semantics ladder in DX-575's epic body:
 * archived → review → ready → blocked → in_progress → completed → cancelled.
 * Settings UI groups + renders lists in this order so operators see the
 * board top-to-bottom in the same order the board view will render
 * columns left-to-right (Phase 6 / DX-586).
 */
export const LIST_TYPE_LADDER = [
  "archived",
  "review",
  "ready",
  "blocked",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const LIST_TYPE_LABELS: Record<(typeof LIST_TYPE_LADDER)[number], string> = {
  archived: "Backlog",
  review: "Review",
  ready: "Ready",
  blocked: "Blocked",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};
