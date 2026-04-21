---
name: danx-next
description: Pull the top card from ToDo and run the full autonomous card processing workflow.
---

# Danx Next Card

You are processing ONE card from the ToDo list. You are the orchestrator. Do not delegate workflow steps to subagents.

---

## HARD RULES — read these fully before any tool call

### 1. The pickup sequence is mandatory and comes FIRST.

Before you Read, Write, Edit, Grep, Glob, Bash, or Task ANY file or command (other than the initial prompt.md that Claude Code reads automatically), you MUST call these four Trello MCP tools, in this exact order, with the parent agent (NOT a subagent):

1. **`mcp__trello__get_cards_by_list_id`** — list id = the ToDo list id from `.claude/rules/danx-trello-config.md`. Result: the array of cards in ToDo. The top card (first element) is the one you will work on. Save its `id`, `name`, and `idLabels`.

2. **`mcp__trello__move_card`** — move the top card to the In Progress list.
   - `cardId`: the card's id
   - `listId`: In Progress list id from `.claude/rules/danx-trello-config.md`
   - `position`: `"top"`
   - `boardId`: board id from `.claude/rules/danx-trello-config.md`

   **DO NOT use `mcp__trello__update_card_details` to move the card. That tool updates name/description/labels only — passing a `listId` to it does nothing. Only `move_card` moves a card between lists.**

3. **`mcp__trello__update_card_details`** — apply the `Bug` or `Feature` label if the card doesn't already have one. Skip this call if the card already carries `Bug`, `Feature`, or `Epic`. Use this tool ONLY for labels/name/description updates, never for list moves.

4. **`mcp__trello__create_checklist`** + **`mcp__trello__add_checklist_item`** × 6 — create a `Progress` checklist on the card with items `Planning`, `Tests Written`, `Implementation`, `Tests Pass`, `Code Review`, `Committed`. Save every returned `checkItemId` so you can mark them complete later. Skip if a `Progress` checklist already exists.

**Only after all four succeed may you proceed to read the card's description, comments, or acceptance criteria.**

### 2. Do not delegate the pickup to a subagent.

You will see `Agent` (alias `Task`) as an available tool. **Do not use it for Steps 1–3 of the workflow.** MCP calls MUST come from the parent agent you are reading this in. Subagents do not have the Trello MCP tools configured and will fail or do the wrong thing. Reserve subagents for Step 5 quality gates (`test-reviewer`, `code-reviewer`) and Step 4 `batch-editor` (only for large repetitive edits).

### 3. Do not skip Step 1 because the card "looks simple" or "you already understand it from the list fetch."

The single observed failure mode for this skill is the agent reading the card name in `get_cards_by_list_id`, thinking "I know what to do," and jumping to `Read`/`Write`/`Edit` without moving the card. This leaves the card stuck in ToDo and invisible to other agents, humans, and the dashboard. **The pickup is not decoration. It is how you claim the card.** Without the move, another poller tick could dispatch a second agent on the same card.

### 4. Compliance self-check before every non-Trello tool call

