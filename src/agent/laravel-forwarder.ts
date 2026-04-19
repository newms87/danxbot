/**
 * Laravel Event Forwarder — Batches and POSTs AgentLogEntry events to the Laravel API.
 *
 * Produces the nested EventPayload shape expected by gpt-manager's
 * AgentDispatchStatusController::events validator: { type, message?, data? }.
 * Usage payloads are attached to the first emitted event per assistant turn
 * (text → tool_call → dedicated thinking fallback) so per-turn token accounting
 * lands in exactly one UsageEvent.
 *
 * Used by spawnAgent when the eventForwarding option is provided.
 */

import { SessionLogWatcher } from "./session-log-watcher.js";
import type { AgentLineage, AgentLogEntry } from "../types.js";

const MAX_TOOL_RESULT_BYTES = 10 * 1024; // 10KB
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 5_000;

export interface EventPayload {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface StartEventForwardingOptions {
  dir: string;
  dispatchId: string;
  statusUrl: string;
  apiToken: string;
  pollIntervalMs?: number;
}

export interface EventForwardingHandle {
  watcher: SessionLogWatcher;
  flush: () => void;
}

/**
 * Derive the bulk events URL from a status URL.
 * Replaces the trailing /status segment with /events.
 */
export function deriveEventsUrl(statusUrl: string): string {
  return statusUrl.replace(/\/status$/, "/events");
}

/**
 * Truncate tool result content to MAX_TOOL_RESULT_BYTES characters.
 * Non-string input is JSON-stringified first so object tool results are still bounded.
 */
export function truncateToolResultContent(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.length <= MAX_TOOL_RESULT_BYTES) return text;
  return text.slice(0, MAX_TOOL_RESULT_BYTES) + "…[truncated]";
}

/**
 * Extract sub-agent lineage (set by SessionLogWatcher on sub-agent entries)
 * from entry.data, or null if this entry is from the parent stream.
 */
function extractLineage(entry: AgentLogEntry): AgentLineage | null {
  if (entry.data.subagent_id === undefined) return null;
  return {
    subagent_id: entry.data.subagent_id as string,
    parent_session_id:
      (entry.data.parent_session_id as string | null | undefined) ?? null,
    agent_type: entry.data.agent_type as string | undefined,
  };
}

/**
 * Attach `usage` to the correct event per the three-way fallback contract:
 *   1. First `agent_event` (text) — preferred.
 *   2. First `tool_call` if no text blocks exist.
 *   3. Appended `thinking` event if neither text nor tool_use blocks exist.
 *
 * Invariant: when invoked with a non-empty usage, exactly one event in `events`
 * ends up carrying `data.usage` — never zero, never two.
 */
function attachUsageToAssistantEvents(
  events: EventPayload[],
  usage: Record<string, unknown>,
): void {
  const target =
    events.find((e) => e.type === "agent_event") ??
    events.find((e) => e.type === "tool_call");
  if (target) {
    target.data = { ...target.data, usage };
    return;
  }
  events.push({ type: "thinking", data: { usage } });
}

/**
 * Best-effort authed JSON fetch. Non-2xx and network errors are swallowed
 * at this boundary; Phase 3 replaces this with retry + on-disk queue.
 */
async function authedFetch(
  url: string,
  method: "POST" | "PUT",
  body: unknown,
  apiToken: string,
): Promise<void> {
  try {
    await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Non-fatal — forwarding is best-effort until Phase 3.
  }
}

/**
 * Map an AgentLogEntry to zero or more EventPayloads for the bulk events endpoint.
 *
 * One JSONL entry can produce multiple events (an assistant turn with N content
 * blocks produces up to N events plus at most one extra `thinking` event for
 * usage when no text/tool_use blocks were emitted).
 */
