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
| `retro` | `{good, bad, action_items[], commits[]}` | Fill on Done / Cancelled / Needs Help. The worker auto-renders this as ONE structured comment on terminal save AND spawns one tracker card per `action_items[]` entry. **`action_items[]` is a LAST RESORT** — see Step 1.5. Only file an action item when the work is BOTH unrelated to this card's ACs AND too large to reasonably finish in this session (multi-phase refactor, redesign, cross-cutting work needing its own scoping). Small in-scope or small unrelated fixes you spotted → DO THEM NOW, don't defer. Do NOT append a `## Retro` comment to `comments[]` yourself, and do NOT call `danx_issue_create` for follow-ups — list them in `action_items[]` instead. `action_items[]` strings cannot contain `→` (reserved bookkeeping separator). |

**Save semantics:** `danx_issue_save({external_id})` validates the YAML synchronously and returns `{saved: true}` or `{saved: false, errors}`. Tracker push runs detached — tracker errors NEVER appear in the tool result. When `status` is `Done` or `Cancelled`, the worker moves the file `open/` → `closed/` as part of save. Save after every meaningful edit.

**Auto-sync:** `danxbot_complete` triggers a final auto-sync as a safety net, so a missed save before completion still pushes. Prefer explicit saves anyway — they validate earlier.

---

## Top-Level Flow

1. Read the YAML the dispatch prompt named.
1.5. Internalize the **You Fix What You Find** rule (Step 1.5) before doing anything else.
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

## Step 1.5 — You Fix What You Find (CRITICAL)

This card is yours. Action items, follow-up cards, hotfix cards, and Needs
Help moves are a **LAST RESORT**, not a workflow convenience. Default
behaviour for ANY defect, stale config, broken test, or cleanup you discover
during this dispatch — in-scope or not — is to fix it in this session.

Apply this filter, in order, every time you're tempted to defer work:

1. **Required for THIS card's ACs?** → Mandatory. Fix in this dispatch.
   Filing a "hotfix card" / "follow-up card" / "separate bug" for work that
   is required to satisfy this card's ACs is a **rule violation**. The card
   stays In Progress until ITS ACs pass — the fix lives in this session.
2. **Unrelated but small** (a few file edits, no big refactor, fits this
   session)? → Fix in this dispatch. Action items defer work, create tech
   debt, and incur re-dispatch cost. Prefer fixing every time.
3. **Unrelated AND large** (multi-phase refactor, cross-cutting redesign,
   needs its own scoping, would derail this card)? → Action item is OK.
4. **Needs human decision or external access** (credentials, deploy, repo
   you can't write to, ambiguous spec)? → Step 10 / action item.

Mechanical check before writing any action item or going to Needs Help:
**"Could I just do this in the next 10–30 minutes?"** Yes → do it. Drop the
action item / cancel the Needs Help.

Examples of work that MUST be done in-session, not deferred:

- Verification card whose verification fails because of a small in-scope
  bug → fix the bug, re-verify. Do NOT file a hotfix card and Needs Help.
- Stale config in a file you can edit (placeholder list, env var, alias).
- Broken test pointing at a defect in a function you can read + edit.
- Missing file you can write.
- Doc / comment that contradicts current behaviour and confused you.

Only after exhausting in-session fixes do you reach for action items or
Needs Help.

---

## Step 2 — Plan

1. Read the full `description`, all `comments[]`, all `ac[]` titles, and any existing `phases[]`.
2. **Bug cards (`type: Bug`):** investigate root cause via `Read` / `Grep` / `Bash` before designing the fix.
3. **Needs Help short-circuit:** only if the card matches Step 10's narrowed trigger list (true human / external blocker — credentials, deploy, repo you cannot write to, ambiguous spec needing human decision). Otherwise apply Step 1.5 — fix it yourself in this dispatch.
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
4. **One or more unchecked** → run the **Step 1.5 fix-it-yourself check**
   FIRST. Can you fix the underlying defect in this dispatch? YES → fix it,
   re-verify, re-check the AC, then re-run this gate. Only after exhausting
   in-session fixes do you proceed to Step 10. Do NOT move to Done. Do NOT
   rationalize.

Forbidden moves:
- "I'll file a hotfix card / follow-up card and Needs Help this one" — if
  the hotfix is what unblocks THIS card's AC, the hotfix IS this card's
  work. Do it now (Step 1.5).
- "The verification revealed defects, so this is a verdict-handoff card" —
  no. A verification card whose verification fails because of small
  in-scope bugs is a card to FIX those bugs, then verify.
- "All the important ACs are done, the rest are minor" — irrelevant. ACs aren't ranked.
- "Remaining ACs require external work, so they don't count" — they count.
  They were defined as required. Step 1.5 → can you do the "external" work
  yourself? If yes, do it. Only escalate when truly external.
- "I'll move to Done; the retro will explain the gaps" — no. The card location is the canonical state.
- "Wording is too strict" — edit the AC item with justification, or fix the
  underlying issue. Filing a separate card to dodge the AC is forbidden.
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
3. Fill `retro.good`, `retro.bad`, `retro.action_items[]`, `retro.commits[]`. The worker renders the `## Retro` comment automatically on save and spawns one tracker card per `action_items[]` entry — do NOT append a `## Retro` comment to `comments[]` yourself, and do NOT call `danx_issue_create` for action items. `action_items[]` strings must not contain `→`. **Action items are a LAST RESORT** — re-apply the Step 1.5 filter to every candidate. If it's required for THIS card's ACs (already done, since you're at Done) it's not an action item. If it's small + you could do it now, do it now and re-commit instead of filing. Only large, separate, scoped follow-ups belong here. Empty `action_items[]` is the right answer most of the time.

Save: `danx_issue_save({external_id})`. The worker validates, posts the rendered retro comment, spawns Action Items cards, then moves the file `open/` → `closed/` and pushes the tracker move to Done.

Skip to Step 11.

---

## Step 10 — Move to Needs Help

Needs Help is a **LAST RESORT**. Step 1.5 + Step 8's fix-it-yourself check
must have already failed. Use Step 10 ONLY when the blocker is genuinely
one of:

- External repo / file your worker has no write access to.
- Credentials, deploy, secrets rotation, or production action a human must
  perform.
- Genuine human design decision (ambiguous spec, missing requirement,
  conflicting stakeholder direction).
- Tool / environment failure that is card-specific (use `critical_failure`
  for environment-wide failure — see `.claude/rules/danx-halt-flag.md`).

**NOT Step 10 cases — fix in-session instead:**

- Stale config in a file you can edit.
- Bug in a function you can read + edit (in any repo bind-mounted to this
  worker).
- Test failure pointing at a defect in the same workspace / repo.
- Missing file you can write.
- Anything where the next agent would just open the same files you have
  open and make the same edits you could make now.

If you're about to move to Needs Help, ask one more time: **"Could I do
this myself in the next 10–30 minutes?"** Yes → do it. Cancel the Needs
Help.

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
4. Fill `retro.{good, bad, action_items, commits}` honestly — the AC gap is the primary "what went wrong." The worker auto-renders the `## Retro` comment and spawns Action Items cards on save (Needs Help is a non-terminal status, so the retro / action-items WILL not be auto-rendered yet — they render when the next pickup eventually moves the card to Done or Cancelled). Filling `retro` now still helps: the next agent inherits it through the YAML. **Re-apply the Step 1.5 filter to every action item candidate.** The fix the next agent will need to make → describe in the Needs Help comment, not as an action item card. Only large, unrelated, separately-scopeable follow-ups belong in `action_items[]`. Empty `action_items[]` is the right answer most of the time.

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
