---
name: next-card
description: Pull the top card from ToDo and run the full autonomous workflow for just that one card.
---

# Next Card

Process a single card from the ToDo list. YOU are the orchestrator — do NOT launch a separate orchestrator agent.

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

### 1. Pick Up Card

1. Fetch cards from the ToDo list (ID: `698fc5be16a280cc321a13ec`)
2. If the list is empty, report "No cards to process" and stop
3. Take the top card (first in the list)
4. Report which card is being processed
5. Move the card to In Progress (ID: `698fc5c27de7e01f2884f58f`)

### 2. Create Progress Checklist

Add a "Progress" checklist to the card with items:
- Planning
- Tests Written
- Implementation
- Tests Pass
- Code Review
- Committed

### 3. Plan

1. Read the card description
2. Fetch the "Acceptance Criteria" checklist using `get_acceptance_criteria` (cardId). These criteria were written by the ideator and define what "done" means for this card
3. Design the implementation approach, ensuring every acceptance criterion is addressed. Consider:
   - Which files need to change
   - What tests are needed
   - What the TDD sequence looks like

Check off "Planning" on the Progress checklist.

### 4. Evaluate Scope

If the plan has 3+ distinct phases, different domains, or >500 estimated lines — split into an epic:
1. Create N new cards at the **top** of ToDo, named: `Epic Name > Phase N > Description`
2. Each card gets its own description and acceptance criteria
3. Move the original card to Done with a comment explaining the split
4. Pick up the first phase card and continue

### 5. Delegate to Implementor

Launch the `implementor` subagent via the Task tool with `mode: "bypassPermissions"`:
- Pass the card ID, card title, implementation plan, AND the acceptance criteria items
- The implementor does strict TDD: failing test first, implement, pass, refactor
- Wait for the implementor to complete and report back

Check off "Tests Written", "Implementation", and "Tests Pass" on the Progress checklist as they complete.

### 6. Quality Gates

Run these subagents in parallel via the Task tool with `mode: "bypassPermissions"`:
- **test-reviewer**: Audits test coverage (read-only)
- **code-reviewer**: Checks code quality (read-only)

Only if changes touch `src/agent/` files, Claude SDK, or router behavior:
- **validator**: Runs real API validation tests ($2 budget)

If any gate reports critical issues, relaunch the implementor with specific fix instructions, then re-run the failed gate.

Check off "Code Review" on the Progress checklist.

### 7. Check Off Acceptance Criteria

After implementation and quality gates pass, verify each acceptance criterion is satisfied and check them off using `update_checklist_item` (cardId, checkItemId, state: "complete"). All acceptance criteria MUST be checked off before committing.

### 8. Commit

Stage and commit all changes with a descriptive commit message. Check off "Committed" on the Progress checklist.

### 9. Complete

1. Move card to Done (ID: `698fc5c3396c0c24e921e3f5`)
2. Add a retro comment covering:
   - What went well
   - What went wrong
   - Mistakes made and corrected
   - Workflow optimization ideas

### 10. Stop

Stop after this single card is complete. Do NOT loop to the next card. Report the result:
- Card title and outcome (completed/failed)
- What was implemented
- Any issues encountered