Before any `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `Agent`, or `TodoWrite` call, ask:

> "Have I called `mcp__trello__move_card` successfully on the card I picked up?"

If no, **your next tool call must be one of `mcp__trello__get_cards_by_list_id`, `mcp__trello__move_card`, `mcp__trello__update_card_details`, `mcp__trello__create_checklist`, `mcp__trello__add_checklist_item`.** Anything else is a skill violation.

---

## Steps (top-level orchestration)

1. Execute Step 1 (Pick Up Card) below.
2. If `get_cards_by_list_id` returned an empty list, report "No cards to process" and jump to Step 9 (signal completion).
3. Run the Card Processing Workflow steps 2–8 in order.
4. Call `danxbot_complete` (Step 9) as the very last action.

## Report (at the end)

- Card title and outcome (completed / failed / needs-help).
- What was implemented (one short paragraph).
- Any issues encountered.

---

## Card Processing Workflow

Config references: `.claude/rules/danx-trello-config.md` (Trello IDs), `.claude/rules/danx-repo-config.md` (repo commands). Never hardcode Trello IDs. Every card MUST have a label (Bug or Feature).

### Step 1 — Pick Up Card (MANDATORY FIRST — see HARD RULES above)

The four MCP calls from HARD RULE 1. Nothing else happens before these succeed.

**Failure handling for Step 1:**
- If any Trello call fails, retry once with identical arguments.
- If still failing, call `mcp__trello__update_card_details` to apply the `Needs Help` label, `mcp__trello__add_comment` to describe what went wrong, `mcp__trello__move_card` to move the card to the `Needs Help` list (position: `"top"`), then jump to Step 9 with `danxbot_complete` `status: "failed"`.

### Step 2 — Plan

1. `mcp__trello__get_card_comments` — read ALL comments on the card.
2. `mcp__trello__get_acceptance_criteria` — read ALL acceptance criteria (save the checkItemIds).
3. **Bug cards:** investigate root cause with `Read`/`Grep`/`Bash` before proposing a fix.
4. **Needs Help short-circuit:** if the card requires human intervention (Slack / Trello settings / external config / credentials), apply `Needs Help` label, add a `<!-- danxbot -->` comment explaining what's needed, move to Needs Help list, jump to Step 9.
5. Design the approach in your head; no code yet.
6. Invoke the `/wow` skill to reload Ways of Working.
7. `mcp__trello__update_checklist_item` — mark `Planning` complete in the Progress checklist (use the saved checkItemId).

### Step 3 — Evaluate Scope

If the card is 3+ implementation phases, spans different domains, or will exceed ~500 lines: split into an epic.

1. `mcp__trello__update_card_details` — change the parent's label to `Epic`.
2. `mcp__trello__create_checklist` — name `"Phases"`.
3. `mcp__trello__add_checklist_item` × N — one item per phase.
4. `mcp__trello__add_card_to_list` × N — one phase card per item, in In Progress list, position `"top"`, title `Epic Title > Phase N: Description`, each with its own description + acceptance criteria + Bug/Feature label.
5. `mcp__trello__add_comment` on the epic summarizing the split and linking the phase cards.
6. `mcp__trello__move_card` — epic to Done, position `"top"`.
7. Restart this workflow at Step 1 using the first phase card.

After a phase completes, search In Progress for the next phase (not ToDo) so epic phases stay prioritized.

### Step 4 — Implement (TDD)

1. **Write failing test** — a test that captures the expected behavior.
2. **Run tests** — confirm the new test fails (test command from `.claude/rules/danx-repo-config.md`).
3. **Implement** — minimum code to make the test pass.
4. **Run tests** — all tests (new + existing) green.
5. **Refactor** — clean up; re-run tests.
6. **Type check** — command from `.claude/rules/danx-repo-config.md` (skip if empty).

**Documentation-only changes:** skip TDD, mark `Tests Written` / `Implementation` / `Tests Pass` together with a one-line note in a comment.

For large repetitive edits, spawn a `batch-editor` subagent via `Agent`/`Task`.

Mark `Tests Written`, `Implementation`, `Tests Pass` via `mcp__trello__update_checklist_item` as each completes.

### Step 5 — Quality Gates

Launch in parallel via `Agent`/`Task` with `mode: "bypassPermissions"`:
- `test-reviewer` — audit coverage.
- `code-reviewer` — review quality.

Post each result as a Trello comment via `mcp__trello__add_comment`:
- `## Test Review\n\n{output}`
- `## Code Review\n\n{output}`

If critical issues are found, fix them directly, re-run the failed gate, and post a `## Review Fixes` comment summarizing the fixes.

Mark `Code Review` complete.

### Step 6 — Check Off Acceptance Criteria

For each AC item, verify it holds (test evidence, command output, direct code read) then call `mcp__trello__update_checklist_item` with `state: "complete"`. All AC items MUST be checked before committing. **Never check off an unverified item** (see `trello.md`).

### Step 7 — Commit

Consult `Git Mode` in `.claude/rules/danx-repo-config.md`:
- `auto-merge`: feature branch `danxbot/<kebab-case-title>`, stage + commit, push, merge to main, delete branch.
- `pr`: feature branch, stage + commit, push, `gh pr create`.

Mark `Committed` complete.

### Step 8 — Complete

1. `mcp__trello__move_card` — card to Done list, position `"top"`.
2. **Bug cards:** `mcp__trello__add_comment` with a `## Bug Diagnosis` block (Problem / Root Cause / Solution).
3. `mcp__trello__add_comment` with a retro:
   ```
   ## Retro

   **What went well:** [1-2 sentences]
   **What went wrong:** [1-2 sentences or "Nothing"]
   **Action items:** [improvements or "Nothing"]
   **Commits:** [sha(s)]
   ```
4. **Action item cards:** if action items aren't "Nothing", `mcp__trello__add_card_to_list` on the Action Items list (one per item, position `"top"`). Then `mcp__trello__add_comment` on the current card linking them.

### Step 9 — Signal Completion (MANDATORY)

Call the `danxbot_complete` MCP tool once, at the very end, with:
- `status`: `"completed"` if the card finished or was moved to Needs Help; `"failed"` if a fatal error stopped the work.
- `summary`: one-line outcome (card title + commit sha, or the Needs Help reason, or the failure cause).

The worker uses this signal to finalize the MySQL row, SIGTERM the Claude process, and resume polling. Never exit without `danxbot_complete`.

---

## If the ToDo list was empty (from Step 1 of top-level Steps)

Run `.claude/tools/danx-self-terminate.sh $PPID` via `Bash` after `danxbot_complete`. The script checks `DANXBOT_EPHEMERAL` and handles lock file removal + process termination atomically.
