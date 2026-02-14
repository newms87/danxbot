---
name: start-team
description: Process all ToDo cards from the Trello board sequentially using the autonomous workflow.
---

# Start Team

Process ALL cards in the ToDo list sequentially using the orchestrator workflow defined in `.claude/rules/orchestrator.md`.

## Steps

1. Fetch all cards from the ToDo list
2. If the list is empty, report "No cards to process" and stop
3. Report how many cards are queued and list their titles
4. Process each card using the Card Processing Workflow (Steps 1-8 in the orchestrator rule)
5. After each card, re-fetch the ToDo list (epic splitting may have added new cards)
6. Loop until ToDo is empty

## Report Summary

When all cards are processed:
- Total cards processed
- Cards completed vs failed vs needs-help
- Key issues encountered
