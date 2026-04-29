import { ref } from "vue";
import type { Ref } from "vue";
import { fetchWithAuth } from "../api";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface StreamEvent {
  topic: string;
  data: unknown;
}

export type StreamEventHandler = (event: StreamEvent) => void;

export interface UseStreamReturn {
  connectionState: Ref<ConnectionState>;
  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   * Starts the SSE connection automatically on the first subscription;
   * multiple synchronous subscribes share one connection request (the URL is
   * built from all topics registered before the microtask fires).
   */
  subscribe(topic: string, handler: StreamEventHandler): () => void;
  /** Abort the current connection and cancel any pending reconnect. */
  disconnect(): void;
}

/**
 * Parse one `text/event-stream` buffer slice into complete events. Each
 * event ends with a blank line; within an event, `data:` lines accumulate
 * into a single payload. Returns the leftover tail that hasn't finished
 * yet so the caller can prepend it to the next chunk.
 *
 * Private to this module — `useStream()` is the only legitimate consumer
 * of SSE frame parsing on the frontend. `followDispatch`, `useDispatches`,
 * and `useAgents` all go through `useStream()`.
 */
function splitEvents(buffer: string): { events: string[]; tail: string } {
  const parts = buffer.split("\n\n");
  const tail = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length) events.push(dataLines.join("\n"));
  }
  return { events, tail };
}

/**
 * Multiplexed SSE stream over `GET /api/stream?topics=<...>`.
 *
 * Each call to `useStream()` creates an independent connection manager.
 * Call `subscribe(topic, handler)` to register interest in a topic —
 * the first subscription (or a batch of synchronous subscriptions)
 * opens the connection. Call `disconnect()` in `onBeforeUnmount` to
 * clean up.
 *
 * Reconnect backoff: 1 s → 2 s → 4 s … capped at 30 s, with up to
 * 25 % jitter. Backoff is cumulative — it does not reset on reconnect.
 */
export function useStream(): UseStreamReturn {
  const connectionState = ref<ConnectionState>("disconnected");
  /** topic → set of registered handlers */
  const handlers = new Map<string, Set<StreamEventHandler>>();

  let ctrl: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1_000;

  /** True while the microtask that calls connect() is queued but not yet run. */
  let connectScheduled = false;

  function getTopics(): string[] {
    return [...handlers.keys()];
  }

  function dispatch(raw: string): void {
    try {
      const event = JSON.parse(raw) as StreamEvent;
      const subs = handlers.get(event.topic);
      if (subs) for (const h of [...subs]) h(event);
    } catch {
      // Malformed JSON — skip.
    }
  }

  async function connect(): Promise<void> {
    if (connectionState.value !== "disconnected") return;
    const topics = getTopics();
    if (topics.length === 0) return;

    connectionState.value = "connecting";
    ctrl = new AbortController();

    try {
      const res = await fetchWithAuth(
        `/api/stream?topics=${topics.map(encodeURIComponent).join(",")}`,
        { signal: ctrl.signal, headers: { Accept: "text/event-stream" } },
      );
      if (!res.ok || !res.body) {
        connectionState.value = "disconnected";
        scheduleReconnect();
        return;
      }

      connectionState.value = "connected";

      const reader = res.body.getReader();
      const dec = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          connectionState.value = "disconnected";
          scheduleReconnect();
          return;
        }
        buf += dec.decode(value, { stream: true });
        const { events, tail } = splitEvents(buf);
        buf = tail;
        for (const raw of events) dispatch(raw);
      }
    } catch (err) {
      connectionState.value = "disconnected";
      if ((err as { name?: string }).name !== "AbortError") {
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect(): void {
    const jitter = Math.random() * 0.25 * backoffMs;
    const delay = backoffMs + jitter;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function scheduleConnect(): void {
    if (connectScheduled || connectionState.value !== "disconnected") return;
    connectScheduled = true;
    void Promise.resolve().then(() => {
      connectScheduled = false;
      if (connectionState.value === "disconnected" && handlers.size > 0) {
        void connect();
      }
    });
  }

  function subscribe(topic: string, handler: StreamEventHandler): () => void {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic)!.add(handler);
    scheduleConnect();

    return () => {
      const subs = handlers.get(topic);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) handlers.delete(topic);
      }
    };
  }

  function disconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ctrl?.abort();
    ctrl = null;
    connectionState.value = "disconnected";
  }

  return { connectionState, subscribe, disconnect };
}