export function mapEntryToEvents(entry: AgentLogEntry): EventPayload[] {
  const events = computeEvents(entry);
  const lineage = extractLineage(entry);
  if (lineage) {
    for (const event of events) {
      event.data = {
        ...event.data,
        subagent_id: lineage.subagent_id,
        parent_session_id: lineage.parent_session_id,
        agent_type: lineage.agent_type,
      };
    }
  }
  return events;
}

function computeEvents(entry: AgentLogEntry): EventPayload[] {
  const { type, subtype, data } = entry;

  if (type === "system" && subtype === "init") {
    return [
      {
        type: "session_init",
        data: {
          session_id: data.session_id,
          model: data.model,
          agents: data.tools,
        },
      },
    ];
  }

  if (type === "assistant") {
    const content = Array.isArray(data.content)
      ? (data.content as Record<string, unknown>[])
      : [];
    const events: EventPayload[] = [];

    for (const block of content) {
      if (block.type === "text" && block.text) {
        events.push({
          type: "agent_event",
          message: block.text as string,
        });
      } else if (block.type === "tool_use" && block.name) {
        events.push({
          type: "tool_call",
          message: block.name as string,
          data: {
            tool: block.name,
            tool_use_id: block.id,
            input: block.input,
          },
        });
      }
    }

    const usage = data.usage as Record<string, unknown> | undefined;
    if (usage) attachUsageToAssistantEvents(events, usage);

    return events;
  }

  if (type === "user") {
    const content = Array.isArray(data.content)
      ? (data.content as Record<string, unknown>[])
      : [];
    return content
      .filter((b) => b.type === "tool_result")
      .map((b) => ({
        type: "tool_result",
        data: {
          tool_use_id: b.tool_use_id,
          content: truncateToolResultContent(b.content),
          is_error: Boolean(b.is_error),
        },
      }));
  }

  return [];
}

/**
 * Create a batched consumer that buffers up to BATCH_SIZE events or BATCH_TIMEOUT_MS,
 * then POSTs them as a bulk request to the Laravel events endpoint.
 *
 * Returns `consume` (register as watcher consumer) and `flush` (drain on shutdown).
 */
export function createLaravelForwarder(
  statusUrl: string,
  apiToken: string,
): { consume: (entry: AgentLogEntry) => void; flush: () => void } {
  const eventsUrl = deriveEventsUrl(statusUrl);
  let batch: EventPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function drainAndSend(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (batch.length === 0) return;
    const toSend = batch;
    batch = [];
    authedFetch(eventsUrl, "POST", { events: toSend }, apiToken);
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      drainAndSend();
    }, BATCH_TIMEOUT_MS);
  }

  function putSessionId(sessionId: string): void {
    authedFetch(statusUrl, "PUT", { danxbot_session_id: sessionId }, apiToken);
  }

  function consume(entry: AgentLogEntry): void {
    if (
      entry.type === "system" &&
      entry.subtype === "init" &&
      entry.data.session_id
    ) {
      putSessionId(entry.data.session_id as string);
    }

    const events = mapEntryToEvents(entry);
    if (events.length === 0) return;

    batch.push(...events);

    if (batch.length >= BATCH_SIZE) {
      drainAndSend();
    } else {
      scheduleFlush();
    }
  }

  return { consume, flush: drainAndSend };
}

/**
 * Convenience: creates SessionLogWatcher + forwarder wired together, starts the watcher.
 * Returns the watcher (for inactivity timer hookup) and a flush function.
 */
export function startEventForwarding(
  options: StartEventForwardingOptions,
): EventForwardingHandle {
  const { dir, dispatchId, statusUrl, apiToken, pollIntervalMs } = options;
  const watcher = new SessionLogWatcher({
    cwd: dir,
    sessionDir: dir,
    dispatchId,
    pollIntervalMs,
  });
  const forwarder = createLaravelForwarder(statusUrl, apiToken);
  watcher.onEntry(forwarder.consume);
  watcher.start();
  return { watcher, flush: forwarder.flush };
}
