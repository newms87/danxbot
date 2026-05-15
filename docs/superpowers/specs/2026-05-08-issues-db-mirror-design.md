# Issues DB Mirror — Design

Status: Draft (brainstorm 2026-05-08)
Predecessor of: Multi-worker dispatch spec (parked; this epic blocks it)

## Goal

Mirror every issue YAML under `<repo>/.danxbot/issues/{open,closed}/*.yml` into a Postgres table so:

- Internal Node readers (poller dispatch decisions, dashboard endpoints, MCP query tools, epic-status, triage loop) get fast indexed lookups instead of repeated `Glob` + `Read` + `parseSimpleYaml`.
- Cross-card / cross-repo queries are a single `SELECT` instead of an O(n) scan.
- Every change to an issue is recorded as an immutable history entry, making the per-card timeline queryable for audit, retro analysis, and dashboard timelines.

The filesystem stays the source of truth. The DB is a derived projection: if the DB is wiped, a boot scan rebuilds it from disk.

## Non-goals

- Migrating any existing data. No `dispatches`, `events`, `users`, `analytics` migration. Postgres starts empty. Users get re-seeded via `make create-user`.
- Changing the agent-side data flow. Agents continue to `Glob` + `Read` YAMLs in their workspace and `Edit` / `Write` them.
- Replacing the outbound tracker (Trello) mirror mechanism. The poller's per-tick outbound push stays exactly as-is.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| DB engine | **Postgres** (replaces MySQL entirely; MySQL container + client removed) |
| Existing data | **Wiped** — no migration, all current MySQL tables rebuilt fresh in PG |
| DB layout | Single `issues` table with `repo_name` column + composite indexes |
| Source of truth | Filesystem YAML; DB is a derived mirror |
| Write enforcement | Chokidar watcher on `<repo>/.danxbot/issues/{open,closed}/` is the canonical write path to DB |
| Internal write helper | `writeIssue()` keeps writing the file; watcher cascades to DB |
| `danx_issue_save` MCP | **Retired** — agents `Edit` / `Write` the YAML directly |
| `danx_issue_create` MCP | **Kept** — atomic ISS-N allocation needs server-side coordination |
| Outbound tracker push | Stays in the poller's existing per-tick mirror |
| Internal readers | **Move to DB** (poller, dashboard, epic-status, triage, MCP query tools) |
| Agent readers | **Stay on YAML** (Glob + Read; their workspace's own card mostly) |
| Reconcile | Chokidar on open+closed for runtime drift; periodic 10-min full scan on `open/` only |
| History format | **RFC 6902 JSON Patch** ops, stored as `jsonb` |
| History granularity | Every change recorded — no transient-field filter, no coalescing |
| DB write failure | Write the existing `<repo>/.danxbot/CRITICAL_FAILURE` flag → poller halts, dashboard shows red banner. Active dispatches keep running, no new ones spawn |

## Architecture

```
                          +-----------------------------------+
   internal write         |  writeIssue(repoLocalPath, issue) |
   path (poller, etc.)    |  -> writes YAML to disk           |
                          +----------------+------------------+
                                           |
   agent write path                        v
   (Edit / Write tool)            <repo>/.danxbot/issues/{open,closed}/*.yml
                                           |
                                  chokidar watcher (per repo)
                                           |
                                           v
                          +-----------------------------------+
                          |  parse + validate + build patch   |
                          |  upsert issues row                |
                          |  insert issue_history row         |
                          +----------------+------------------+
                                           |
                                           v
                          +-----------------------------------+
                          |        Postgres `issues`          |
                          |        Postgres `issue_history`   |
                          +-----------------------------------+
                                           ^
   internal readers (poller list*, dashboard, MCP query tools, epic-status,
   triage loop) all go through the DB. Agents keep reading YAMLs directly.
```

The watcher is the single chokepoint that updates the DB. `writeIssue()` does not call the DB directly — it just writes the file and trusts the watcher. This keeps internal-write and external-edit paths symmetric: both produce file changes, both reach the DB through the same code.

## Schema

### `issues` table

The full Issue object lives in `data jsonb`. Frequently queried fields are exposed as **stored generated columns** (PG 12+ `GENERATED ALWAYS AS (...) STORED`) so they can be indexed.

| Column | Type | Source | Notes |
|---|---|---|---|
| `id` | text | `data->>'id'` (generated) | ISS-N (e.g. `ISS-42`) |
| `repo_name` | text | inserted column | from watcher context, not in YAML |
| `external_id` | text | `data->>'external_id'` (generated) | tracker id |
| `status` | text | `data->>'status'` (generated) | Review / ToDo / In Progress / Needs Help / Done / Cancelled |
| `list_kind` | text | `data->>'list_kind'` (generated) | `action_items` vs default |
| `type` | text | `data->>'type'` (generated) | Epic / Phase / Bug / Feature |
| `parent_id` | text | `data->>'parent_id'` (generated) | epic linkage |
| `dispatch_id` | text | `data#>>'{dispatch,id}'` (generated) | non-null while in-flight |
| `dispatch_started_at` | timestamptz | `data#>>'{dispatch,started_at}'` (generated) | |
| `dispatch_host_pid` | int | `data#>>'{dispatch,host_pid}'` (generated) | liveness check |
| `assigned_agent` | text | `data->>'assigned_agent'` (generated) | **multi-worker spec consumes this** |
| `created_at` | timestamptz | `data->>'created_at'` (generated) | |
| `updated_at` | timestamptz | `data->>'updated_at'` (generated) | |
| `closed_at` | timestamptz | `data->>'closed_at'` (generated) | |
| `last_status_change_at` | timestamptz | `data->>'last_status_change_at'` (generated) | |
| `triage_expires_at` | timestamptz | `data#>>'{triage,expires_at}'` (generated) | |
| `blocked` | bool | `(data->'blocked') IS NOT NULL` (generated) | |
| `blocked_reason` | text | `data#>>'{blocked,reason}'` (generated) | |
| `labels` | jsonb | `data->'labels'` (generated) | indexed via GIN |
| `data` | jsonb | inserted | the full Issue object |
| `content_hash` | text | inserted | sha256 of canonicalized YAML; used by reconcile |
| `mirror_updated_at` | timestamptz | inserted | last time the watcher upserted |

Primary key: `(repo_name, id)`.

Indexes:

- `(repo_name, status)` — every poller list query
- `(repo_name, status, list_kind)` — dispatchable / action-items split
- `(repo_name, assigned_agent)` — multi-worker agent-busy lookup
- `(repo_name, parent_id)` — epic-status recompute
- `(repo_name, triage_expires_at)` — triage-due list
- `(dispatch_id)` — live-dispatch guard
- GIN on `labels` — label filtering

### `issue_history` table

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `repo_name` | text | |
| `issue_id` | text | matches `issues.id` |
| `changed_at` | timestamptz | |
| `source` | text | `writer` / `watcher` / `reconcile` / `boot-scan` |
| `patch` | jsonb | RFC 6902 ops vs the previous snapshot |
| `prev_hash` | text | content_hash of the previous YAML, for chain integrity |
| `next_hash` | text | content_hash of the new YAML |

Foreign key on `(repo_name, issue_id) → issues(repo_name, id)` with `ON DELETE CASCADE`.

Index: `(repo_name, issue_id, changed_at)` — timeline reconstruction.

A row is appended on every watcher event where `next_hash != prev_hash`, regardless of which fields changed. No filtering of transient dispatch fields, no same-second coalescing — the agreed level of granularity.

State at time T is reconstructed by replaying patches forward from the first history row (which carries `prev_hash = NULL` and a patch that adds the entire object from `{}`).

## Write pipeline

### Node-side (`writeIssue`)

`src/poller/yaml-lifecycle.ts#writeIssue` keeps its current contract: write the YAML file. It does **not** call the DB. The watcher handles it.

This means the existing call sites (`stampDispatchAndWrite`, `clearDispatchAndWrite`, `epic-status.ts`, `orphan-push.ts`, `index.ts`, `heal.ts`, etc.) need no changes.

### Agent-side

Agents `Edit` or `Write` the YAML directly through Claude Code's tools. The MCP `danx_issue_save` tool is removed; the workspace skills that invoke it are updated to use `Edit` / `Write` instead.

`danx_issue_create` stays. It allocates the next ISS-N atomically (server-side, via DB row insert with a unique constraint or PG sequence-per-repo), writes the initial YAML to `<repo>/.danxbot/issues/open/<ISS-N>.yml`, and returns the id. Without server-side coordination, two agents picking the next ISS-N from disk simultaneously would collide.

### Watcher

One chokidar instance per repo, watching:

- `<repo>/.danxbot/issues/open/`
- `<repo>/.danxbot/issues/closed/`

Events handled: `add`, `change`, `unlink`. On each event:

1. Read file (skip if unreadable / mid-write — chokidar `awaitWriteFinish` is on).
2. `parseSimpleYaml` → Issue object. On parse error: log, mark `issues.data = {malformed: true, raw: <text>}` so dashboard can surface it; do not crash.
3. Compute `content_hash`. If unchanged from the existing row, no-op.
4. Compute RFC 6902 patch vs the prior `data`.
5. Upsert `issues` row (transaction with the history insert).
6. Insert `issue_history` row.
7. On any DB error: write `<repo>/.danxbot/CRITICAL_FAILURE` and log loudly. Existing poller halt + dashboard banner mechanism takes over.

`unlink` (deletion) is treated as a tombstone: insert a final history row with a remove-everything patch, then delete the `issues` row. Cascade deletes the foreign-keyed history rows — to preserve audit, history rows MUST be copied to a separate `issue_history_archive` table (or the FK is dropped) before delete. (Open detail — see below.)

### Boot scan

On worker boot, before serving requests:

1. List every YAML under `open/` and `closed/`.
2. For each: read, hash, compare to `issues.content_hash` for the same `(repo_name, id)`. If hash matches, skip. Otherwise upsert + history row with `source: boot-scan`.
3. List every `issues` row for this repo whose `id` is not present on disk → tombstone delete.
4. Bootstrap case (DB empty): every YAML produces a creation history row with `prev_hash = NULL`.

### Periodic reconcile

Every 10 minutes during runtime, scan `open/` only (closed/ is mostly historical and the chokidar runtime watch covers it):

- Same hash compare as boot scan, scoped to `open/`.
- Drift fixes get history rows tagged `source: reconcile`.

The 10-min cadence is a safety net. Chokidar should catch everything in real time; reconcile exists to recover from missed events (watcher crash, NFS-style filesystem races, deploy gaps).

## Read pipeline

### Internal Node readers — move to DB

Touched files (sample, not exhaustive — implementation plan enumerates all):

- `src/poller/local-issues.ts` — `listDispatchableYamls`, `listInProgressYamls`, `listTriageDueYamls`, `listBlockedTodoYamls` → SQL queries
- `src/poller/yaml-lifecycle.ts` — `loadLocal`, `findByExternalId` → SQL with fallback to file read for the case where DB is mid-bootstrap
- `src/poller/epic-status.ts` — children lookup → SQL on `parent_id`
- `src/poller/index.ts` — every place that constructs lists from `local-issues` helpers (already covered by the helpers being rewritten)
- `src/dashboard/server.ts` — every endpoint listing/filtering issues → SQL with index hits
- MCP `danx_issue_list` and any new `danx_issue_query` query helper exposed on the danxbot MCP server

Each rewrite preserves the existing return type (Issue / IssueRef) so callers do not need to change.

### Agents — stay on YAML

No change. Workspace skills keep using `Glob` + `Read` over `<repo>/.danxbot/issues/`. The watcher mirror is invisible to them.

## Failure handling

Every DB write failure (insert / upsert / transaction) writes the file `<repo>/.danxbot/CRITICAL_FAILURE` with a payload of:

```
{
  "source": "issues-db-mirror",
  "error": "<error message>",
  "at": "<timestamp>"
}
```

Existing infrastructure handles the rest:

- Poller reads the flag at the top of every tick and refuses to dispatch.
- Dashboard renders a red banner (existing component).
- Active dispatches keep running until they signal completion through MCP — no forced kill.
- Operator clears via the dashboard button or `rm <repo>/.danxbot/CRITICAL_FAILURE`.

This reuses the contract already documented in `.claude/rules/agent-dispatch.md` "Critical failure flag — poller halt"; this epic just adds a new `source` to the existing flag-writers.

## Migration plan

Phased so each step is testable in isolation:

1. **Add Postgres infra.** New `danxbot-postgres` service in `docker-compose.yml` + `docker-compose.prod.yml`. Drop the `danxbot-mysql` service. Add `pg` (node-postgres) to `package.json`; remove `mysql2`. New connection module `src/db/connection.ts` (rewrite of the MySQL one).
2. **Rewrite migrations directory.** Existing 15 migrations under `src/db/migrations/` re-authored against PG syntax (no data migration; tables are created empty). Migration runner `src/db/migrate.ts` updated for `pg`. Drop / rewrite all DB-touching modules: `users-db.ts`, `threads-db.ts`, `auth-db.ts`, `dispatches-db.ts`, `events.ts` storage, `worker-restarts-db.ts`, etc.
3. **Add `issues` + `issue_history` migrations** with the schema above. No code uses them yet.
4. **Implement watcher + writer.** New `src/db/issues-mirror.ts` exposing `startIssuesMirror(ctx)` (spawns chokidar + reconcile timer). Wired into `src/worker/server.ts` startup alongside the poller.
5. **Implement boot scan.** Runs before the watcher starts so the DB is consistent before any reader queries it.
6. **Migrate internal readers to DB,** one helper at a time, with tests proving the new SQL returns the same shape as the old YAML scan. Old YAML-scanning code gets deleted as each helper is migrated.
7. **Retire `danx_issue_save` MCP tool.** Drop the worker route, drop the MCP server entry, update every workspace skill that called it to use `Edit` / `Write` instead. Verify by running the system-test poller scenario.
8. **Validation.** Full `make test` + `make test-system` pass. `make deploy-smoke` against a target.

Each phase is mergeable on its own. Phases 1–5 add infra without changing observable behavior; phase 6 cuts readers over (the risky one); phase 7 changes the agent contract (also risky — gated by the system-test poller scenario passing).

## Multi-worker spec dependency

The parked multi-worker spec consumes:

- `assigned_agent` generated column on `issues` (lock check: agent busy ↔ exists row with `assigned_agent = X AND status = 'In Progress'`).
- `issues` query for "current in-progress cards" used by the triage-precursor conflict check.
- Dashboard "active dispatches per agent" view fed by the `(repo_name, assigned_agent)` index.

No multi-worker work happens in this epic. The multi-worker spec is written after this one ships.

## Read-your-writes contract

Because `writeIssue()` returns as soon as the file is written and the DB upsert happens asynchronously inside the watcher, there is a short race window where a caller can write a YAML and then immediately query the DB before the mirror has caught up. Two acceptable resolutions, picked during plan-writing:

- **(Preferred) `writeIssue` waits for an in-process ack from the watcher** — the watcher exposes a Promise keyed by `(repo_name, id, content_hash)` that resolves once the upsert lands. `writeIssue` awaits it before returning. Same-process callers thus see read-your-writes; cross-process writers (rare) get the existing async behavior.
- **Or: `writeIssue` does the DB upsert directly** in addition to the file write, and the watcher dedupes by `content_hash`. Two write paths to maintain but every internal write is synchronously consistent with the DB.

Either preserves the watcher as the canonical mirror for external (agent / operator hand-edit / git pull) writes; the choice only affects how internal writers reach the DB.

## Open details to nail down during plan-writing

- **History on tombstone delete.** Cascade delete loses history. Either drop the FK and keep `issue_history` rows alive (dashboard timeline must tolerate missing `issues` row) or copy to `issue_history_archive` before delete. Pick during plan-writing.
- **`danx_issue_create` ID allocation strategy.** Sequence per (repo_name) vs `MAX(id) + 1` under SERIALIZABLE vs row-level lock on a counter row. Pick during plan-writing.
- **Watcher debounce.** Chokidar's `awaitWriteFinish` has tunable thresholds. Pick during plan-writing (start with defaults).
- **Test strategy for the watcher.** Whether to spin up real chokidar in tests or to expose `simulateWatcherEvent()` for unit tests. Pick during plan-writing.

## Implementation plan

To be written by the `writing-plans` skill after this spec is approved.
