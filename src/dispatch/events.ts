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

  on<T extends DispatchEventTopic>(
    topic: T,
    listener: (event: DispatchEventMap[T]) => void | Promise<void>,
  ): void {
    this.emitter.on(topic, (event: DispatchEventMap[T]) => {
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
    });
  }

  off<T extends DispatchEventTopic>(
    topic: T,
    listener: (event: DispatchEventMap[T]) => void | Promise<void>,
  ): void {
    this.emitter.off(topic, listener);
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
  }

  listenerCount(topic: DispatchEventTopic): number {
    return this.emitter.listenerCount(topic);
  }
}

export const dispatchEvents = new DispatchEventBus();
