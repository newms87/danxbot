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
   * Await `fetchFn` to seed the base state, then replay every event that
   * arrived during the hydration window on top of it. Returns the patched
   * state. The buffer is automatically closed (unsubscribed) after this call.
   */
  hydrate(
    fetchFn: () => Promise<T>,
    applyEvent: (state: T, eventData: unknown) => T,
  ): Promise<T>;
}

/**
 * Subscribe to `topic` on `stream` and buffer all arriving events until
 * `hydrate()` is called. This prevents the race condition where an SSE event
 * arrives after you subscribe but before your REST response resolves: without
 * buffering, those events are silently lost and the UI shows stale state.
 *
 * Usage pattern:
 * ```ts
 * const buf = createHydrationBuffer(stream, "dispatch:updated");
 * const state = await buf.hydrate(fetchDispatches, applyEvent);
 * // `state` is REST response + all events that arrived during the fetch.
 * // Subscribe normally afterwards for ongoing events.
 * ```
 */
export function createHydrationBuffer<T>(
  stream: Pick<UseStreamReturn, "subscribe">,
  topic: string,
): HydrationBuffer<T> {
  const queue: unknown[] = [];
  let closed = false;
  const unsub = stream.subscribe(topic, (event) => {
    if (!closed) queue.push(event.data);
  });

  return {
    async hydrate(fetchFn, applyEvent) {
      if (closed) throw new Error("HydrationBuffer already consumed — call hydrate() exactly once");
      let state: T = (await fetchFn()) as T;
      closed = true;
      unsub();
      for (const d of queue) state = applyEvent(state, d);
      queue.length = 0;
      return state;
    },
  };
}
