/**
 * DX-365 (Phase 2 of DX-363) — in-process event bus for dispatch
 * lifecycle transitions that consumers OUTSIDE the dispatch finalize
 * path care about. Topics:
 *
 *   - `broken-transition` — the strike accumulator (`src/agent/strikes.ts`)
 *     emits this when an agent's strike count crosses the
 *     `STRIKES_MAX = 3` threshold AND the agent's `broken` field flipped
 *     from `null` to populated in the same write. Phase 4 (DX-367)
 *     subscribes to dispatch the system-evaluator agent that fills in the
 *     real `broken.reason` summary.
 *   - `sync-repair-needed` — `dispatchWithRecovery` emits this when
 *     `syncWorktree` returns `kind: "abort"` (DX-645 — Phase 3 of
 *     DX-576). The sync-repair-dispatcher subscribes and dispatches
 *     the `worktree-repair` workspace into the broken worktree; the
 *     repair agent rebases + resolves + pushes + clears
 *     `agent.broken` so the original agent is dispatchable again on
 *     the next tick. The picker-gate stamp on `agents.<name>.broken`
 *     still lands inline inside `dispatchWithRecovery` (no event-
 *     only path) so a missed subscriber cannot silently let a
 *     broken worktree retry the next tick.
 *
 * Singleton EventEmitter so subscribers in any module reach the same
 * source — mirrors `src/dashboard/event-bus.ts`'s shape but lives under
 * `src/dispatch/` because the producer + initial consumer are both in
 * the dispatch domain. Listener errors do not propagate back to the
 * emitter (caught + logged) so a bad subscriber cannot wedge the
 * finalize path.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../logger.js";

const log = createLogger("dispatch-events");

export interface BrokenTransitionEvent {
  repoName: string;
  agentName: string;
}

/**
 * Emitted by `dispatchWithRecovery` on `syncWorktree.kind === "abort"`
 * (DX-645). The sync-repair-dispatcher subscribes and dispatches the
 * `worktree-repair` workspace into the broken worktree.
 *
 * The picker-gate stamp on `agents.<name>.broken` still happens
 * inline inside `dispatchWithRecovery` — the event is the
 * fan-out signal that triggers the repair dispatch, NOT the gate
 * itself. A missed subscriber therefore leaves the agent gated
 * (preserving the prior operator-gate behavior) but blocks the
 * auto-repair; reviewer agents flag any change that moves the
 * gate-stamp into the event subscriber.
 */
export interface SyncRepairNeededEvent {
  repoName: string;
  agentName: string;
  /**
   * The short human label from `SyncResult.abort.reason`
   * (e.g. "ff-only pull rejected"). Carried verbatim so the
   * dispatched repair agent can name the env failure in its
   * comments / commit messages.
   */
  abortReason: string;
  /**
   * The verbatim git stderr from the failed sync (or empty string
   * when stderr was empty). Carried for downstream diagnostics —
   * the dispatcher does NOT include this in the prompt by default
   * (kept off the wire so a 50KB conflict dump doesn't blow up
   * the prompt budget); the repair agent reads it from the YAML
   * via `agent.broken.suggested_steps` instead.
   */
  abortDetails: string;
}

export type DispatchEventTopic =
  | "broken-transition"
  | "sync-repair-needed";

export interface DispatchEventMap {
  "broken-transition": BrokenTransitionEvent;
  "sync-repair-needed": SyncRepairNeededEvent;
}

class DispatchEventBus {
  private emitter = new EventEmitter();
  /**
   * `on()` wraps every caller-supplied listener in a try/catch closure
   * so a bad subscriber cannot wedge the emitter. `off()` therefore
   * needs the wrapper, not the original, to remove the registration.
   * The inner map stores wrappers per original listener as an ARRAY —
   * `EventEmitter` allows the same function to be registered N times
   * and requires N `off()` calls to drain; we mirror that semantic so
   * `off()` peels one registration per call. Without this `off()` was
   * a silent no-op and the evaluator-dispatcher's shutdown handle
   * leaked a listener — DX-367.
   */
  private wrappers = new Map<
    string,
    // Heterogeneous per-topic listener storage — the EventEmitter
    // itself is loosely typed so we mirror that here. The on/off public
    // methods enforce the strong topic ↔ event shape at the type
    // boundary; the internal Map just stores opaque function refs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Map<(...args: any[]) => any, Array<(...args: any[]) => void>>
  >();

  on<T extends DispatchEventTopic>(
    topic: T,
    listener: (event: DispatchEventMap[T]) => void | Promise<void>,
  ): void {
    const wrapper = (event: DispatchEventMap[T]) => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            log.error(`[${topic}] async listener threw`, err);
          });
        }
      } catch (err) {
        log.error(`[${topic}] sync listener threw`, err);
      }
    };
    let topicMap = this.wrappers.get(topic);
    if (!topicMap) {
      topicMap = new Map();
      this.wrappers.set(topic, topicMap);
    }
    const existing = topicMap.get(listener);
    if (existing) {
      existing.push(wrapper);
    } else {
      topicMap.set(listener, [wrapper]);
    }
    this.emitter.on(topic, wrapper);
  }

  off<T extends DispatchEventTopic>(
    topic: T,
    listener: (event: DispatchEventMap[T]) => void | Promise<void>,
  ): void {
    const topicMap = this.wrappers.get(topic);
    if (!topicMap) return;
    const stack = topicMap.get(listener);
    if (!stack || stack.length === 0) return;
    // Pop the most-recently-registered wrapper — Node's
    // EventEmitter.off removes the LAST matching listener (LIFO), so
    // we drain the same direction to keep observable behavior in step.
    const wrapper = stack.pop()!;
    this.emitter.off(topic, wrapper);
    if (stack.length === 0) {
      topicMap.delete(listener);
    }
  }

  emit<T extends DispatchEventTopic>(
    topic: T,
    event: DispatchEventMap[T],
  ): void {
    this.emitter.emit(topic, event);
  }

  /** Test-only — drops every subscriber. */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.wrappers.clear();
  }

  listenerCount(topic: DispatchEventTopic): number {
    return this.emitter.listenerCount(topic);
  }
}

export const dispatchEvents = new DispatchEventBus();
