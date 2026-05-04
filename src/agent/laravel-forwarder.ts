/**
 * Laravel Event Forwarder — Batches and POSTs AgentLogEntry events to the Laravel API.
 *
 * Produces the nested EventPayload shape expected by gpt-manager's
 * AgentDispatchStatusController::events validator: { type, message?, data? }.
 * Usage payloads are attached to the first emitted event per assistant turn
 * (text → tool_call → dedicated thinking fallback) so per-turn token accounting
 * lands in exactly one UsageEvent.
 *
 * Durable delivery (Phase 3): every batch is persisted to a per-dispatch
 * on-disk queue before the HTTP send attempt. Transient gpt-manager outages
 * trigger exponential-backoff retry; after retries are exhausted, the batch
 * stays queued for future drainage. Worker restarts replay any pending files
 * via replayQueueOnBoot. 4xx responses are logged at ERROR and dropped — they
 * indicate a schema drift, not a transient failure.
 *
 * Used by spawnAgent when the eventForwarding option is provided.
 */

import { join } from "node:path";
import { EventQueue } from "./event-queue.js";
import { createLogger } from "../logger.js";
import { SessionLogWatcher } from "./session-log-watcher.js";
import type { AgentLineage, AgentLogEntry } from "../types.js";

const log = createLogger("laravel-forwarder");

const MAX_TOOL_RESULT_BYTES = 10 * 1024; // 10KB
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 5_000;

/** Exponential backoff delays for retryable failures: 1s, 2s, 4s, 8s, 16s, 30s. */
export const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface EventPayload {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface CreateLaravelForwarderOptions {
  /** Durable on-disk queue. When provided, batches are persisted before the send attempt. */
  queue?: EventQueue;
  /** Override retry backoff delays. Used by tests for fast iteration. */
  retryDelaysMs?: number[];
}

export interface StartEventForwardingOptions {
  dir: string;
  dispatchId: string;
  statusUrl: string;
  apiToken: string;
  pollIntervalMs?: number;
  /** Root directory for queue files: `<queueBaseDir>/<dispatchId>.jsonl`. */
  queueBaseDir?: string;
  /** Override retry backoff delays. */
  retryDelaysMs?: number[];
}

export interface EventForwardingHandle {
  watcher: SessionLogWatcher;
  flush: () => Promise<void>;
}

/** Derive the queue file path for a dispatch. */
export function deriveQueuePath(baseDir: string, dispatchId: string): string {
  return join(baseDir, `${dispatchId}.jsonl`);
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
 * Best-effort authed JSON fetch for non-retried calls (e.g. putSessionId).
 * Swallows all errors — session_id reporting is purely informational.
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
    // Non-fatal — session_id PUT is informational
  }
}

/**
 * POST a batch of events to gpt-manager with exponential-backoff retry on
 * 5xx and network errors. Returns:
 *   - "ok": 2xx response, batch delivered.
 *   - "client-error": 4xx response, logged at ERROR and dropped.
 *   - "retry-later": all retry attempts exhausted; caller should leave the
 *     batch in the durable queue for a future attempt.
 */
export async function postEventsWithRetry(
  eventsUrl: string,
  events: EventPayload[],
  apiToken: string,
  delaysMs: number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<"ok" | "client-error" | "retry-later"> {
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, delaysMs[attempt - 1]),
      );
    }
    try {
      const response = await fetch(eventsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ events }),
      });
      if (response.ok) return "ok";
      if (response.status >= 400 && response.status < 500) {
        log.error(
          `Events endpoint returned ${response.status} — dropping batch (schema drift or auth failure).`,
        );
        return "client-error";
      }
      // 5xx — retry
    } catch {
      // Network error — retry
    }
  }
  return "retry-later";
}

/**
 * Drain the queue in FIFO order. Stops on the first retry-later result so the
 * remaining batches keep their order on the next drain pass. Truncates the
 * queue when everything is delivered (or dropped via client-error).
 */
export async function drainQueue(
  queue: EventQueue,
  eventsUrl: string,
  apiToken: string,
  delaysMs?: number[],
): Promise<void> {
  const pending = await queue.peekAll();
  if (pending.length === 0) return;

  let firstFailedIdx = -1;
  for (let i = 0; i < pending.length; i++) {
    const result = await postEventsWithRetry(
      eventsUrl,
      pending[i],
      apiToken,
      delaysMs,
    );
    if (result === "retry-later") {
      firstFailedIdx = i;
      break;
    }
  }

  if (firstFailedIdx === -1) {
    await queue.clear();
  } else {
    await queue.retain(pending.slice(firstFailedIdx));
  }
}

