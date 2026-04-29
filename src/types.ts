export interface ThreadState {
  threadTs: string;
  channelId: string;
  sessionId: string | null;
  messages: ThreadMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

export interface AgentLogEntry {
  timestamp: number;
  type: string;
  subtype?: string;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Sub-agent lineage carried on AgentLogEntry.data (and propagated into every
 * emitted EventPayload.data) so gpt-manager can attribute usage to the
 * originating sub-agent within the same dispatch. Set by SessionLogWatcher for
 * entries read from `<parent-session>/subagents/*.jsonl`; absent on parent entries.
 */
export interface AgentLineage {
  subagent_id: string;
  parent_session_id: string | null;
  agent_type: string | undefined;
}

export type ComplexityLevel = "very_low" | "low" | "medium" | "high" | "very_high";

export interface RouterResult {
  quickResponse: string;
  needsAgent: boolean;
  complexity: ComplexityLevel;
  reason: string;
  error: string | null;
  isOperational?: boolean;
  request: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  usage: ApiCallUsage | null;
}

export interface ApiCallUsage {
  source: "router";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface AgentUsageSummary {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  modelUsage: Record<string, ModelUsage>;
}

export interface RepoConfig {
  name: string;
  url: string;
  localPath: string;
  /**
   * Dashboard-mode only: the worker container port used to forward external
   * dispatch requests. Populated from REPO_WORKER_PORTS env var. Absent in
   * worker mode (workerPort lives on RepoContext there).
   */
  workerPort?: number;
  /**
   * Dashboard-mode only: docker hostname override used by the proxy.
   * Populated from REPO_WORKER_HOSTS env var. When undefined the dashboard
   * falls back to `danxbot-worker-<name>` (the per-repo compose default).
   * Set this when the connected repo's compose `container_name` deviates
   * from the default — without it, dispatches to that repo silently 502.
   */
  workerHost?: string;
}

export interface TrelloConfig {
  apiKey: string;
  apiToken: string;
  boardId: string;
  reviewListId: string;
  todoListId: string;
  inProgressListId: string;
  needsHelpListId: string;
  doneListId: string;
  cancelledListId: string;
  actionItemsListId: string;
  bugLabelId: string;
  featureLabelId: string;
  epicLabelId: string;
  needsHelpLabelId: string;
  triagedLabelId?: string;
}

export interface SlackConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  channelId: string;
}

export interface RepoDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  enabled: boolean;
}

export interface RepoContext {
  name: string;
  url: string;
  localPath: string;
  trello: TrelloConfig;
  trelloEnabled: boolean;
  slack: SlackConfig;
  db: RepoDatabaseConfig;
  githubToken: string;
  workerPort: number;
}

export interface AgentResponse {
  text: string;
  sessionId: string | null;
  subscriptionCostUsd: number;
  turns: number;
  config: Record<string, unknown>;
  log: AgentLogEntry[];
  usage: AgentUsageSummary | null;
}
