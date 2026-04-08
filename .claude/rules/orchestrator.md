# Orchestrator — Card Processing Workflow

This rule defines how the autonomous agent team processes Trello cards. The `/start-team` and `/next-card` skills trigger this workflow.

Config references: `.claude/rules/trello-config.md` (Trello IDs), `.claude/rules/repo-config.md` (repo commands). Never hardcode IDs. Every card MUST have a label (Bug or Feature).

YOU are the orchestrator. Do NOT launch a separate orchestrator agent.

## Step 1: Pick Up Card

1. Move card to In Progress (position: `"top"`)
2. Add appropriate label (Bug or Feature) if missing using `update_card_details`
3. Add Progress checklist: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

## Step 2: Plan

1. Read card description, labels, and all comments via `get_card_comments` (cardId)
2. Fetch "Acceptance Criteria" checklist via `get_acceptance_criteria` (cardId)
3. **For Bug cards:** Investigate root cause first
4. **Check for Needs Help:** If task requires human intervention (Slack/Trello settings, external config, manual setup), add `Needs Help` label, comment with explanation + `<!-- danxbot -->` marker, move to Needs Help list (position: `"top"`), skip this card
5. **Detect target repo:** Card targets danxbot (`src/`) or connected repo (`repos/<name>/`)? Check description for domain/framework/model references. If connected repo, follow `.claude/rules/repo-workflow.md` (feature branches, no direct main commits)
6. Design implementation approach
7. Invoke `/wow` to load Ways of Working skill for recency
8. Check off "Planning"

## Step 3: Evaluate Scope

If 3+ phases, different domains, or >500 lines: split into epic.

1. Change parent label to Epic via `update_card_details` (Epic label ID from `.claude/rules/trello-config.md`)
2. Add "Phases" checklist with one item per phase
3. Create N phase cards in In Progress (position: `"top"`): `Epic Title > Phase N: Description`
4. Each phase card: own description, acceptance criteria, Bug or Feature label
5. Add split comment listing all phases to epic
6. Move epic to Done (position: `"top"`)
7. Pick up first phase card

After completing a phase, search In Progress for next phase (not ToDo) — keeps epic phases prioritized.

## Step 4: Implement (TDD)

1. **Write failing test** — Create/update test with expected behavior
2. **Run tests** — Confirm test fails. For danxbot: `npx vitest run`. For connected repo: read command from `.claude/rules/repo-config.md`
3. **Implement** — Minimum code to pass
4. **Run tests** — Verify all pass (new + existing)
5. **Refactor** — Clean up, re-run tests
6. **Type check** — `npx tsc --noEmit` for danxbot (skip for connected repo if empty)

**Documentation-only changes:** Skip TDD, check off "Tests Written", "Implementation", "Tests Pass" together.

For large repetitive edits, launch `batch-editor` subagent via Task tool.

Check off "Tests Written", "Implementation", "Tests Pass".

## Step 5: Quality Gates

Launch in parallel via Task tool with `mode: "bypassPermissions"`:
- **test-reviewer** (audit coverage)
- **code-reviewer** (check quality)
- **validator** (only for `src/agent/`, SDK, router changes)

Post results as Trello comments via `add_comment`: `## Test Review\n\n{output}`, etc. If critical issues found, fix directly and re-run failed gate, then post follow-up: `## Review Fixes\n\n{summary}`.

Check off "Code Review".

## Step 6: Check Off Acceptance Criteria

Verify each criterion is satisfied. Check off via `update_checklist_item` (cardId, checkItemId, state: "complete"). All criteria MUST be checked before committing.

## Step 7: Commit

**For danxbot cards:** Stage and commit directly.

**For connected repo cards:** Check `Git Mode` in `.claude/rules/repo-config.md`. If `auto-merge`: create feature branch (`danxbot/<kebab-case>`), stage/commit, push, merge to main, delete branch. If `pr`: create feature branch, stage/commit, push, create PR via `gh pr create`.

Check off "Committed".

## Step 8: Complete

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

## Step 9: Self-Termination (MANDATORY)

After EVERY card completion or Needs Help move, run: `./scripts/self-terminate.sh $PPID`

The script checks `DANXBOT_EPHEMERAL=1` and atomically removes the lock file and kills Claude Code if set. Never assume session type — always run the script. Poller spawns fresh Claude per card. One card per instance.