/**
 * Map an AgentLogEntry to zero or more EventPayloads for the bulk events endpoint.
 * Sub-agent lineage on `entry.data` propagates into every emitted event's `data`.
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
 * When a queue is supplied, batches are persisted to disk BEFORE the send
 * attempt and drained in FIFO order with retry. Without a queue, batches are
 * sent fire-and-forget with the same retry behavior but no crash safety.
 */
export function createLaravelForwarder(
  statusUrl: string,
  apiToken: string,
  options: CreateLaravelForwarderOptions = {},
): { consume: (entry: AgentLogEntry) => void; flush: () => Promise<void> } {
  const eventsUrl = deriveEventsUrl(statusUrl);
  const { queue, retryDelaysMs } = options;
  let batch: EventPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function putSessionId(sessionId: string): void {
    void authedFetch(
      statusUrl,
      "PUT",
      { danxbot_session_id: sessionId },
      apiToken,
    );
  }

  async function drainAndSend(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const toSend = batch;
    batch = [];

    // Swallow filesystem / network errors at the source so the two
    // fire-and-forget callers (`void drainAndSend()` in `consume()` /
    // `scheduleFlush`'s setTimeout) and the cleanup path's
    // `void forwarderFlush?.()` (launcher.ts) never produce unhandled
    // rejections. The most common failure here is ENOENT from
    // `queue.enqueue` → `appendFile` when the queue's containing
    // directory is removed mid-flush — happens in tests with mkdtemp +
    // rmSync teardown, but could also happen in production if a log
    // reaper races the worker. Best-effort delivery: lost events are
    // acceptable, an unhandled rejection that crashes vitest (or the
    // worker) is not.
    try {
      if (queue) {
        if (toSend.length > 0) await queue.enqueue(toSend);
        await drainQueue(queue, eventsUrl, apiToken, retryDelaysMs);
        return;
      }

      // No queue: postEventsWithRetry's inner try/catch absorbs network
      // errors and returns "retry-later" instead of throwing, so a throw
      // out of this branch is unreachable in practice. The outer
      // try/catch is defense-in-depth against a future refactor that
      // drops postEventsWithRetry's catch.
      if (toSend.length === 0) return;
      await postEventsWithRetry(eventsUrl, toSend, apiToken, retryDelaysMs);
    } catch (err) {
      log.warn(
        `Drain failed; events for this batch were not delivered: ${
          (err as Error).message
        }`,
      );
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drainAndSend();
    }, BATCH_TIMEOUT_MS);
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
      void drainAndSend();
    } else {
      scheduleFlush();
    }
  }

  return { consume, flush: drainAndSend };
}

/**
 * Replay any pending events in a dispatch's on-disk queue. Called by the
 * launcher on worker boot so events that failed to deliver before the restart
 * are attempted again before any new events land.
 */
export async function replayQueueOnBoot(
  dispatchId: string,
  queueBaseDir: string,
  statusUrl: string,
  apiToken: string,
  delaysMs?: number[],
): Promise<void> {
  const queue = new EventQueue(deriveQueuePath(queueBaseDir, dispatchId));
  if (!(await queue.hasPending())) return;
  await drainQueue(queue, deriveEventsUrl(statusUrl), apiToken, delaysMs);
}

/**
 * Convenience: creates SessionLogWatcher + forwarder wired together, starts the watcher.
 * When `queueBaseDir` is provided, a per-dispatch EventQueue is attached.
 */
export function startEventForwarding(
  options: StartEventForwardingOptions,
): EventForwardingHandle {
  const {
    dir,
    dispatchId,
    statusUrl,
    apiToken,
    pollIntervalMs,
    queueBaseDir,
    retryDelaysMs,
  } = options;
  const watcher = new SessionLogWatcher({
    cwd: dir,
    sessionDir: dir,
    dispatchId,
    pollIntervalMs,
  });
  const queue = queueBaseDir
    ? new EventQueue(deriveQueuePath(queueBaseDir, dispatchId))
    : undefined;
  const forwarder = createLaravelForwarder(statusUrl, apiToken, {
    queue,
    retryDelaysMs,
  });
  watcher.onEntry(forwarder.consume);
  watcher.start();
  return { watcher, flush: forwarder.flush };
}
