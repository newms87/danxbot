---
name: next-card
description: Pull the top card from ToDo and run the full orchestrator workflow for just that one card.
---

# Next Card

Process a single card from the ToDo list.

## Steps

1. Fetch cards from the ToDo list (ID: `698fc5be16a280cc321a13ec`, Board: `698fc5b8847b787a3818ad82`)
2. If the list is empty, report "No cards to process" and stop
3. Take the top card (first in the list)
4. Report which card is being processed
5. Launch the orchestrator agent to process ONLY this one card
6. The orchestrator will:
   - Move card to In Progress
   - Create progress checklist
   - Plan the implementation
   - Evaluate scope (split into epic if needed)
   - Launch implementor for TDD
   - Run quality gates (test-reviewer, code-reviewer, validator if needed)
   - Commit changes
   - Move to Done
   - Add retro comment
7. Stop after this single card is complete (do NOT loop to the next card)
8. Report the result:
   - Card title and outcome (completed/failed)
   - What was implemented
   - Any issues encountered
