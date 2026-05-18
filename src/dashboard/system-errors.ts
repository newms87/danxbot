/**
 * In-memory system-errors ring buffer + EventBus producer.
 *
 * Producers ({@link recordSystemError} call sites in `runSync`, `runSync`'s
 * heal pass, and the retry-queue's max-attempts hook) push events here.
 * Consumers — the REST list endpoint (`GET /api/system-errors`) and the
 * SSE stream (`GET /api/stream?topics=system-errors`) — read from the
 * same buffer so a freshly-connected client gets the recent backlog and
 * subsequent live events with no gap.
 *
 * Capacity: {@link SYSTEM_ERRORS_CAPACITY} (200) — FIFO eviction; the
 * oldest event is dropped when a 201st arrives. The buffer is in-memory
 * only; restarts clear it (persistent storage is a deliberate follow-up
 * and explicitly out of scope on DX-134).
 *
 * Ordering: insertion order is preserved internally (oldest first). The
 * REST helper returns newest-first to match how the banner UI displays
 * them; the SSE producer emits one event per `recordSystemError` call.
 */

import { randomUUID } from "node:crypto";
import { eventBus } from "./event-bus.js";

export type SystemErrorSource =
  | "tracker"
  | "healer"
  | "reconcile"
  | "retry-queue"
  | "poller"
  | "worktree"
  | "stop-replay"
  | "prep-verdict-replay"
  | "orphan-reaper"
  | "audit-drift"
  | "trello-list-mapping"
  | "stamp-terminal"
  | "event-loop-stall";

/**
 * `"info"` is the audit-trail channel: routine, non-actionable events
 * a callsite wants visible on `/api/system-errors` + the SSE stream
 * without promoting the banner from green to yellow/red. The banner
 * filters info entries out by default (it only renders warn/error);
 * info entries are observable via the REST list endpoint and SSE.
 *
 * DX-265 introduced the severity for the worker-boot legacy-cleanup
 * pass (retired in DX-595) so operators had a "what got archived?"
 * audit trail without an always-on banner shout; the tier remains for
 * the same shape of routine audit-trail events (e.g. orphan reaps,
 * audit-drift heals).
 */
export type SystemErrorSeverity = "info" | "warn" | "error";

export interface SystemError {
  id: string;
  timestamp: string;
  source: SystemErrorSource;
  severity: SystemErrorSeverity;
  repo: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RecordSystemErrorOptions {
  source: SystemErrorSource;
  severity?: SystemErrorSeverity;
  repo: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ListSystemErrorsOptions {
  /** Filter to events whose `repo` exactly matches. `null`/`undefined` = no filter. */
  repo?: string | null;
  /** Cap on returned events. Defaults to the full buffer. */
  limit?: number;
}

/** Hard cap on retained events. Out of scope for DX-134 to make this configurable. */
export const SYSTEM_ERRORS_CAPACITY = 200;

/** Oldest first, newest at the end. Read-side reverses for newest-first display. */
const buffer: SystemError[] = [];

/**
 * Record a system error. Pushes onto the ring buffer (evicting the oldest
 * entry once {@link SYSTEM_ERRORS_CAPACITY} is exceeded) and publishes a
 * `system-errors` event to the {@link eventBus}. Returns the stored event
 * for callers that want the assigned id/timestamp.
 *
 * Severity defaults to `"error"`. Pass `severity: "warn"` for the healer
 * surface where individual heal failures are recoverable on the next tick.
 */
export function recordSystemError(opts: RecordSystemErrorOptions): SystemError {
  const event: SystemError = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: opts.source,
    severity: opts.severity ?? "error",
    repo: opts.repo,
    message: opts.message,
    ...(opts.details ? { details: opts.details } : {}),
  };

  buffer.push(event);
  while (buffer.length > SYSTEM_ERRORS_CAPACITY) {
    buffer.shift();
  }

  eventBus.publish({ topic: "system-errors", data: event });

  return event;
}

/**
 * Snapshot the buffered errors. Returns a new array — callers may mutate
 * freely without affecting the backing buffer. Newest first; optionally
 * filtered by repo and capped at `limit`.
 */
export function listSystemErrors(
  opts: ListSystemErrorsOptions = {},
): SystemError[] {
  const { repo, limit } = opts;
  let snapshot: SystemError[] =
    repo == null ? [...buffer] : buffer.filter((e) => e.repo === repo);
  snapshot.reverse();
  if (typeof limit === "number" && limit >= 0) {
    snapshot = snapshot.slice(0, limit);
  }
  return snapshot;
}

/** Test-only: drain the buffer between cases. */
export function _clearSystemErrors(): void {
  buffer.length = 0;
}

/**
 * Sugar around {@link recordSystemError} for the `severity: "info"`
 * audit-trail channel (DX-265). Callsites that surface non-error
 * lifecycle events (legacy cleanup actions, boot-pass milestones) use
 * this shape so a grep for "recordSystemError" highlights
 * actual-error callsites only. Routes through the same ring buffer +
 * SSE topic so consumers don't need a second wire.
 */
export function recordSystemEvent(
  opts: Omit<RecordSystemErrorOptions, "severity">,
): SystemError {
  return recordSystemError({ ...opts, severity: "info" });
}
