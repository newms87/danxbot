---
name: next-card
description: Pull the top card from ToDo and run the full autonomous workflow for just that one card.
---

# Next Card

Process a SINGLE card from the ToDo list using the orchestrator workflow defined in `.claude/rules/orchestrator.md`.

## Steps

1. Fetch cards from the ToDo list
2. If the list is empty, report "No cards to process" and self-terminate: `rm -f .poller-running && kill $PPID`
3. Take the top card (first in the list) and report which card is being processed
4. Process the card using the Card Processing Workflow (Steps 1-9 in the orchestrator rule)
5. **Stop after this single card.** Step 9 handles self-termination.

## Report

- Card title and outcome (completed/failed/needs-help)
- What was implemented
- Any issues encountered
