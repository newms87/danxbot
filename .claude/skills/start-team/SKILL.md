---
name: start-team
description: Process all ToDo cards from the Trello board sequentially using the autonomous workflow.
---

# Start Team

Process all cards in the ToDo list sequentially. YOU are the orchestrator — do NOT launch a separate orchestrator agent.

## Trello Board

Board ID: `698fc5b8847b787a3818ad82`

| List | ID |
|------|----|
| Review | `698fc5bdfa44ac685050fa35` |
| ToDo | `698fc5be16a280cc321a13ec` |
| In Progress | `698fc5c27de7e01f2884f58f` |
| Done | `698fc5c3396c0c24e921e3f5` |
| Cancelled | `698fc5c598cfdb751069f71c` |

## Steps

### 1. Survey the Queue

1. Fetch all cards from the ToDo list (ID: `698fc5be16a280cc321a13ec`)
2. If the list is empty, report "No cards to process" and stop
3. Report how many cards are queued and list their titles

### 2. Process Each Card

For each card in the ToDo list (top to bottom), run the full workflow:

#### a. Pick Up Card
1. Move card to In Progress (ID: `698fc5c27de7e01f2884f58f`)
2. Add a "Progress" checklist with items: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

#### b. Plan
1. Read the card description
2. Fetch the "Acceptance Criteria" checklist using `get_acceptance_criteria` (cardId). These criteria were written by the ideator and define what "done" means for this card
3. Design the implementation approach, ensuring every acceptance criterion is addressed
4. Check off "Planning"

#### c. Evaluate Scope
If 3+ phases, different domains, or >500 lines — split into epic:
1. Create N new cards at **top** of ToDo: `Epic Name > Phase N > Description`
2. Move original to Done with split comment
3. Pick up first phase card instead

#### d. Delegate to Implementor
Launch the `implementor` subagent via Task tool with `mode: "bypassPermissions"`:
- Pass card ID, title, implementation plan, AND the acceptance criteria items
- Strict TDD: failing test, implement, pass, refactor
- Check off "Tests Written", "Implementation", "Tests Pass"

#### e. Quality Gates
Launch in parallel via Task tool with `mode: "bypassPermissions"`:
- **test-reviewer**: Audit test coverage
- **code-reviewer**: Check code quality
- **validator**: Only if changes touch `src/agent/`, Claude SDK, or router

If critical issues found, relaunch implementor with fixes, re-run failed gate.
Check off "Code Review".

#### f. Check Off Acceptance Criteria
After implementation and quality gates pass, verify each acceptance criterion is satisfied and check them off using `update_checklist_item` (cardId, checkItemId, state: "complete"). All acceptance criteria MUST be checked off before committing.

#### g. Commit
Stage and commit changes. Check off "Committed".

#### h. Complete
1. Move card to Done (ID: `698fc5c3396c0c24e921e3f5`)
2. Add retro comment (what went well, what went wrong, optimizations)

### 3. Loop

Return to step 2 and process the next card. Continue until ToDo is empty.

**Important:** Re-fetch the ToDo list before each card in case epic splitting added new cards.

### 4. Report Summary

When all cards are processed:
- Total cards processed
- Cards completed vs failed
- Key issues encountered
