/**
 * GET /api/stream — multiplexed SSE endpoint.
 *
 * Clients specify which topics they want via `?topics=<comma-separated>`.
 * Valid topics:
 *   dispatch:created
 *   dispatch:updated
 *   dispatch:jsonl:<jobId>
 *   agent:updated
 *
 * The connection stays open until the client disconnects or is evicted for
 * being slow (backpressure). Keep-alive `: keep-alive` comments are emitted
 * every KEEPALIVE_INTERVAL_MS to prevent proxy/load-balancer idle timeouts.
 *
 * Auth: No global bearer auth is required for dispatch:* topics (parity with
 * the open GET /api/dispatches endpoint). All topics are currently open.
 * Future: restrict agent:* topics to bearer-auth callers when sensitivity
 * warrants it.
 *
 * Backpressure: handled by the EventBus — slow subscribers are evicted and
 * their connection is closed. See event-bus.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { createLogger } from "../logger.js";
import { getDispatchById } from "./dispatches-db.js";
import { eventBus, type BusEvent } from "./event-bus.js";
import { startJsonlWatcher, stopJsonlWatcher } from "./dispatch-stream.js";
import { expectedJsonlPath } from "./jsonl-path-resolver.js";

const log = createLogger("stream-routes");

/** SSE keep-alive interval. */
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Evict a subscriber when its outbound write buffer exceeds this threshold.
 * Prevents a slow client from causing the publisher to accumulate unbounded
 * in-process data (64 KiB is generous for SSE, where messages are small).
 */
const MAX_WRITE_BUFFER_BYTES = 64 * 1024;

const VALID_STATIC_TOPICS = new Set([
  "dispatch:created",
  "dispatch:updated",
  "agent:updated",
]);

function isValidTopic(topic: string): boolean {
  if (VALID_STATIC_TOPICS.has(topic)) return true;
  if (/^dispatch:jsonl:[a-zA-Z0-9_-]+$/.test(topic)) return true;
  return false;
}

function parseTopics(params: URLSearchParams): string[] {
  const raw = params.get("topics") ?? "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && isValidTopic(t));
}

function writeEvent(res: ServerResponse, event: BusEvent): void {
  const line = `data: ${JSON.stringify({ topic: event.topic, data: event.data })}\n\n`;
  res.write(line);
}

/**
 * Handle GET /api/stream.
 *
 * Opens an SSE connection, subscribes to the requested topics, and forwards
 * events to the client until it disconnects or is evicted for slowness.
 */
export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const topics = parseTopics(params);
  if (topics.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "topics parameter is required (comma-separated list of valid topics)" }));
    return;
  }

  // For dispatch:jsonl:<jobId> topics, validate the jobId exists and get the
  // JSONL path before opening the stream.
  const jsonlTopics = topics.filter((t) => t.startsWith("dispatch:jsonl:"));
  const jsonlStartup: Array<{ jobId: string; jsonlPath: string }> = [];

  for (const topic of jsonlTopics) {
    const jobId = topic.slice("dispatch:jsonl:".length);
    try {
      const dispatch = await getDispatchById(jobId);
      if (!dispatch) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Dispatch not found: ${jobId}` }));
        return;
      }
      // Use expectedJsonlPath so that dispatches with only sessionUuid (no
      // jsonlPath yet) still work — matches the handleFollowDispatch approach.
      const jsonlPath = expectedJsonlPath(dispatch);
      if (!jsonlPath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `No JSONL path available yet for dispatch: ${jobId}` }));
        return;
      }
      jsonlStartup.push({ jobId, jsonlPath });
    } catch (err) {
      log.warn(`handleStream: failed to look up dispatch ${jobId}`, err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
      return;
    }
  }

  // Open the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable Nginx/Caddy buffering for SSE
  });

  let closed = false;
  const unsubscribers: Array<() => void> = [];
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    for (const unsub of unsubscribers) {
      unsub();
    }
    // Stop JSONL file watchers whose subscriber count drops to zero.
    for (const { jobId } of jsonlStartup) {
      if (eventBus.subscriberCount(`dispatch:jsonl:${jobId}`) === 0) {
        stopJsonlWatcher(jobId);
      }
    }
    // Finalize the response (no-op if already closed by the client).
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }

  // Keep-alive timer — assigned after declaration so cleanup() can reference it.
  keepAlive = setInterval(() => {
    if (closed) return;
    try {
      res.write(": keep-alive\n\n");
    } catch {
      cleanup();
    }
  }, KEEPALIVE_INTERVAL_MS);

  // On client disconnect, clean up.
  req.on("close", () => {
    cleanup();
  });

  // Subscribe to each topic.
  for (const topic of topics) {
    const unsub = eventBus.subscribe(
      topic,
      (event) => {
        if (closed) return;
        try {
          writeEvent(res, event);
        } catch {
          cleanup();
        }
      },
      () => {
        // Evicted by backpressure — cleanup handles res.end() and clearInterval.
        log.warn(`SSE subscriber evicted for topic "${topic}" (slow consumer)`);
        cleanup();
      },
      () => (res.writableLength ?? 0) > MAX_WRITE_BUFFER_BYTES,
    );
    unsubscribers.push(unsub);
  }

  // Start JSONL file watchers (after subscribing to topics so we don't miss
  // events between subscription and watcher start).
  for (const { jobId, jsonlPath } of jsonlStartup) {
    // startJsonlWatcher hydrates existing content synchronously via publish
    // and then starts the poll interval.
    startJsonlWatcher(jobId, jsonlPath).catch((err) => {
      log.warn(`Failed to start JSONL watcher for ${jobId}`, err);
    });
  }
}
