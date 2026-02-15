import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { persistEventToDb, updateEventInDb, loadEventsFromDb, deleteOldEventsFromDb } from "./events-db.js";
import type { AgentLogEntry, ApiCallUsage, AgentUsageSummary, ComplexityLevel } from "../types.js";

const log = createLogger("events");

export interface MessageEvent {
  id: string;
  threadTs: string;
  messageTs: string;
  channelId: string;
  user: string;
  userName: string | null;
  text: string;
  receivedAt: number;
  routerResponseAt: number | null;
  routerResponse: string | null;
  routerNeedsAgent: boolean | null;
  routerComplexity: ComplexityLevel | null;
  agentResponseAt: number | null;
  agentResponse: string | null;
  subscriptionCostUsd: number | null;
  agentTurns: number | null;
  apiCalls: ApiCallUsage[] | null;
  apiCostUsd: number | null;
  agentUsage: AgentUsageSummary | null;
  status: "received" | "routing" | "routed" | "agent_running" | "complete" | "error";
  error: string | null;
  routerRequest: Record<string, unknown> | null;
  routerRawResponse: Record<string, unknown> | null;
  agentConfig: Record<string, unknown> | null;
  agentLog: AgentLogEntry[] | null;
  agentRetried: boolean;
  feedback: "positive" | "negative" | null;
  responseTs: string | null;
}

export interface AnalyticsSummary {
  totalMessages: number;
  completedMessages: number;
  routerOnlyMessages: number;
  agentMessages: number;
  avgRouterTimeMs: number;
  avgAgentTimeMs: number;
  avgTotalTimeMs: number;
  totalSubscriptionCostUsd: number;
  totalApiCostUsd: number;
  totalCombinedCostUsd: number;
  errorCount: number;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackRate: number;
}

const events: MessageEvent[] = [];
const MAX_EVENTS = 500;

type SSEClient = (data: string) => void;
const sseClients: Set<SSEClient> = new Set();

export async function loadEvents(): Promise<void> {
  const loaded = await loadEventsFromDb(MAX_EVENTS);
  events.splice(0, events.length, ...loaded);
  if (loaded.length > 0) {
    log.info(`Loaded ${events.length} events from database`);
  }
}

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
    userName: null,
    receivedAt: Date.now(),
    routerResponseAt: null,
    routerResponse: null,
    routerNeedsAgent: null,
    routerComplexity: null,
    agentResponseAt: null,
    agentResponse: null,
    subscriptionCostUsd: null,
    agentTurns: null,
    apiCalls: null,
    apiCostUsd: null,
    agentUsage: null,
    status: "received",
    error: null,
    routerRequest: null,
    routerRawResponse: null,
    agentConfig: null,
    agentLog: null,
    agentRetried: false,
    feedback: null,
    responseTs: null,
  };

  events.unshift(event);
  if (events.length > MAX_EVENTS) events.pop();
  broadcast(event);
  persistEventToDb(event).catch((err) => log.error("Failed to persist event to DB", err));
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
  updateEventInDb(id, updates).catch((err) => log.error("Failed to update event in DB", err));
}

export function getEvents(): MessageEvent[] {
  return events;
}

export function findEventByResponseTs(ts: string): MessageEvent | undefined {
  return events.find((e) => e.responseTs === ts);
}

export function getResponseTimeMs(event: MessageEvent): number {
  return (event.agentResponseAt || event.routerResponseAt || event.receivedAt) - event.receivedAt;
}

export function getAnalytics(): AnalyticsSummary {
  const completed = events.filter((e) => e.status === "complete");
  const withAgent = completed.filter((e) => e.agentResponseAt !== null);
  const routerOnly = completed.filter((e) => e.agentResponseAt === null);

  const routerTimes = completed
    .filter((e) => e.routerResponseAt)
    .map((e) => e.routerResponseAt! - e.receivedAt);

  const agentTimes = withAgent
    .filter((e) => e.agentResponseAt && e.routerResponseAt)
    .map((e) => e.agentResponseAt! - e.routerResponseAt!);

  const totalTimes = completed.map((e) => getResponseTimeMs(e));

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const totalSubscriptionCost = withAgent.reduce((sum, e) => sum + (e.subscriptionCostUsd || 0), 0);
  const totalApiCost = completed.reduce((sum, e) => sum + (e.apiCostUsd || 0), 0);

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
    totalSubscriptionCostUsd: totalSubscriptionCost,
    totalApiCostUsd: totalApiCost,
    totalCombinedCostUsd: totalSubscriptionCost + totalApiCost,
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

const EVENTS_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Deletes events older than the configured max age from the database.
 */
export async function cleanupOldEvents(): Promise<void> {
  try {
    const maxAgeMs = config.db.eventsMaxAgeDays * 24 * 60 * 60 * 1000;
    const deleted = await deleteOldEventsFromDb(maxAgeMs);
    if (deleted > 0) {
      log.info(`Cleaned up ${deleted} old event(s) from DB`);
    }
  } catch (error) {
    log.error("Event cleanup error", error);
  }
}

/**
 * Starts the periodic event cleanup.
 * Returns the interval reference for shutdown cleanup.
 */
export function startEventCleanup(): NodeJS.Timeout {
  const interval = setInterval(cleanupOldEvents, EVENTS_CLEANUP_INTERVAL_MS);
  cleanupOldEvents();
  return interval;
}

/**
 * Stops the periodic event cleanup.
 */
export function stopEventCleanup(interval: NodeJS.Timeout): void {
  clearInterval(interval);
}
