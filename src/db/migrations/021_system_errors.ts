import type { PoolClient } from "pg";

/**
 * DX-561 (Phase 1 of DX-560 — Self-Repair): durable storage for deduped
 * system errors + per-attempt repair history. Phase 2 wires callsites
 * via `src/system-repair/categorize.ts#recordError`. Phase 3 reads the
 * top-ranked open rows via `getOpenErrorsRanked` to decide which error
 * to dispatch a repair agent at.
 *
 * Two tables:
 *
 * - `system_errors` — one row per `(component, err_class, normalized
 *   message)` signature. `signature_hash` is the natural key (UNIQUE)
 *   so `INSERT ... ON CONFLICT (signature_hash) DO UPDATE` is the only
 *   write path. `sample_payload` holds the most recent stack / path /
 *   line for context freshness; the older sample is intentionally
 *   replaced on conflict (latest wins). Status is a string-typed enum
 *   (open / repairing / fixed / unfixable); kept text rather than a PG
 *   ENUM so the value list can grow without an ALTER TYPE migration.
 * - `system_error_repairs` — one row per repair attempt. UNIQUE on
 *   `(error_id, attempt_n)` so the dispatcher's "next attempt number"
 *   query is a deterministic `MAX(attempt_n) + 1`. FK to
 *   `system_errors.id` with `ON DELETE CASCADE` — if an operator
 *   manually deletes a stale error row, its repair history goes with it.
 *
 * The composite index `(status, count DESC)` shapes the dispatcher's
 * hot-path query (`status='open' ORDER BY count DESC`) so the planner
 * does an index scan instead of a seq+sort. The `count DESC` ordering
 * is encoded in the index itself.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE system_errors (
      id              BIGSERIAL    PRIMARY KEY,
      signature_hash  CHAR(16)     NOT NULL UNIQUE,
      category_key    TEXT         NOT NULL,
      component       TEXT         NOT NULL,
      err_class       TEXT         NOT NULL,
      normalized_msg  TEXT         NOT NULL,
      sample_payload  JSONB        NOT NULL,
      count           INT          NOT NULL DEFAULT 0,
      first_seen      TIMESTAMPTZ  NOT NULL,
      last_seen       TIMESTAMPTZ  NOT NULL,
      status          TEXT         NOT NULL DEFAULT 'open',
      repo            TEXT         NOT NULL
    )
  `);

  await client.query(`
    CREATE INDEX system_errors_status_count_idx
      ON system_errors (status, count DESC)
  `);

  await client.query(`
    CREATE TABLE system_error_repairs (
      id            BIGSERIAL    PRIMARY KEY,
      error_id      BIGINT       NOT NULL
        REFERENCES system_errors(id) ON DELETE CASCADE,
      attempt_n     INT          NOT NULL,
      card_id       TEXT,
      dispatch_id   TEXT,
      started_at    TIMESTAMPTZ  NOT NULL,
      ended_at      TIMESTAMPTZ,
      verdict       TEXT,
      report_md     TEXT,
      UNIQUE (error_id, attempt_n)
    )
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS system_error_repairs");
  await client.query("DROP INDEX IF EXISTS system_errors_status_count_idx");
  await client.query("DROP TABLE IF EXISTS system_errors");
}
