---
name: danx-triage
description: 'DEPRECATED. The bulk-triage skill has been replaced by `danx-triage-card` — a per-card direct triage agent dispatched 1-card-per-tick by the poller (ISS-93 / Phase 3 of ISS-90). This skill remains as a thin redirect for any caller still typing `/danx-triage`. Phase 5 (ISS-95) deletes this skill once every consumer has cut over.'
argument-hint: <ISS-N card id (single card per dispatch — bulk mode retired)>
---

# Danx Triage — DEPRECATED

This skill has been replaced by [`danx-triage-card`](../danx-triage-card/SKILL.md).

## Why the rename

The old `/danx-triage` was a bulk orchestrator that dispatched sub-agents in waves of 3, each scoring one card. The new architecture is **single-dispatch-per-poller-tick** — the poller picks one card whose `triage.expires_at <= now`, dispatches a single direct Claude session that calls `mcp__danx-issue__danx_issue_get` / `danx_issue_save`, and returns. No orchestrator. No sub-agents. No wave concurrency.

ISS-93 (Phase 3 of the Poller Triage Rework epic, ISS-90) shipped the new skill as `danx-triage-card`. Phase 4 (ISS-94) wires the poller to dispatch it. Phase 5 (ISS-95) deletes this redirect once every consumer is on the new path.

## What to do

If you typed `/danx-triage`, you almost certainly want one of:

- `/danx-triage-card <ISS-N>` — triage a single card (the new direct-mode skill).
- `mcp__danx-issue__danx_issue_list status="Review"` — enumerate cards needing triage; pick one and invoke `/danx-triage-card`.

If you really need to triage every Review card right now (manual mass operation), invoke `/danx-triage-card` once per id. The bulk loop lives in the poller (ISS-94), not in a skill.

## If invoked with the `auto` argument (poller's `TRIAGE_AUTO_PROMPT`)

The poller's `checkAndSpawnTriage` (`src/poller/index.ts`) still dispatches `/danx-triage auto` when an operator has opted in via `overrides.autoTriage.enabled = true`. Phase 4 (ISS-94) replaces that dispatcher with a per-card loop calling `/danx-triage-card` directly — until then, this skill is the one the poller hits for `auto` mode.

**When invoked with `auto`:**

1. List every triage-eligible card via `mcp__danx-issue__danx_issue_list` — three calls, one per status: `status="Review"`, `status="Needs Help"`. (Blocked cards are returned by `status="Review"` / `"Needs Help"` indirectly when their schema-stored status is one of those; cards with `blocked != null` typically have `status: ToDo`, which `danx_issue_list` filtered to `status="ToDo"` would also return — filter the union by `blocked != null OR status ∈ {Review, Needs Help}`.)
2. For each card returned: call `mcp__danx-issue__danx_issue_get({id})` to load the full YAML, check `triage.expires_at <= now` (or empty), and if eligible, follow the per-card decision tree from [`danx-triage-card/SKILL.md`](../danx-triage-card/SKILL.md) inline. Save via `mcp__danx-issue__danx_issue_save({id})`.
3. Cap the loop at **5 cards per dispatch** to bound the token cost. If more than 5 cards need triage, the next poller tick handles the remainder.
4. Signal `danxbot_complete({status: "completed", summary: "auto-triaged N/M eligible cards (capped at 5)"})`.

This is an **interim bridge** — Phase 4 (ISS-94) wires the poller to dispatch `/danx-triage-card` once per eligible card directly, eliminating the need for a bulk-loop skill entirely. Phase 5 (ISS-95) deletes this whole file.

**If you receive the `auto` argument but find the per-card decision tree in [`danx-triage-card/SKILL.md`](../danx-triage-card/SKILL.md) is unavailable** (skill missing on disk, MCP server unreachable), signal `danxbot_complete({status: "failed", summary: "auto-mode dispatched but danx-triage-card skill missing"})` rather than attempting the legacy bulk-orchestrator pattern. The bulk pattern is gone for a reason.

## Migration mapping (old → new)

| Old behaviour | New behaviour |
|---|---|
| `/danx-triage` (no args) → globs every open YAML, parallel sub-agents | `mcp__danx-issue__danx_issue_list` + per-card `/danx-triage-card <ISS-N>` |
| `/danx-triage auto` → poller hook for Action Items + Review | Poller (ISS-94) calls `/danx-triage-card <ISS-N>` directly when `triage.expires_at <= now` |
| Writes `triage.last_status` only | Writes `triage.expires_at`, `triage.reassess_hint`, `triage.last_status`, `triage.last_explain`, `triage.ice`, appends `triage.history[]` |
| ICE on a 1-10 scale (product max 1000) | ICE on a 1-5 scale (product max 125) — matches the schema landed in ISS-91 |

The schema underneath was migrated by ISS-91 — `triaged.{timestamp,status,explain}` is gone; the structured `triage{}` block replaced it. Any caller still emitting `triaged.*` fails the `mcp__danx-issue__danx_issue_save` validator.
