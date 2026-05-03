---
name: danx-next
description: Pull the top card from ToDo and run the full autonomous card processing workflow.
---

# Danx Next Card

You process ONE card. You are the orchestrator — do not delegate workflow steps to subagents (except Step 5 quality gates and Step 4 batch-edits).

The dispatch prompt told you the YAML path:

```
Edit <repo>/.danxbot/issues/open/<external_id>.yml.
Call danx_issue_save({external_id: "<id>"}) when done.
```

That YAML is the source of truth for the card. The poller pre-hydrated it from the tracker before this dispatch ran. You read, edit, and save the YAML — you do NOT make tracker calls. The worker pushes your changes to the tracker asynchronously.

---

## YAML Schema (read this once)

| Field | Type | Notes |
|---|---|---|
| `schema_version` | `1` | Never change. |
| `tracker` | string | Don't change. |
| `external_id` | string | The id you save with. Don't change. |
| `parent_id` | string \| null | Set on phase cards (epic's external_id). |
| `dispatch_id` | string \| null | Poller-managed. Don't touch. |
| `status` | `Review` \| `ToDo` \| `In Progress` \| `Needs Help` \| `Done` \| `Cancelled` | Editing this is how you move the card across lists. |
| `type` | `Bug` \| `Feature` \| `Epic` | Required label. |
| `title` | string | Card name. |
| `description` | string | Full markdown body. |
| `triaged` | `{timestamp, status, explain}` | Triage agent owns this. Leave alone. |
| `ac` | `[{check_item_id, title, checked}]` | Acceptance Criteria. Empty `check_item_id` on new items — tracker assigns. |
| `phases` | `[{check_item_id, title, status, notes}]` | `status`: `Pending` \| `Complete` \| `Blocked`. |
| `comments` | `[{id?, author, timestamp, text}]` | Append a new comment by adding `{author, timestamp, text}` (no `id`). The worker handles tracker push semantics. |
| `retro` | `{good, bad, action_items[], commits[]}` | Fill on Done / Needs Help. |

**Save semantics:** `danx_issue_save({external_id})` validates the YAML synchronously and returns `{saved: true}` or `{saved: false, errors}`. Tracker push runs detached — tracker errors NEVER appear in the tool result. When `status` is `Done` or `Cancelled`, the worker moves the file `open/` → `closed/` as part of save. Save after every meaningful edit.

**Auto-sync:** `danxbot_complete` triggers a final auto-sync as a safety net, so a missed save before completion still pushes. Prefer explicit saves anyway — they validate earlier.

---

## Top-Level Flow

1. Read the YAML the dispatch prompt named.
2. Plan (Step 2).
3. Evaluate scope; epic-split if needed (Step 3).
4. Implement TDD (Step 4).
5. Quality gates (Step 5).
6. Verify ACs (Step 6).
7. Commit (Step 7).
8. Definition-of-Done gate (Step 8).
9. Move to Done (Step 9) OR Needs Help (Step 10).
10. `danx_issue_save({external_id})`.
11. `danxbot_complete` (Step 11).

Config references: `.claude/rules/danx-repo-config.md` for repo commands. Never hardcode IDs.

---

## Step 1 — Read the YAML

`Read <repo>/.danxbot/issues/open/<external_id>.yml`. The dispatch prompt has the absolute path.

The YAML carries `status: ToDo` at this point — the poller picked it up and hydrated it. Your first edit is to flip `status: ToDo` → `status: In Progress` and call `danx_issue_save`. That's how you "claim" the card — the worker syncs the tracker move to In Progress for you.

If the YAML's `status` is already `In Progress`, treat this as resumption — skip the flip + save and proceed.

If the YAML doesn't exist or fails to parse, signal `danxbot_complete({status: "critical_failure"})` per `.claude/rules/danx-halt-flag.md` — the poller is broken if it dispatched without a YAML.

---

## Step 2 — Plan

1. Read the full `description`, all `comments[]`, all `ac[]` titles, and any existing `phases[]`.
2. **Bug cards (`type: Bug`):** investigate root cause via `Read` / `Grep` / `Bash` before designing the fix.
3. **Needs Help short-circuit:** if completing the card requires human intervention (Slack / Trello settings / external config / credentials), jump to Step 10.
4. Design the approach in your head. No code yet.
5. Invoke the `/wow` skill to reload Ways of Working.

---

## Step 3 — Evaluate Scope (Epic Split)

If the card is 3+ implementation phases, spans different domains, or will exceed ~500 lines: split into an epic.

1. Edit the parent YAML: set `type: Epic`. Keep `status: In Progress` — the epic stays open while phases work. Append a comment summarizing the split (no `id` field). Save.
2. For each phase, write a draft YAML at `<repo>/.danxbot/issues/open/<slug>.yml` (filename can be the kebab-case slug; `.yml` suffix optional in the create call — both forms accepted) with every required field populated. Use this template (`<DRAFT_TEMPLATE>`):
   - `schema_version: 1`
   - `tracker: <same as parent>`
   - `external_id: ""` (tracker assigns)
   - `parent_id: <epic external_id>`
   - `dispatch_id: null`
   - `status: "ToDo"`
   - `type: "Bug"` or `"Feature"` (the phase's own kind, not `Epic`)
   - `title: "<Epic Title> > Phase N: Description"`
   - `description: "<full body>"`
   - `triaged: {timestamp: "", status: "", explain: ""}`
   - `ac: [{check_item_id: "", title: "...", checked: false}, ...]` (every required field present, `check_item_id: ""` until tracker assigns)
   - `phases: []` (or seeded items with `check_item_id: ""`)
   - `comments: []`
   - `retro: {good: "", bad: "", action_items: [], commits: []}`
3. For each phase YAML, call `danx_issue_create({filename: "<slug>"})`. The worker validates as a draft (allows empty `external_id` + empty `check_item_id`s), creates the tracker card, stamps assigned ids back into the YAML, and renames the file to `<external_id>.yml`. Capture the returned `external_id`. `{created: false, errors}` → fix the draft and retry.
4. Restart this workflow at Step 1 using the first phase card's YAML.

The epic stays at `status: In Progress` until ALL phase cards are Done — then the final phase agent (or you, if no more phases) flips the epic to `Done` and saves it. After a phase completes, the next phase card lives in `<repo>/.danxbot/issues/open/`. The poller picks it up on the next tick.

---

## Step 4 — Implement (TDD)

1. **Write failing test** capturing the expected behavior.
2. **Run tests** — confirm new test fails (test command from `.claude/rules/danx-repo-config.md`).
3. **Implement** — minimum code to pass.
4. **Run tests** — all green.
5. **Refactor** — clean up; re-run.
6. **Type check** — command from `.claude/rules/danx-repo-config.md` (skip if empty).

**Documentation-only changes:** skip TDD; note this in a comment appended to `comments[]`.

For large repetitive edits, dispatch a `batch-editor` subagent via `Agent` / `Task`.

After implementation, save: `danx_issue_save({external_id})`.

---

## Step 5 — Quality Gates

Launch in parallel via `Agent` / `Task` with `mode: "bypassPermissions"`:
- `test-reviewer` — audit coverage.
- `code-reviewer` — review quality.

Append each result as a new comment to `comments[]`. For each: set `author` to `"test-reviewer"` / `"code-reviewer"`, `timestamp` to the current ISO time, `text` to a multi-line markdown body starting with `## Test Review` or `## Code Review` followed by the subagent output. No `id` field.

If critical issues found, fix them, re-run the failed gate, append a `## Review Fixes` comment summarizing the fixes.

Save: `danx_issue_save({external_id})`.

---

## Step 6 — Check Off Acceptance Criteria

For each `ac[i]`, verify it holds (test evidence, command output, direct code read). Set `ac[i].checked: true` only with direct evidence.

**Never check off an unverified item.** "By construction" / "obviously correct" are not evidence. State must reflect a passing test, captured command output, or a quoted line from code that demonstrably satisfies the criterion.

If you cannot verify an item — repo this worker cannot commit to, requires a deploy, depends on external state — leave `checked: false`. Do NOT check it off with an excuse. Do NOT paraphrase it as "done in spirit."

---

## Step 7 — Commit

Consult `Git Mode` in `.claude/rules/danx-repo-config.md`:
- `auto-merge`: feature branch `danxbot/<kebab-case-title>`, stage + commit, push, merge to main, delete branch.
- `pr`: feature branch, stage + commit, push, `gh pr create`.

Append commit shas to `retro.commits[]`.

---

## Step 8 — Definition-of-Done Gate (CRITICAL)

Before deciding Done vs Needs Help, **inspect the actual state of every AC item in the YAML.**

Mechanical procedure:

1. Re-read `<repo>/.danxbot/issues/open/<external_id>.yml`.
2. Count `ac` entries where `checked === false`.
3. **Zero unchecked** → Step 9 (Done).
4. **One or more unchecked** → Step 10 (Needs Help). Do NOT move to Done. Do NOT rationalize.

Forbidden moves:
- "All the important ACs are done, the rest are minor" — irrelevant. ACs aren't ranked.
- "Remaining ACs require external work, so they don't count" — they count. They were defined as required.
- "I'll move to Done; the retro will explain the gaps" — no. The card location is the canonical state.
- "Wording is too strict" — edit the AC item or file a separate card. Don't silently shift status.
- "I checked off the AC because the verification ran, even though it failed" — `checked: true` means the criterion HOLDS, not that it was attempted.

A card in Done means: every AC item is `checked: true` with direct evidence. No other definition.

---

## Step 9 — Move to Done

Edit YAML:

1. `status: Done`
2. **Bug cards:** prepend a Bug Diagnosis section to `description` OR append a comment:
   ```
   ## Bug Diagnosis
   **Problem:** ...
   **Root Cause:** ...
   **Solution:** ...
   ```
3. Append a retro comment to `comments[]`. Logical shape (use real YAML / multi-line block scalars when writing — these are not literal escape sequences):
   - `author: "danxbot"`
   - `timestamp: <current ISO>`
   - `text:` a multi-line markdown body containing `## Retro`, `**What went well:** ...`, `**What went wrong:** ...`, `**Action items:** ...`, `**Commits:** ...`
   - No `id` field
4. Fill `retro.good`, `retro.bad`, `retro.action_items[]`, `retro.commits[]`.
5. **Action item cards:** for each non-trivial action item, write a new draft YAML at `<repo>/.danxbot/issues/open/<slug>.yml` using the `<DRAFT_TEMPLATE>` from Step 3.2, with these overrides: `parent_id: null`, `status: "Review"`, `type: "Bug"` or `"Feature"`, `title: "<action item title>"`, `description: "<one-paragraph context for why this card exists>"`. Then call `danx_issue_create({filename: "<slug>"})`. Append a comment to the current card linking each created action-item id.

Save: `danx_issue_save({external_id})`. The worker validates, then moves the file `open/` → `closed/` and pushes the tracker move to Done.

Skip to Step 11.

---

## Step 10 — Move to Needs Help

Use this when Step 8 found unchecked ACs, when external repo changes are required this worker cannot make, when verification depends on a deploy this worker cannot run, or when a human decision is required.

Edit YAML:

1. `status: Needs Help` (worker auto-applies the Needs Help label — don't touch labels yourself).
2. Append a Needs Help comment to `comments[]`. Logical shape:
   - `author: "danxbot"`
   - `timestamp: <current ISO>`
   - `text:` a multi-line markdown body with these sections:
     - `## Needs Help — <one-line summary>`
     - `**What's done:** <bullet list of what landed, with commit shas>`
     - `**What's still needed:** <numbered list — file paths, repo names, exact edits, verification commands>`
     - `**Why this needs human/host help:** <one paragraph>`
     - `**Incomplete ACs:** <bullet list of every unchecked AC item, verbatim>`
     - `**Final AC check:** Before Done, every AC must be checked: true.`
   - No `id` field
3. **Bug cards** with partial progress: also append the `## Bug Diagnosis` block.
4. Fill `retro.{good, bad, action_items, commits}` honestly — the AC gap is the primary "what went wrong."
5. Append a standard `## Retro` comment as in Step 9.

Save: `danx_issue_save({external_id})`.

Skip to Step 11.

---

## Step 11 — Signal Completion (MANDATORY)

Call `danxbot_complete` once at the very end:

- `status: "completed"` — card finished or moved to Needs Help.
- `status: "failed"` — fatal error stopped the work.
- `status: "critical_failure"` — environment-level blocker (see `.claude/rules/danx-halt-flag.md`).
- `summary` — one-line outcome (card title + commit sha, Needs Help reason, or failure cause).

The worker:
1. Auto-syncs the tracked YAML one final time as a safety net.
2. Finalizes the dispatch row.
3. SIGTERMs the Claude process.
4. Resumes polling.

Never exit without `danxbot_complete`.

---

## If the YAML Says Empty / Wrong State

If the dispatched YAML is missing or unparseable, signal `critical_failure` — the poller is broken. If the YAML's `status` is already `Done` or `Cancelled` (file should be in `closed/`), something is wrong upstream — signal `failed` with a summary explaining the inconsistency.