export interface HydrationBuffer<T> {
  /**
   * Run `fetchFn` to seed the base state, then synchronously drain queued
   * events on top of it via `applyEvent` and flip the buffer to live mode.
   * Returns the patched state.
   *
   * Re-callable: a second call (filter-change pattern) flips back to
   * buffering, refetches, drains the new queue, and flips to live again
   * without dropping events. Live handlers stay registered across cycles.
   *
   * Concurrent calls are serialized — the second call's body waits for the
   * first to complete before flipping `phase = "buffering"` and starting its
   * own fetch. This keeps the phase machine deterministic when a watcher
   * fires `void hydrate()` faster than the previous fetch resolves; without
   * serialization the older fetch's queue-drain could race the newer one
   * and produce a stale snapshot or double-apply events.
   *
   * The same SSE subscription stays open across the buffered→live boundary,
   * so there is no unsubscribe gap (the bug Phase 4 worked around in
   * `useDispatches.ts`).
   */
  hydrate(
    fetchFn: () => Promise<T>,
    applyEvent: (state: T, event: StreamEvent) => T,
  ): Promise<T>;

  /**
   * Register a handler that receives every event delivered after the next
   * `phase = "live"` transition. Multiple handlers OK; each receives every
   * event in registration order. Returns an unsubscribe function. Calling
   * after `close()` returns a no-op unsub and never fires.
   *
   * Registration order matters at exactly two boundaries:
   * - **Before hydrate** (the recommended pattern for both consumers): the
   *   handler is wired up but does NOT receive pre-hydrate (queued) events.
   *   Those are applied to state via `applyEvent` inside `hydrate`, and
   *   delivering them again to live handlers would double-apply.
   * - **After hydrate** (when a handler registers in the post-hydrate gap):
   *   any events that arrived since the buffer flipped to `live` and have
   *   no live handlers yet are queued and drained to this FIRST registered
   *   handler on registration — nothing is silently lost. Subsequent
   *   handlers registered later receive only events emitted after their
   *   registration.
   */
  onLiveEvent(handler: (event: StreamEvent) => void): () => void;

  /**
   * Tear down the underlying stream subscription(s). Idempotent. After
   * close(), no further events are queued or delivered, and hydrate()
   * rejects.
   */
  close(): void;
}

/**
 * Subscribe to `topic` (or every topic in an array) on `stream` and buffer
 * arriving events until `hydrate()` runs. After hydrate resolves, the same
 * subscription forwards events to handlers registered via `onLiveEvent`.
 *
 * The single physical subscription is what makes this race-free: there is
 * never an unsubscribe between the buffered phase and the live phase.
 *
 * Multi-topic buffers (`createHydrationBuffer(stream, ["a", "b"])`) queue
 * events from every listed topic into one ordered queue; `applyEvent` and
 * live handlers receive a `StreamEvent` so they can dispatch on `topic`.
 *
 * Usage pattern (single state, single or multiple topics):
 * ```ts
 * const buf = createHydrationBuffer<Dispatch[]>(stream, [
 *   "dispatch:created",
 *   "dispatch:updated",
 * ]);
 * buf.onLiveEvent((event) => {
 *   dispatches.value = applyOne(dispatches.value, event);
 * });
 * dispatches.value = await buf.hydrate(
 *   () => fetchDispatches(filters),
 *   applyOne,
 * );
 * // Filter changed? Just call hydrate again — same buffer, same handler.
 * // On unmount: buf.close().
 * ```
 */
