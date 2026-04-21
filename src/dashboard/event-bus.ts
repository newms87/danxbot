/**
 * In-process pub/sub backplane for the dashboard SSE stream.
 *
 * Topics:
 *   "dispatch:created"         — new dispatch row; payload: Dispatch
 *   "dispatch:updated"         — dispatch row changed; payload: Partial<Dispatch> & {id: string}
 *   `dispatch:jsonl:${jobId}`  — new JSONL blocks for a dispatch; payload: JsonlBlock[]
 *   "agent:updated"            — repo settings/health changed; payload: AgentSnapshot
 *
 * Backpressure: each subscriber tracks how many pending publish calls are
 * queued. Publishers never block or await subscribers. If a subscriber's
 * pending count exceeds MAX_SUBSCRIBER_QUEUE, it is evicted and its
 * unsubscribe handler is called to tear down the SSE connection.
 */

import type { Dispatch } from "./dispatches.js";
import type { JsonlBlock } from "./jsonl-reader.js";
import type { AgentSnapshot } from "./agents-routes.js";

/** All first-class topic literals. Wildcard prefix patterns are also valid but
 * callers must supply the exact topic string (e.g. `dispatch:jsonl:${id}`). */
export type EventTopic =
  | "dispatch:created"
  | "dispatch:updated"
  | "agent:updated"
  | (string & {}); // open-ended for `dispatch:jsonl:<id>`

export interface DispatchCreatedPayload {
  topic: "dispatch:created";
  data: Dispatch;
}

export interface DispatchUpdatedPayload {
  topic: "dispatch:updated";
  data: Partial<Dispatch> & { id: string };
}

export interface DispatchJsonlPayload {
  topic: `dispatch:jsonl:${string}`;
  data: JsonlBlock[];
}

export interface AgentUpdatedPayload {
  topic: "agent:updated";
  data: AgentSnapshot;
}

export type BusEvent =
  | DispatchCreatedPayload
  | DispatchUpdatedPayload
  | DispatchJsonlPayload
  | AgentUpdatedPayload;

export type BusEventCallback = (event: BusEvent) => void;

/**
 * How many pending (unresolved) publish calls a single subscriber may have
 * before it is considered "slow" and evicted.
 */
const MAX_SUBSCRIBER_QUEUE = 100;

interface Subscriber {
  callback: BusEventCallback;
  pending: number;
  onEvict: () => void;
}

class EventBus {
  private topics = new Map<string, Set<Subscriber>>();

  /**
   * Publish a typed event to all subscribers of the given topic.
   * Never blocks — slow subscribers (pending > MAX_SUBSCRIBER_QUEUE) are
   * evicted before the call returns.
   */
  publish(event: BusEvent): void {
    const subs = this.topics.get(event.topic);
    if (!subs || subs.size === 0) return;

    for (const sub of [...subs]) {
      if (sub.pending >= MAX_SUBSCRIBER_QUEUE) {
        subs.delete(sub);
        sub.onEvict();
        continue;
      }
      sub.pending++;
      // Fire-and-forget — subscriber callbacks may be async but we do not
      // await them. `pending` is incremented before and decremented inside
      // the callback via the wrapper returned by `subscribe`.
      try {
        sub.callback(event);
      } catch {
        // Swallow errors to protect other subscribers.
      } finally {
        sub.pending--;
      }
    }
  }

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   *
   * @param topic  Exact topic string (e.g. "dispatch:created", "dispatch:jsonl:abc123")
   * @param cb     Callback invoked on each matching publish
   * @param onEvict Optional: called when the subscriber is evicted for being slow
   */
  subscribe(
    topic: string,
    cb: BusEventCallback,
    onEvict: () => void = () => {},
  ): () => void {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, new Set());
    }
    const sub: Subscriber = { callback: cb, pending: 0, onEvict };
    this.topics.get(topic)!.add(sub);

    return () => {
      const set = this.topics.get(topic);
      if (set) {
        set.delete(sub);
        if (set.size === 0) this.topics.delete(topic);
      }
    };
  }

  /**
   * Number of active subscribers for a topic. Used by dispatch-stream.ts to
   * know when to start/stop JSONL file polling.
   */
  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }

  /** For testing only — clear all subscribers. */
  _clear(): void {
    this.topics.clear();
  }
}

/** Module-level singleton — shared by all dashboard routes. */
export const eventBus = new EventBus();
