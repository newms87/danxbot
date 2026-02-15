# Orchestrator — Card Processing Workflow

This rule defines how the autonomous agent team processes Trello cards. The `/start-team` and `/next-card` skills trigger this workflow.

## Trello Board

Board ID: `698fc5b8847b787a3818ad82` (always pass as `boardId` to Trello MCP tools)

| List | ID |
|------|----|
| Review | `698fc5bdfa44ac685050fa35` |
| ToDo | `698fc5be16a280cc321a13ec` |
| In Progress | `698fc5c27de7e01f2884f58f` |
| Needs Help | `6990129be21ee37b649281a5` |
| Done | `698fc5c3396c0c24e921e3f5` |
| Cancelled | `698fc5c598cfdb751069f71c` |

## Labels

Every card MUST have a label. Apply labels when creating cards or picking them up.

| Label | ID | Use |
|-------|----|-----|
| Bug | `698fc5b8847b787a3818adac` | Defects, crashes, incorrect behavior |
| Feature | `698fc5b8847b787a3818adae` | New functionality, enhancements |
| Needs Help | `698fc5b8847b787a3818adaa` | Requires human intervention |

## Card Processing Workflow

YOU are the orchestrator. Do NOT launch a separate orchestrator agent.

### Step 1: Pick Up Card

1. Move card to In Progress (position: `"top"`)
2. If the card has no label, add the appropriate label (Bug or Feature) using `update_card_details`
3. Add a "Progress" checklist with items: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

### Step 2: Plan

1. Read the card description and check the card's labels
2. Fetch the "Acceptance Criteria" checklist using `get_acceptance_criteria` (cardId). These criteria were written by the ideator and define what "done" means for this card
3. **For Bug cards:** Investigate the root cause first. Read logs, relevant source files, and error messages. Understand what's broken and why before planning the fix.
4. **Check for Needs Help:** If the task requires human intervention outside the dev environment (changing Slack/Trello settings, external service config, manual account setup, etc.), add the `Needs Help` label using `update_card_details`, add a comment explaining what help is needed, move the card to Needs Help list, and skip this card.
5. Design the implementation approach, ensuring every acceptance criterion is addressed
6. Check off "Planning"

### Step 3: Evaluate Scope

If 3+ phases, different domains, or >500 lines — split into epic:
1. Create N new cards in ToDo (position: `"top"`): `Epic Name > Phase N > Description`
2. Each card gets its own description and acceptance criteria
3. Move original to Done with split comment
4. Pick up first phase card instead

### Step 4: Implement (TDD)

The orchestrator implements the code directly using strict TDD:

1. **Write failing test** — Create or update test file with tests that verify the expected behavior
2. **Run tests** — `npx vitest run` — Confirm the new test fails
3. **Implement** — Write the minimum code to make the test pass
4. **Run tests** — Confirm all tests pass (new AND existing)
5. **Refactor** — Clean up if needed, run tests again
6. **Type check** — `npx tsc --noEmit`

For large-scale repetitive edits (renaming across many files, pattern upgrades, etc.), launch a `batch-editor` subagent via the Task tool.

Check off "Tests Written", "Implementation", "Tests Pass".

### Step 5: Quality Gates

Launch in parallel via Task tool with `mode: "bypassPermissions"`:
- **test-reviewer**: Audit test coverage
- **code-reviewer**: Check code quality
- **validator**: Only if changes touch `src/agent/`, Claude SDK, or router

If critical issues found, fix them directly and re-run the failed gate.
Check off "Code Review".

### Step 6: Check Off Acceptance Criteria

After implementation and quality gates pass, verify each acceptance criterion is satisfied and check them off using `update_checklist_item` (cardId, checkItemId, state: "complete"). All acceptance criteria MUST be checked off before committing.

### Step 7: Commit

Stage and commit changes. Check off "Committed".

### Step 8: Complete

1. Move card to Done (position: `"top"`)
2. **For Bug cards:** Add a "Bug Diagnosis" comment with: Problem (what the user saw), Root Cause (why it happened), Solution (what was changed and why)
3. Add retro comment (what went well, what went wrong, optimizations)

### Step 9: Self-Terminate

After ALL cards are processed (or when the workflow is fully complete), remove the lock file and terminate the Claude process so the terminal tab closes:

```bash
rm -f .poller-running && kill $PPID
```

The lock file removal signals the poller that work is complete. The `kill $PPID` kills the Claude CLI process, and the parent bash shell exits, closing the terminal tab. This step is MANDATORY — never leave the session open after work is done.
