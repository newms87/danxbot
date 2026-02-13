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

export interface RouterResult {
  quickResponse: string;
  needsAgent: boolean;
  reason: string;
  request: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
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

export interface AgentResponse {
  text: string;
  sessionId: string | null;
  costUsd: number;
  turns: number;
  config: Record<string, unknown>;
  log: AgentLogEntry[];
}
