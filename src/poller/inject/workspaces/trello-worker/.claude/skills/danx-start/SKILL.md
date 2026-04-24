---
name: danx-start
description: Process all ToDo cards from the Trello board sequentially using the autonomous workflow.
---

# Danx Start Team

Process ALL cards in the ToDo list sequentially using the card processing workflow from `/danx-next`.

## Steps

1. Fetch all cards from the ToDo list
2. If the list is empty, report "No cards to process" and stop
3. Report how many cards are queued and list their titles
4. For each card, invoke `/danx-next` workflow (Steps 1-8 from that skill)
5. After each card, re-fetch the ToDo list (epic splitting may have added new cards)
6. Loop until ToDo is empty

## Report Summary

When all cards are processed:
- Total cards processed
- Cards completed vs failed vs needs-help
- Key issues encountered
