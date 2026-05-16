# Issue YAML schema history

One-paragraph summaries of the prior schema bumps the (now-deleted) one-shot migration scripts performed. Retained as institutional knowledge after DX-595 (Phase 4 of the DX-591 schema-invariant epic) deleted the scripts themselves. The migration-registry framework (DX-592) + boot-time migration sweep (DX-593) is the forward path; this file is archive.

## Version ladder (quick reference)

| Version | Headline change | Bump card |
|---|---|---|
| v1–v2 | Pre-`schema_version` shape; only `id` + `title` + `description`. | (pre-DX) |
| v3 | Introduced top-level `schema_version`, `tracker`, `external_id`, structured `triage`. | (pre-DX) |
| v4 | Renamed `blocked` → `waiting_on`; status `"Needs Help"` → `"Blocked"`. | (pre-DX) |
| v5 | Backfilled `priority` field. | ISS-210 |
| v6 | Retired the standalone parking status; introduced the orthogonal `requires_human` field. | DX-231 |
| v7 | Added `conflict_on[]` (symmetric file-overlap mutex) and `parent_id` ↔ `children[]` two-way linkage. | DX-235 |
| v8 | Added structured `waiting_on: {reason, timestamp, by[]}`, made it status-independent. | DX-258 |
| v9 | Added `effort_level`, `ready_at`, `completed_at`, `cancelled_at`. | DX-275 |
| v10 | Registry + boot-sweep migration framework lands; reader becomes strict and stops conditional read-time fixups in favor of single-pass canonicalization at boot. | DX-592 / DX-593 |

## Going forward

`src/issue-tracker/migrations/` is the canonical change log for every
schema bump from v10 onward. Each new bump adds one file there
(`v<N-1>-to-v<N>.ts`) with a paired unit test asserting both shape
transformation and idempotence at `KNOWN_SCHEMA_MAX`. Read those
migration files for the authoritative record of every field added,
renamed, or removed.

The bump contract lives in `<repo>/CLAUDE.md` under "Schema bump
contract" and the core invariant under "Core Principle: Single
Canonical Schema — Fail Loud". This file's per-script sections below
are archive; the migrations directory is the source of truth for any
specific bump's mechanics.

## v1 → v3 (`migrate-issues-to-v3.ts`, retired)

First pass at v3 promotion. Stamped `schema_version: 3` on every YAML in `.danxbot/issues/{open,closed}/`, allocated non-colliding `ISS-N` ids for v1 orphans (scanned the existing prefix space for the highest in-use number), and ran the strict `parseIssue` validator post-write to confirm the v3 shape. Superseded by `migrate-issues-to-triage-v3.ts` once the triage rework (Phase 1 of ISS-90) tightened `parseIssue` to reject the older flat `triaged` + `dispatch_id` fields — the v1→v3 intermediate carried those, so the post-write round-trip failed. The retired script remained as a thin redirect-with-pointer until DX-595.

## triage rework v3 (`migrate-issues-to-triage-v3.ts`, retired)

Phase 1 of ISS-90 / ISS-91 — collapsed the flat `triaged: {timestamp, status, explain}` block into the per-card triage rework shape (`triage: {expires_at, reassess_hint, last_status, last_explain, ice, history}`) with the old triage values shifted into `history[0]` and mirrored into `last_*`. `expires_at` was staggered across `now → now + interval*N` (default 5 min, `--stagger-ms=<ms>` to override) so re-triage drained gradually instead of stamping all-at-once. The companion bump renamed `dispatch_id: <uuid>` → `dispatch: {id, pid, host, kind, started_at, ttl_seconds}` with placeholder values (`pid: 0`, `host: ""`, `started_at: ""`, `ttl_seconds: 0`) for Phase 2 to enrich. Idempotent — a YAML already at `triage` + `dispatch` shape skipped on re-run.

## v3 → v4 (`migrate-yamls-to-v4.ts`, retired)

Rename pass: `blocked` → `waiting_on`, status `"Needs Help"` → `"Blocked"`, and synthesized a self-block record when an old `Needs Help` card carried no explicit blocker. `parseIssue` did the actual rename + sentinel synth on read; the script wrapped a parse + serialize round-trip so every on-disk file ended up byte-stable in the new shape. Idempotent — a v4 YAML round-tripped without diff.

## v4 → v5 priority (`migrate-issues-priority.ts`, retired)

ISS-210 — backfilled `priority: 3.0` (mid-band) on every YAML missing the field and re-emitted `schema_version: 5`. `parseIssue` did the default + version bump; the script wrapped the read/write loop. Operated on `process.cwd()` (run from the connected repo's root, not from the danxbot checkout).

## Per-repo issue prefix migration (`migrate-issue-prefix.ts`, retired)

Phase 3 of ISS-99 — walked `<repo>/.danxbot/issues/{open,closed}/*.yml`, rewrote every `<oldPrefix>-N` reference inside any field to `<newPrefix>-N`, renamed the file on disk to match, then swapped `issue_prefix` in `<repo>/.danxbot/config/config.yml` LAST. Order mattered: the Phase-2 dashboard reader treated cross-prefix YAMLs as malformed, so flipping the config before the YAMLs would have made the reader silently skip every still-old card mid-migration. Atomic via an in-memory journal — on any failure (parse / validation / IO) the journal unwound in reverse (config restored first, then each renamed file moved back + rewritten with its original utf-8 bytes). Fail-loud on missing `config.yml` and on pre-existing `<newPrefix>-N.yml` collisions (POSIX `renameSync` would silently overwrite otherwise). Idempotent.

## Parking-status board cleanup (`src/worker/legacy-cleanup.ts`, retired)

DX-265 / Phase 2 of the DX-263 card-edit-gaps epic. Worker-boot one-shot pass that archived the now-retired parking-status Trello list and deleted the matching label after DX-231 introduced the orthogonal `requires_human` field. Per-step idempotent — every step short-circuited when the underlying artifact was already absent, so a re-run after a successful pass was a no-op. Per-step failures surfaced as `severity: "warn"` system errors and did not propagate; the next worker boot retried naturally. Off the agent's critical path — the worker drove this from its own boot, never from a dispatched agent. Companion Trello helpers (`findListByName`, `findLabelByName`, `listCards`, `archiveList`, `deleteLabel`) lived in `src/issue-tracker/trello.ts` and were deleted alongside the orchestrator in DX-595.