export function createHydrationBuffer<T>(
  stream: Pick<UseStreamReturn, "subscribe">,
  topicOrTopics: string | string[],
): HydrationBuffer<T> {
  const topics = Array.isArray(topicOrTopics) ? topicOrTopics : [topicOrTopics];
  /**
   * Phase machine:
   *   "buffering" — queue every event (pre-hydrate, or during a re-hydrate).
   *   "live"      — dispatch every event to liveHandlers; if no live
   *                 handlers yet, queue until the first registers, then
   *                 drain to it.
   *   "closed"    — drop everything; underlying subscriptions torn down.
   */
  let phase: "buffering" | "live" | "closed" = "buffering";
  const queue: StreamEvent[] = [];
  const liveHandlers = new Set<(event: StreamEvent) => void>();
  const unsubs: Array<() => void> = [];
  /**
   * Tail of the hydrate-serialization chain. Each `hydrate()` call awaits
   * `pendingHydrate` before doing anything (so a second concurrent call
   * runs only after the first resolves), then replaces `pendingHydrate`
   * with its own completion promise so the next call chains onto it.
   */
  let pendingHydrate: Promise<unknown> = Promise.resolve();

  for (const topic of topics) {
    unsubs.push(
      stream.subscribe(topic, (event) => {
        if (phase === "closed") return;
        if (phase === "buffering") {
          queue.push(event);
          return;
        }
        // phase === "live"
        if (liveHandlers.size === 0) {
          // Gap between hydrate-resolved and first onLiveEvent registration.
          // Queue and drain on first registration so nothing is lost.
          queue.push(event);
          return;
        }
        for (const h of [...liveHandlers]) h(event);
      }),
    );
  }

  return {
    hydrate(fetchFn, applyEvent) {
      if (phase === "closed") {
        return Promise.reject(new Error("HydrationBuffer is closed"));
      }
      // Flip SYNCHRONOUSLY at entry so events emitted on the same tick (or
      // while we are chained behind a prior hydrate) queue, not leak to live
      // handlers. Without this, the microtask gap before `await prev`
      // resolves is a hole the second concurrent hydrate's events drop into.
      phase = "buffering";
      // Chain onto the prior hydrate so concurrent calls run sequentially.
      const prev = pendingHydrate;
      const current = (async () => {
        // Swallow prior failures — they are the prior caller's problem;
        // ours is to start clean.
        try {
          await prev;
        } catch {
          // intentional swallow
        }
        // close() may have run during `await prev` — `phase` can have been
        // mutated externally, so we cast away the control-flow narrowing.
        if ((phase as "buffering" | "live" | "closed") === "closed") {
          throw new Error("HydrationBuffer is closed");
        }
        // Re-flip after the chain wait. The prior hydrate set phase=live on
        // resolve; we need it back to buffering so events arriving during
        // OUR fetch are queued, not delivered to live handlers (they will be
        // applied via applyEvent on top of the new snapshot, and the caller
        // will overwrite the ref with the returned state).
        phase = "buffering";
        let next: T = (await fetchFn()) as T;
        // close() may have run during the fetch await as well.
        if ((phase as "buffering" | "live" | "closed") === "closed") {
          return next;
        }
        for (const ev of queue) next = applyEvent(next, ev);
        queue.length = 0;
        phase = "live";
        return next;
      })();
      // Tail-track this call so the next hydrate awaits us.
      pendingHydrate = current.catch(() => {
        // Don't let one rejection poison the chain for the next caller.
      });
      return current;
    },
    onLiveEvent(handler) {
      if (phase === "closed") return () => {};
      liveHandlers.add(handler);
      // Drain any gap-queued events to the FIRST handler that registers
      // post-hydrate. Subsequent handlers receive only future events.
      if (phase === "live" && queue.length > 0) {
        const drained = queue.splice(0);
        for (const ev of drained) handler(ev);
      }
      return () => {
        liveHandlers.delete(handler);
      };
    },
    close() {
      if (phase === "closed") return;
      phase = "closed";
      liveHandlers.clear();
      queue.length = 0;
      for (const u of unsubs) u();
      unsubs.length = 0;
    },
  };
}
