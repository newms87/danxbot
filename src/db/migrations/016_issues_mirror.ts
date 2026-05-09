import type { PoolClient } from "pg";

/**
 * Phase 2 of the Issues DB Mirror epic (DX-151 / DX-153).
 *
 * Creates the `issues` and `issue_history` tables that mirror every YAML
 * under `<repo>/.danxbot/issues/{open,closed}/`. No application code reads
 * or writes either table in this phase — the chokidar writer + boot scan
 * arrive in Phase 3 (DX-154). This migration ships the schema in isolation
 * so the structure can be reviewed on its own commit.
 *
 * Design notes:
 *
 * - Frequently queried YAML fields are exposed as **stored generated
 *   columns** (`GENERATED ALWAYS AS (...) STORED`) so they can be indexed
 *   without the writer duplicating the projection.
 *
 * - Generated-column expressions must be IMMUTABLE in PG. The text/int/
 *   jsonb/boolean projections (jsonb arrow operators, `::int`, `IS NOT
 *   NULL`, `jsonb_typeof`) are all IMMUTABLE in PG 12+. The timestamptz
 *   projections, however, would require `text::timestamptz`, whose
 *   underlying cast (`timestamptz_in`) is STABLE because it depends on
 *   the session's `DateStyle` and `TimeZone` GUCs. That fails the
 *   immutability check the moment we add the column.
 *
 *   Per the card description's documented escape hatch, the timestamptz
 *   projections (`dispatch_started_at`, `created_at`, `updated_at`,
 *   `closed_at`, `last_status_change_at`, `triage_expires_at`) are
 *   declared as **regular nullable columns**. The Phase 3 writer will
 *   populate them on every UPSERT alongside `data`. Until Phase 3 lands,
 *   no row exists, so the columns being NULL is irrelevant.
 *
 * - The `blocked` boolean uses
 *   `COALESCE(jsonb_typeof(data->'blocked') = 'object', false)` instead
 *   of the spec's literal `(data->'blocked') IS NOT NULL`. The stricter
 *   form correctly classifies a YAML that serializes `blocked: null` as
 *   `{"blocked": null}` — `data->'blocked'` returns the JSON null literal
 *   in that case, which is NOT NULL in SQL terms but semantically still
 *   "no blocked record". The `COALESCE(... , false)` wrapper covers the
 *   key-absent case where `jsonb_typeof(NULL)` would propagate SQL NULL
 *   into the column. Both `jsonb_typeof` and `COALESCE` are IMMUTABLE.
 *
 * - `content_hash` and `mirror_updated_at` are inserted by the writer.
 *   The hash format (sha256 of canonicalized YAML bytes vs canonicalized
 *   data jsonb) is the writer's choice in Phase 3.
 *
 * - The `issue_history` table has **no FK to issues**. Per the brainstorm
 *   ("tombstone delete" open detail), history rows must survive issue-row
 *   deletion. Consumers joining the two tables tolerate `LEFT JOIN`
 *   producing nulls on the issues side.
 *
 * Migration tracker (`src/db/migrate.ts`) ensures this runs exactly once
 * per database — no `IF NOT EXISTS` guards needed.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE issues (
      repo_name             text         NOT NULL,
      data                  jsonb        NOT NULL,
      content_hash          text         NOT NULL,
      mirror_updated_at     timestamptz  NOT NULL DEFAULT now(),

      id                    text
        GENERATED ALWAYS AS (data->>'id') STORED,
      external_id           text
        GENERATED ALWAYS AS (data->>'external_id') STORED,
      "status"              text
        GENERATED ALWAYS AS (data->>'status') STORED,
      list_kind             text
        GENERATED ALWAYS AS (data->>'list_kind') STORED,
      "type"                text
        GENERATED ALWAYS AS (data->>'type') STORED,
      parent_id             text
        GENERATED ALWAYS AS (data->>'parent_id') STORED,
      dispatch_id           text
        GENERATED ALWAYS AS (data#>>'{dispatch,id}') STORED,
      dispatch_host_pid     int
        GENERATED ALWAYS AS ((data#>>'{dispatch,pid}')::int) STORED,
      assigned_agent        text
        GENERATED ALWAYS AS (data->>'assigned_agent') STORED,
      blocked               boolean
        GENERATED ALWAYS AS (
          COALESCE(jsonb_typeof(data->'blocked') = 'object', false)
        ) STORED,
      blocked_reason        text
        GENERATED ALWAYS AS (data#>>'{blocked,reason}') STORED,
      labels                jsonb
        GENERATED ALWAYS AS (data->'labels') STORED,

      dispatch_started_at   timestamptz,
      created_at            timestamptz,
      updated_at            timestamptz,
      closed_at             timestamptz,
      last_status_change_at timestamptz,
      triage_expires_at     timestamptz,

      PRIMARY KEY (repo_name, id)
    )
  `);

  await client.query(`
    CREATE INDEX issues_status
      ON issues (repo_name, "status")
  `);
  await client.query(`
    CREATE INDEX issues_status_kind
      ON issues (repo_name, "status", list_kind)
  `);
  await client.query(`
    CREATE INDEX issues_assigned
      ON issues (repo_name, assigned_agent)
      WHERE assigned_agent IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX issues_parent
      ON issues (repo_name, parent_id)
      WHERE parent_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX issues_triage_due
      ON issues (repo_name, triage_expires_at)
      WHERE triage_expires_at IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX issues_dispatch_id
      ON issues (dispatch_id)
      WHERE dispatch_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX issues_labels_gin
      ON issues USING gin (labels)
  `);

  await client.query(`
    CREATE TABLE issue_history (
      id          bigserial    PRIMARY KEY,
      repo_name   text         NOT NULL,
      issue_id    text         NOT NULL,
      changed_at  timestamptz  NOT NULL DEFAULT now(),
      "source"    text         NOT NULL,
      patch       jsonb        NOT NULL,
      prev_hash   text,
      next_hash   text         NOT NULL
    )
  `);

  await client.query(`
    CREATE INDEX issue_history_timeline
      ON issue_history (repo_name, issue_id, changed_at)
  `);
  await client.query(`
    CREATE INDEX issue_history_source
      ON issue_history ("source")
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query("DROP TABLE IF EXISTS issue_history");
  await client.query("DROP TABLE IF EXISTS issues");
}
