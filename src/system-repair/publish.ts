/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): one-call publisher for
 * the `system-repair-error:updated` SSE topic. Producers:
 *   - worker-side: `recordError` (categorize.ts) on every signature
 *     upsert.
 *   - dashboard-side: `resetRepairError` + `markUnfixable`
 *     (db-reads.ts) on operator action.
 * Each invokes this after the DB write commits so the Self-Repair tab
 * projects the new state without a refetch.
 *
 * The publisher fetches the full `{error, attempts[]}` snapshot via
 * `getRepairErrorDetail` so subscribers never need to round-trip back
 * to the API. This keeps the wire payload self-contained at the cost
 * of one extra read per write — acceptable because writes to
 * `system_errors` are rare (deduped by signature_hash, low cardinality).
 *
 * Errors fetching the snapshot are swallowed and surface as a
 * `console.warn` via `createLogger` — a failed publish must NEVER
 * break the underlying write path. The tab falls back to its periodic
 * stream-reconnect or a manual refresh; data loss is bounded to the
 * gap between the publish failure and the next mutation.
 *
 * NOTE: deliberately decoupled from `event-bus.ts` import order — the
 * publish helper is in `src/system-repair/` (not `src/dashboard/`) so
 * the worker's write hot path doesn't import the dashboard's full
 * event-bus surface. The function takes the bus as a typed argument
 * so tests can pass a stub.
 */

import type { Pool } from "pg";
import { createLogger } from "../logger.js";
import { eventBus } from "../dashboard/event-bus.js";
import type { BusEvent } from "../dashboard/event-bus.js";
import { getRepairErrorDetail } from "./db-reads.js";

const log = createLogger("system-repair-publish");

export interface EventBusLike {
  publish(event: BusEvent): void;
}

export interface PublishRepairErrorUpdatedInput {
  db: Pool;
  errorId: number;
  /** Override the default singleton — used in tests. */
  bus?: EventBusLike;
}

/**
 * Publish the post-write snapshot of one `system_errors` row + its
 * attempts. Safe to call from any write path; never throws.
 *
 * Returns `void` because callers must not block on publish success.
 * The write succeeded before this fires; the SSE event is a UX
 * optimization.
 */
export async function publishRepairErrorUpdated(
  input: PublishRepairErrorUpdatedInput,
): Promise<void> {
  const { db, errorId, bus = eventBus } = input;
  try {
    const detail = await getRepairErrorDetail({ db, id: errorId });
    if (!detail) {
      bus.publish({
        topic: "system-repair-error:updated",
        data: { error_id: errorId, removed: true },
      });
      return;
    }
    bus.publish({
      topic: "system-repair-error:updated",
      data: { error_id: errorId, row: detail },
    });
  } catch (err) {
    log.warn(`publishRepairErrorUpdated(id=${errorId}) failed`, err);
  }
}
