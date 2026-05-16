/**
 * In-process pub/sub backplane for the dashboard SSE stream.
 *
 * Topics:
 *   "dispatch:created"         — new dispatch row; payload: Dispatch
 *   "dispatch:updated"         — dispatch row changed; payload: Partial<Dispatch> & {id: string}
 *   `dispatch:jsonl:${jobId}`  — new JSONL blocks for a dispatch; payload: JsonlBlock[]
 *   "agent:updated"            — repo settings/health changed; payload: AgentSnapshot
 *
 * Backpressure: before each delivery the bus calls the subscriber's
 * `isSlowConsumer()` predicate. If it returns true the subscriber is evicted
 * and its `onEvict` handler is called to tear down the SSE connection.
 * Subscribers provide the predicate — typically checking `res.writableLength`
 * against a threshold — so the bus itself has no I/O dependency.
 * Publishers never block or await subscribers.
 */

import type { Dispatch } from "./dispatches.js";
import type { JsonlBlock } from "./jsonl-reader.js";
import type { AgentSnapshot } from "./agents-list.js";
import type { SystemError } from "./system-errors.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepairErrorWithAttempts } from "../system-repair/db-reads.js";

/** All first-class topic literals. Wildcard prefix patterns are also valid but
 * callers must supply the exact topic string (e.g. `dispatch:jsonl:${id}`). */
export type EventTopic =
  | "dispatch:created"
  | "dispatch:updated"
  | "agent:updated"
  | "issue-prefix:changed"
  | "issue:updated"
  | "system-errors"
  | "system-repair-error:updated"
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

export interface SystemErrorPayload {
  topic: "system-errors";
  data: SystemError;
}

/**
 * DX-103: emitted by `PUT /api/agents/:repo/issue-prefix` after a
 * successful migration. SPA listeners refresh the Issues tab so the
 * new prefix's chips render without a full page reload.
 */
export interface IssuePrefixChangedPayload {
  topic: "issue-prefix:changed";
  data: {
    repo: string;
    oldPrefix: string;
    newPrefix: string;
    migratedFiles: number;
  };
}

/**
 * DX-226 + DX-236: emitted on every YAML state change so the Issues tab
 * reflects card updates in <1s without polling.
 *
 * Two producers:
 *   - `PATCH /api/issues/:id` (DX-236) — operator-driven optimistic write.
 *   - chokidar `<repo>/.danxbot/issues/{open,closed}/*.yml` (DX-226) —
 *     every other write source (agents, watcher mirror's read-your-
 *     writes, `git pull`, hand edits), 50ms debounce per file id.
 *
 * Discriminated payload: the upsert variant carries the post-write
 * `Issue` so the SPA projects to its `IssueListItem` row without a
 * refetch round trip; the `removed: true` variant carries only `id` +
 * `repoName` so the reducer can drop the row without reading the file
 * (which is gone, by definition).
 *
 * Subscribers MUST be idempotent — chokidar's `awaitWriteFinish` debounce
 * (5s) means the PATCH publisher's immediate event and the watcher's
 * later catch-up event can both fire for the same logical write.
 */
export type IssueUpdatedPayload = {
  topic: "issue:updated";
  data:
    | { repoName: string; id: string; issue: Issue; removed?: false }
    | { repoName: string; id: string; removed: true };
};

/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): emitted on every mutation
 * of `system_errors` / `system_error_repairs` so the Self-Repair tab
 * live-updates without polling. Producers (post card-dispatcher rip):
 *
 *   - `recordError` (every callsite that bumps the count)
 *   - `resetRepairError` / `markUnfixable` (operator actions)
 *
 * Payload is the full {error, attempts[]} shape — same as the
 * `GET /api/self-repair/errors/:id` response — so the reducer can
 * project the row without a refetch.
 *
 * For row deletions (out of scope today), use `removed: true` with
 * just the error_id.
 */
export type SystemRepairErrorUpdatedPayload = {
  topic: "system-repair-error:updated";
  data:
    | { error_id: number; row: RepairErrorWithAttempts; removed?: false }
    | { error_id: number; removed: true };
};

export type BusEvent =
  | DispatchCreatedPayload
  | DispatchUpdatedPayload
  | DispatchJsonlPayload
  | AgentUpdatedPayload
  | SystemErrorPayload
  | IssuePrefixChangedPayload
  | IssueUpdatedPayload
  | SystemRepairErrorUpdatedPayload;

export type BusEventCallback = (event: BusEvent) => void;

interface Subscriber {
  callback: BusEventCallback;
  onEvict: () => void;
  isSlowConsumer: () => boolean;
}

class EventBus {
  private topics = new Map<string, Set<Subscriber>>();

  /**
   * Publish a typed event to all subscribers of the given topic.
   * Never blocks — subscribers whose `isSlowConsumer()` returns true are
   * evicted synchronously before their callback is invoked. All other
   * subscribers receive the event synchronously; errors are swallowed so
   * one bad subscriber cannot interrupt others.
   */
  publish(event: BusEvent): void {
    const subs = this.topics.get(event.topic);
    if (!subs || subs.size === 0) return;

    for (const sub of [...subs]) {
      if (sub.isSlowConsumer()) {
        subs.delete(sub);
        sub.onEvict();
        continue;
      }
      try {
        sub.callback(event);
      } catch {
        // Swallow errors to protect other subscribers.
      }
    }
  }

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   *
   * @param topic           Exact topic string (e.g. "dispatch:created", "dispatch:jsonl:abc123")
   * @param cb              Callback invoked on each matching publish
   * @param onEvict         Called when the subscriber is evicted for being slow
   * @param isSlowConsumer  Predicate checked before each delivery; returning
   *                        true evicts the subscriber. Typically checks
   *                        `res.writableLength` against a byte threshold.
   */
  subscribe(
    topic: string,
    cb: BusEventCallback,
    onEvict: () => void = () => {},
    isSlowConsumer: () => boolean = () => false,
  ): () => void {
    let subs = this.topics.get(topic);
    if (!subs) {
      subs = new Set();
      this.topics.set(topic, subs);
    }
    const sub: Subscriber = { callback: cb, onEvict, isSlowConsumer };
    subs.add(sub);

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
