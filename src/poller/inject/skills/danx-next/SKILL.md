---
name: danx-next
description: Pull the top card from ToDo and run the full autonomous card processing workflow.
---

# Danx Next Card

Process a SINGLE card from the ToDo list using the card processing workflow below.

## Steps

1. Fetch cards from the ToDo list
2. If the list is empty, report "No cards to process" — then signal completion (Step 6)
3. Take the top card (first in the list) and report which card is being processed
4. Process the card using the Card Processing Workflow (below)
5. **Stop after this single card.**
6. **MANDATORY — Signal completion (never skip):** Call the `danxbot_complete` MCP tool with `status: "completed"` (or `"failed"`) and a one-line `summary`. The worker uses this signal to finalize the dispatch row, terminate the Claude process, and resume polling. Do not exit without calling it.

## Report

- Card title and outcome (completed/failed/needs-help)
- What was implemented
- Any issues encountered

---

## Card Processing Workflow

Config references: `.claude/rules/danx-trello-config.md` (Trello IDs), `.claude/rules/danx-repo-config.md` (repo commands). Never hardcode IDs. Every card MUST have a label (Bug or Feature).

YOU are the orchestrator. Do NOT launch a separate orchestrator agent.

### Step 1: Pick Up Card

1. Move card to In Progress (position: `"top"`)
2. Add appropriate label (Bug or Feature) if missing using `update_card_details`
3. Add Progress checklist: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

### Step 2: Plan

1. Read card description, labels, and all comments via `get_card_comments` (cardId)
2. Fetch "Acceptance Criteria" checklist via `get_acceptance_criteria` (cardId)
3. **For Bug cards:** Investigate root cause first
4. **Check for Needs Help:** If task requires human intervention (Slack/Trello settings, external config, manual setup), add `Needs Help` label, comment with explanation + `<!-- danxbot -->` marker, move to Needs Help list (position: `"top"`), skip this card
5. Design implementation approach
6. Invoke `/wow` to load Ways of Working skill for recency
7. Check off "Planning"

### Step 3: Evaluate Scope

If 3+ phases, different domains, or >500 lines: split into epic.

1. Change parent label to Epic via `update_card_details` (Epic label ID from `.claude/rules/danx-trello-config.md`)
2. Add "Phases" checklist with one item per phase
3. Create N phase cards in In Progress (position: `"top"`): `Epic Title > Phase N: Description`
4. Each phase card: own description, acceptance criteria, Bug or Feature label
5. Add split comment listing all phases to epic
6. Move epic to Done (position: `"top"`)
7. Pick up first phase card

After completing a phase, search In Progress for next phase (not ToDo) — keeps epic phases prioritized.

### Step 4: Implement (TDD)

1. **Write failing test** — Create/update test with expected behavior
2. **Run tests** — Confirm test fails. Read test command from `.claude/rules/danx-repo-config.md`
3. **Implement** — Minimum code to pass
4. **Run tests** — Verify all pass (new + existing)
5. **Refactor** — Clean up, re-run tests
6. **Type check** — Read type check command from `.claude/rules/danx-repo-config.md` (skip if empty)

**Documentation-only changes:** Skip TDD, check off "Tests Written", "Implementation", "Tests Pass" together.

For large repetitive edits, launch `batch-editor` subagent via Task tool.

Check off "Tests Written", "Implementation", "Tests Pass".

### Step 5: Quality Gates

Launch in parallel via Task tool with `mode: "bypassPermissions"`:
- **test-reviewer** (audit coverage)
- **code-reviewer** (check quality)

Post results as Trello comments via `add_comment`: `## Test Review\n\n{output}`, etc. If critical issues found, fix directly and re-run failed gate, then post follow-up: `## Review Fixes\n\n{summary}`.

Check off "Code Review".

### Step 6: Check Off Acceptance Criteria

Verify each criterion is satisfied. Check off via `update_checklist_item` (cardId, checkItemId, state: "complete"). All criteria MUST be checked before committing.

### Step 7: Commit

Check `Git Mode` in `.claude/rules/danx-repo-config.md`. If `auto-merge`: create feature branch (`danxbot/<kebab-case>`), stage/commit, push, merge to main, delete branch. If `pr`: create feature branch, stage/commit, push, create PR via `gh pr create`.

Check off "Committed".

### Step 8: Complete

1. Move card to Done (position: `"top"`)
2. **For Bug cards:** Add "Bug Diagnosis" comment: Problem, Root Cause, Solution
3. Add retro comment:
```
## Retro

**What went well:** [1-2 sentences]
**What went wrong:** [1-2 sentences or "Nothing"]
**Action items:** [improvements or "Nothing"]
**Commits:** [sha(s)]
```

4. **Create Action Item cards** (if action items not "Nothing"): One card per item in Action Items list. Update retro comment with links.

### Step 9: Signal Completion (MANDATORY)

After EVERY card completion or Needs Help move, call the `danxbot_complete` MCP tool:

- `status`: `"completed"` if the card was finished successfully or moved to Needs Help; `"failed"` if a fatal error stopped the work.
- `summary`: one-line description of the outcome (e.g. card title + commit sha, or the reason the card was moved to Needs Help, or the failure cause).

The worker uses this signal to finalize the dispatch row in MySQL, SIGTERM the Claude process, and resume polling. The poller spawns a fresh Claude per card — one card per instance. Do not exit without calling `danxbot_complete`; an agent that exits naturally still terminates, but the dispatch row is left without a proper summary/status.
