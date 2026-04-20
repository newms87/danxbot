export type TriggerType = "slack" | "trello" | "api";

export type DispatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeMode = "docker" | "host";

export interface SlackTriggerMetadata {
  channelId: string;
  threadTs: string;
  messageTs: string;
  user: string;
  userName: string | null;
  messageText: string;
}

export interface TrelloTriggerMetadata {
  cardId: string;
  cardName: string;
  cardUrl: string;
  listId: string;
  listName: string;
}

export interface ApiTriggerMetadata {
  endpoint: string;
  callerIp: string | null;
  statusUrl: string | null;
  initialPrompt: string;
}

export type DispatchTriggerMetadata =
  | { trigger: "slack"; metadata: SlackTriggerMetadata }
  | { trigger: "trello"; metadata: TrelloTriggerMetadata }
  | { trigger: "api"; metadata: ApiTriggerMetadata };

export interface DispatchUsage {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCallCount: number;
  subagentCount: number;
  nudgeCount: number;
}

export interface Dispatch {
  id: string;
  repoName: string;
  trigger: TriggerType;
  triggerMetadata:
    | SlackTriggerMetadata
    | TrelloTriggerMetadata
    | ApiTriggerMetadata;
  sessionUuid: string | null;
  jsonlPath: string | null;
  /**
   * Dispatch ID of the parent job when this dispatch was spawned via
   * `POST /api/resume`. Null for regular launches. Lets callers walk the
   * resume chain without scanning JSONL files.
   */
  parentJobId: string | null;
  status: DispatchStatus;
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
  runtimeMode: RuntimeMode;
  tokensTotal: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  toolCallCount: number;
  subagentCount: number;
  nudgeCount: number;
  danxbotCommit: string | null;
}

export interface DispatchFilters {
  trigger?: TriggerType;
  repo?: string;
  status?: DispatchStatus;
  since?: number;
  q?: string;
}

/** Terminal statuses — a row is "done" and safe to purge under retention. */
export const TERMINAL_STATUSES: readonly DispatchStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminalStatus(status: DispatchStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
