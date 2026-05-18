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
 * `useStream()` returns a per-call facade backed by ONE process-wide
 * connection manager. Every composable in the dashboard that needs
 * live updates may call `useStream()` independently — all of their
 * topic subscriptions multiplex onto the single underlying
 * `/api/stream` fetch. This is load-bearing: browsers cap concurrent
 * connections per origin at 6 over HTTP/1.1, and the dashboard has
 * ~11 composables that subscribe; without sharing, REST fetches
 * head-of-line-block behind exhausted SSE slots (DX-681).
 *
 * The facade tracks the subscriptions THIS caller created so
 * `disconnect()` releases only those handlers — sibling composables
 * still holding subscriptions keep the shared connection alive.
 * When the LAST handler across every facade unsubscribes, the shared
 * connection is aborted; the next subscription re-opens it.
 *
 * Reconnect backoff: 1 s → 2 s → 4 s … capped at 30 s, with up to
 * 25 % jitter. Backoff is cumulative across the shared connection
 * — it resets only when every handler has gone away.
 */

interface SharedStreamState {
  /** topic → set of registered handlers, summed across every facade */
  handlers: Map<string, Set<StreamEventHandler>>;
  connectionState: Ref<ConnectionState>;
  ctrl: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  /** True while the microtask that calls connect() is queued but not yet run. */
  connectScheduled: boolean;
}

function createSharedState(): SharedStreamState {
  return {
    handlers: new Map(),
    connectionState: ref<ConnectionState>("disconnected"),
    ctrl: null,
    reconnectTimer: null,
    backoffMs: 1_000,
    connectScheduled: false,
  };
}

let shared: SharedStreamState = createSharedState();

function getTopics(s: SharedStreamState): string[] {
  return [...s.handlers.keys()];
}

function dispatchEvent(s: SharedStreamState, raw: string): void {
  try {
    const event = JSON.parse(raw) as StreamEvent;
    const subs = s.handlers.get(event.topic);
    if (subs) for (const h of [...subs]) h(event);
  } catch {
    // Malformed JSON — skip.
  }
}

async function connect(s: SharedStreamState): Promise<void> {
  if (s !== shared) return;
  if (s.connectionState.value !== "disconnected") return;
  const topics = getTopics(s);
  if (topics.length === 0) return;

  s.connectionState.value = "connecting";
  s.ctrl = new AbortController();

  try {
    const res = await fetchWithAuth(
      `/api/stream?topics=${topics.map(encodeURIComponent).join(",")}`,
      { signal: s.ctrl.signal, headers: { Accept: "text/event-stream" } },
    );
    if (s !== shared) return; // teardown raced this fetch
    if (!res.ok || !res.body) {
      s.connectionState.value = "disconnected";
      scheduleReconnect(s);
      return;
    }

    s.connectionState.value = "connected";

    const reader = res.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { value, done } = await reader.read();
      if (s !== shared) return;
      if (done) {
        s.connectionState.value = "disconnected";
        scheduleReconnect(s);
        return;
      }
      buf += dec.decode(value, { stream: true });
      const { events, tail } = splitEvents(buf);
      buf = tail;
      for (const raw of events) dispatchEvent(s, raw);
    }
  } catch (err) {
    if (s !== shared) return;
    s.connectionState.value = "disconnected";
    if ((err as { name?: string }).name !== "AbortError") {
      scheduleReconnect(s);
    }
  }
}

function scheduleReconnect(s: SharedStreamState): void {
  const jitter = Math.random() * 0.25 * s.backoffMs;
  const delay = s.backoffMs + jitter;
  s.backoffMs = Math.min(s.backoffMs * 2, 30_000);
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    if (s === shared && s.handlers.size > 0) void connect(s);
  }, delay);
}

function scheduleConnect(s: SharedStreamState): void {
  if (s.connectScheduled || s.connectionState.value !== "disconnected") return;
  s.connectScheduled = true;
  void Promise.resolve().then(() => {
    s.connectScheduled = false;
    if (
      s === shared &&
      s.connectionState.value === "disconnected" &&
      s.handlers.size > 0
    ) {
      void connect(s);
    }
  });
}

/**
 * Abort the underlying fetch + reset backoff. Called when the LAST
 * subscriber across every facade has unsubscribed. The shared state
 * object itself stays — the next subscribe() re-opens the connection
 * with fresh backoff.
 */
function teardownSharedIfEmpty(s: SharedStreamState): void {
  if (s !== shared) return;
  if (s.handlers.size > 0) return;
  if (s.reconnectTimer !== null) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  s.ctrl?.abort();
  s.ctrl = null;
  s.backoffMs = 1_000;
  s.connectionState.value = "disconnected";
  s.connectScheduled = false;
}

/**
 * Test-only: reset the module-level shared state to a fresh instance.
 * Existing facade references become orphans (their `disconnect` is a
 * no-op against the new shared state). Tests call this in `beforeEach`
 * so backoff / connection state don't leak across cases.
 */
export function __resetSharedStreamForTesting(): void {
  if (shared.reconnectTimer !== null) clearTimeout(shared.reconnectTimer);
  shared.ctrl?.abort();
  shared = createSharedState();
}

export function useStream(): UseStreamReturn {
  // Per-facade tracking of THIS caller's unsubs so `disconnect()` releases
  // only this caller's handlers — sibling facades keep the shared
  // connection alive while they still hold subscriptions.
  const local = new Set<() => void>();

  function subscribe(topic: string, handler: StreamEventHandler): () => void {
    const s = shared;
    if (!s.handlers.has(topic)) s.handlers.set(topic, new Set());
    s.handlers.get(topic)!.add(handler);
    scheduleConnect(s);

    const unsub = (): void => {
      // Bind to the shared instance captured at subscribe time. If a test
      // reset replaced `shared` between subscribe and unsub, the captured
      // state is an orphan and removing from it is a no-op — correct
      // behavior, since the orphan's handlers are no longer live.
      const subs = s.handlers.get(topic);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) s.handlers.delete(topic);
      }
      local.delete(unsub);
      teardownSharedIfEmpty(s);
    };
    local.add(unsub);
    return unsub;
  }

  function disconnect(): void {
    for (const unsub of [...local]) unsub();
  }

  return {
    connectionState: shared.connectionState,
    subscribe,
    disconnect,
  };
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
