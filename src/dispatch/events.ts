/**
 * DX-365 (Phase 2 of DX-363) — in-process event bus for dispatch
 * lifecycle transitions that consumers OUTSIDE the dispatch finalize
 * path care about. Currently a single topic:
 *
 *   - `broken-transition` — the strike accumulator (`src/agent/strikes.ts`)
 *     emits this when an agent's strike count crosses the
 *     `STRIKES_MAX = 3` threshold AND the agent's `broken` field flipped
 *     from `null` to populated in the same write. Phase 4 (DX-367) will
 *     subscribe to dispatch the system-evaluator agent that fills in the
 *     real `broken.reason` summary.
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

export type DispatchEventTopic = "broken-transition";

export interface DispatchEventMap {
  "broken-transition": BrokenTransitionEvent;
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
