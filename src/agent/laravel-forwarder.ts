/**
 * Laravel Event Forwarder — Batches and POSTs AgentLogEntry events to the Laravel API.
 *
 * Replaces the per-event postProgress/handleStreamEvent in the old launcher.ts.
 * Buffers up to 10 events or 5 seconds, then sends them as a bulk POST.
 *
 * Used by spawnAgent when the eventForwarding option is provided.
 */

import { SessionLogWatcher } from "./session-log-watcher.js";
import type { AgentLogEntry } from "../types.js";

const MAX_TOOL_RESULT_BYTES = 10 * 1024; // 10KB
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 5_000;

export interface EventPayload {
  type: string;
  timestamp: number;
  message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  session_id?: string;
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
 */
export function truncateToolResultContent(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_BYTES) return content;
  return content.slice(0, MAX_TOOL_RESULT_BYTES) + "…[truncated]";
}

/**
 * Report the danxbot_session_id to the status endpoint on init.
 * Fire-and-forget — errors are logged silently.
 */
export async function putSessionId(
  statusUrl: string,
  apiToken: string,
  sessionId: string,
): Promise<void> {
  try {
    await fetch(statusUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ danxbot_session_id: sessionId }),
    });
  } catch {
    // Non-fatal — session ID reporting is best-effort
  }
}

/**
 * Map an AgentLogEntry to zero or more EventPayloads for the bulk events endpoint.
 *
 * One JSONL entry can produce multiple events:
 *   - assistant with text → agent_event
 *   - assistant with tool_use → tool_call
 *   - user/tool_result → tool_result
 *   - system/init → session_init
 */
export function mapEntryToEvents(entry: AgentLogEntry): EventPayload[] {
  const { type, subtype, timestamp, data } = entry;

  if (type === "system" && subtype === "init") {
    return [{
      type: "session_init",
      timestamp,
      session_id: data.session_id as string | undefined,
    }];
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
          timestamp,
          message: block.text as string,
        });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          timestamp,
          tool_name: block.name as string | undefined,
          tool_input: block.input as Record<string, unknown> | undefined,
          tool_use_id: block.id as string | undefined,
        });
      }
    }

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
        timestamp,
        message: truncateToolResultContent(String(b.content ?? "")),
        tool_use_id: b.tool_use_id as string | undefined,
        is_error: Boolean(b.is_error),
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

  async function sendBatch(events: EventPayload[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await fetch(eventsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ events }),
      });
    } catch {
      // Non-fatal — event forwarding is best-effort
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const toSend = batch;
      batch = [];
      sendBatch(toSend);
    }, BATCH_TIMEOUT_MS);
  }

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const toSend = batch;
    batch = [];
    sendBatch(toSend);
  }

  function consume(entry: AgentLogEntry): void {
    // Report session ID to status endpoint on init
    if (entry.type === "system" && entry.subtype === "init" && entry.data.session_id) {
      putSessionId(statusUrl, apiToken, entry.data.session_id as string);
    }

    const events = mapEntryToEvents(entry);
    if (events.length === 0) return;

    batch.push(...events);

    if (batch.length >= BATCH_SIZE) {
      const toSend = batch;
      batch = [];
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      sendBatch(toSend);
    } else {
      scheduleFlush();
    }
  }

  return { consume, flush };
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
