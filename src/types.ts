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

export type ComplexityLevel = "very_low" | "low" | "medium" | "high" | "very_high";

export interface ComplexityProfile {
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  maxThinkingTokens: number;
  systemPrompt: "fast" | "full";
}

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

export interface HeartbeatUpdate {
  emoji: string;
  color: string;
  text: string;
  stop: boolean;
}

export interface HeartbeatSnapshot {
  activitySummary: string;
  update: HeartbeatUpdate;
}

export interface TimestampedHeartbeatSnapshot extends HeartbeatSnapshot {
  timestamp: number;
}

export interface ApiCallUsage {
  source: "router" | "heartbeat";
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
