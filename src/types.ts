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

export interface RouterResult {
  quickResponse: string;
  needsAgent: boolean;
  reason: string;
}

export interface AgentResponse {
  text: string;
  sessionId: string | null;
  costUsd: number;
  turns: number;
}
