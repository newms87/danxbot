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
