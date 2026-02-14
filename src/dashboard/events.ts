export interface MessageEvent {
  id: string;
  threadTs: string;
  messageTs: string;
  channelId: string;
  user: string;
  text: string;
  receivedAt: number;
  routerResponseAt: number | null;
  routerResponse: string | null;
  routerNeedsAgent: boolean | null;
  agentResponseAt: number | null;
  agentResponse: string | null;
  agentCostUsd: number | null;
  agentTurns: number | null;
  status: "received" | "routing" | "routed" | "agent_running" | "complete" | "error";
  error: string | null;
  routerRequest: Record<string, unknown> | null;
  routerRawResponse: Record<string, unknown> | null;
  agentConfig: Record<string, unknown> | null;
  agentLog: import("../types.js").AgentLogEntry[] | null;
  feedback: "positive" | "negative" | null;
  responseTs: string | null;
}

const events: MessageEvent[] = [];
const MAX_EVENTS = 500;

type SSEClient = (data: string) => void;
const sseClients: Set<SSEClient> = new Set();

export function createEvent(partial: {
  threadTs: string;
  messageTs: string;
  channelId: string;
  user: string;
  text: string;
}): MessageEvent {
  const event: MessageEvent = {
    id: `${partial.threadTs}-${partial.messageTs}`,
    ...partial,
    receivedAt: Date.now(),
    routerResponseAt: null,
    routerResponse: null,
    routerNeedsAgent: null,
    agentResponseAt: null,
    agentResponse: null,
    agentCostUsd: null,
    agentTurns: null,
    status: "received",
    error: null,
    routerRequest: null,
    routerRawResponse: null,
    agentConfig: null,
    agentLog: null,
    feedback: null,
    responseTs: null,
  };

  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();
  broadcast(event);
  return event;
}

export function updateEvent(
  id: string,
  updates: Partial<MessageEvent>,
): void {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  Object.assign(event, updates);
  broadcast(event);
}

export function getEvents(): MessageEvent[] {
  return events;
}

export function findEventByResponseTs(ts: string): MessageEvent | undefined {
  return events.find((e) => e.responseTs === ts);
}

export function getAnalytics() {
  const completed = events.filter((e) => e.status === "complete");
  const withAgent = completed.filter((e) => e.agentResponseAt !== null);
  const routerOnly = completed.filter((e) => e.agentResponseAt === null);

  const routerTimes = completed
    .filter((e) => e.routerResponseAt)
    .map((e) => e.routerResponseAt! - e.receivedAt);

  const agentTimes = withAgent
    .filter((e) => e.agentResponseAt && e.routerResponseAt)
    .map((e) => e.agentResponseAt! - e.routerResponseAt!);

  const totalTimes = completed
    .map((e) => (e.agentResponseAt || e.routerResponseAt || e.receivedAt) - e.receivedAt);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const totalCost = withAgent.reduce((sum, e) => sum + (e.agentCostUsd || 0), 0);

  const feedbackPositive = events.filter((e) => e.feedback === "positive").length;
  const feedbackNegative = events.filter((e) => e.feedback === "negative").length;
  const feedbackTotal = feedbackPositive + feedbackNegative;

  return {
    totalMessages: events.length,
    completedMessages: completed.length,
    routerOnlyMessages: routerOnly.length,
    agentMessages: withAgent.length,
    avgRouterTimeMs: Math.round(avg(routerTimes)),
    avgAgentTimeMs: Math.round(avg(agentTimes)),
    avgTotalTimeMs: Math.round(avg(totalTimes)),
    totalCostUsd: totalCost,
    errorCount: events.filter((e) => e.status === "error").length,
    feedbackPositive,
    feedbackNegative,
    feedbackRate: completed.length ? feedbackTotal / completed.length : 0,
  };
}

function broadcast(event: MessageEvent): void {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    client(data);
  }
}

export function addSSEClient(client: SSEClient): void {
  sseClients.add(client);
}

export function removeSSEClient(client: SSEClient): void {
  sseClients.delete(client);
}

/**
 * Resets all in-memory state. Exported for test isolation.
 */
export function resetEvents(): void {
  events.length = 0;
  sseClients.clear();
}
