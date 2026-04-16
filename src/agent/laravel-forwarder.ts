/**
 * Laravel Event Forwarder — Maps AgentLogEntry to EventPayload and POSTs to Laravel.
 *
 * Registered as a SessionLogWatcher consumer, buffers events, and flushes
 * on size threshold (10 events) or time interval (5 seconds).
 */

import { createLogger } from "../logger.js";
import type { AgentLogEntry } from "../types.js";
import {
  SessionLogWatcher,
  type EntryConsumer,
} from "./session-log-watcher.js";

const log = createLogger("laravel-forwarder");

const EVENT_BATCH_SIZE = 10;
const EVENT_BATCH_INTERVAL_MS = 5_000;
const TOOL_RESULT_MAX_CHARS = 10_240;

export interface EventPayload {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Truncate tool_result content to ~10KB.
 * Accepts unknown input and JSON-stringifies non-strings.
 */
export function truncateToolResultContent(content: unknown): string {
  const text = typeof content === "string" ? content : JSON.stringify(content);

  if (text.length > TOOL_RESULT_MAX_CHARS) {
    return (
      text.substring(0, TOOL_RESULT_MAX_CHARS) +
      `... [truncated from ${text.length} bytes]`
    );
  }

  return text;
}

/**
 * Convert an AgentLogEntry to zero or more EventPayload objects.
 *
 * - system/init        → session_init  (data: session_id, model, agents)
 * - assistant text     → agent_event   (message: text; data.usage on first per turn)
 * - assistant tool_use → tool_call     (message: toolName; data.tool_use_id, input, [usage])
 * - user tool_result   → tool_result   (data: tool_use_id, content, is_error)
 * - thinking-only      → thinking      (data.usage, only if usage is present)
 */
export function mapEntryToEvents(entry: AgentLogEntry): EventPayload[] {
  const events: EventPayload[] = [];

  switch (entry.type) {
    case "system": {
      if (entry.subtype === "init") {
        events.push({
          type: "session_init",
          data: {
            session_id: entry.data.session_id,
            model: entry.data.model,
            agents: entry.data.tools,
          },
        });
      }
      break;
    }

    case "assistant": {
      const content = (entry.data.content ?? []) as Record<string, unknown>[];
      const usage = entry.data.usage as Record<string, unknown> | undefined;
      let usageAttached = false;

      for (const block of content) {
        if (block.type === "text" && block.text) {
          const eventData: Record<string, unknown> = {};
          if (usage && !usageAttached) {
            eventData.usage = usage;
            usageAttached = true;
          }
          events.push({
            type: "agent_event",
            message: block.text as string,
            ...(Object.keys(eventData).length > 0 ? { data: eventData } : {}),
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

      // If no text blocks but usage exists, attach to first event (tool_call)
      if (usage && !usageAttached && events.length > 0) {
        events[0].data = { ...events[0].data, usage };
        usageAttached = true;
      }

      // Thinking-only entries with usage → dedicated thinking event
      if (usage && !usageAttached) {
        events.push({ type: "thinking", data: { usage } });
      }
      break;
    }

    case "user": {
      const content = (entry.data.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          events.push({
            type: "tool_result",
            data: {
              tool_use_id: block.tool_use_id,
              content: truncateToolResultContent(block.content),
              is_error: block.is_error || false,
            },
          });
        }
      }
      break;
    }

    // "result" entries have no mapping
  }

  return events;
}

/**
 * Derive the events endpoint URL from the status URL.
 * .../agent-dispatch/{id}/status → .../agent-dispatch/{id}/events
 */
export function deriveEventsUrl(statusUrl: string): string {
  return statusUrl.replace(/\/status$/, "/events");
}

/**
 * PUT the danxbot_session_id to the status endpoint.
 * Non-blocking — best-effort delivery.
 */
async function putSessionId(
  statusUrl: string,
  apiToken: string,
  sessionId: string,
  jobId: string,
): Promise<void> {
  try {
    await fetch(statusUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        status: "running",
        danxbot_session_id: sessionId,
      }),
    });
  } catch (err) {
    log.error(`[Job ${jobId}] Failed to PUT session_id:`, err);
  }
}

/**
 * POST batched events to the dispatch events endpoint.
 * Fire-and-forget — errors are logged but don't affect the agent.
 */
async function postEvents(
  eventsUrl: string,
  apiToken: string,
  events: EventPayload[],
  jobId: string,
): Promise<void> {
  if (events.length === 0) return;

  try {
    const response = await fetch(eventsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ events }),
    });

    if (!response.ok) {
      log.error(`[Job ${jobId}] Event POST failed: HTTP ${response.status}`);
    }
  } catch (err) {
    log.error(`[Job ${jobId}] Event POST error:`, err);
  }
}

export interface LaravelForwarderOptions {
  eventsUrl: string;
  apiToken: string;
  jobId: string;
  /** Status URL for PUT session_id on init. If omitted, session_id is not reported. */
  statusUrl?: string;
}

/**
 * Creates a SessionLogWatcher consumer that forwards events to Laravel.
 * Returns the consumer function and a flush() method for cleanup.
 */
export function createLaravelForwarder(options: LaravelForwarderOptions): {
  consumer: EntryConsumer;
  flush: () => void;
} {
  let buffer: EventPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    postEvents(options.eventsUrl, options.apiToken, batch, options.jobId);
  }

  function push(event: EventPayload): void {
    buffer.push(event);
    if (buffer.length >= EVENT_BATCH_SIZE) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => flush(), EVENT_BATCH_INTERVAL_MS);
    }
  }

  const consumer: EntryConsumer = (entry: AgentLogEntry) => {
    const events = mapEntryToEvents(entry);

    for (const event of events) {
      if (event.type === "session_init" && options.statusUrl) {
        const sessionId = event.data?.session_id as string | undefined;
        if (sessionId) {
          putSessionId(
            options.statusUrl,
            options.apiToken,
            sessionId,
            options.jobId,
          );
        }
      }
      push(event);
    }
  };

  return { consumer, flush };
}

export interface EventForwardingOptions {
  cwd: string;
  statusUrl: string;
  apiToken: string;
  jobId: string;
}

/**
 * Creates a SessionLogWatcher + Laravel forwarder wired together.
 * Returns the watcher and a flush function for final event delivery.
 */
export function startEventForwarding(options: EventForwardingOptions): {
  watcher: SessionLogWatcher;
  flush: () => void;
} {
  const watcher = new SessionLogWatcher({
    cwd: options.cwd,
    pollIntervalMs: 5_000,
    dispatchId: options.jobId,
  });
  const eventsUrl = deriveEventsUrl(options.statusUrl);
  const forwarder = createLaravelForwarder({
    eventsUrl,
    apiToken: options.apiToken,
    jobId: options.jobId,
    statusUrl: options.statusUrl,
  });
  watcher.onEntry(forwarder.consumer);
  watcher.start();
  return { watcher, flush: forwarder.flush };
}
