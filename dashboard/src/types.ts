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

export type { AgentSnapshot, WorkerHealth } from "@backend/dashboard/agents-routes.js";
export type {
  CriticalFailurePayload,
  CriticalFailureSource,
} from "@backend/critical-failure.js";
export type {
  AgentCapability,
  AgentDefaults,
  AgentRecord,
  AgentRecordWithName,
  AgentSchedule,
  Feature,
  FeatureOverride,
  Settings,
  SettingsOverrides,
  SettingsDisplay,
  SettingsDisplaySection,
  SettingsDisplayWorker,
  SettingsMeta,
} from "@backend/settings-file.js";
export type { AgentRosterResponse } from "@backend/dashboard/agents-routes.js";
export type { RepoInfo } from "./api";
export type { RepoDispatchCounts, DispatchCountsByTrigger } from "@backend/dashboard/dispatches-db.js";
export type {
  IssueListItem,
  IssueListChild,
  IssueDetail,
} from "@backend/dashboard/issues-reader.js";
export type {
  Issue,
  IssueStatus,
  IssueType,
  IssueAcItem,
  IssueComment,
  IssueRetro,
  IssueHistoryEntry,
  IssueHistoryEvent,
  WaitingOn,
  Blocked,
} from "@backend/issue-tracker/interface.js";
export type {
  SystemError,
  SystemErrorSource,
  SystemErrorSeverity,
} from "@backend/dashboard/system-errors.js";
