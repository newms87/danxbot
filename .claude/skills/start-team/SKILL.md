---
name: start-team
description: Launch the autonomous agent team to process all ToDo cards from the Trello board.
---

# Start Team

Process all cards in the ToDo list using the autonomous agent team.

## Steps

1. Fetch all cards from the ToDo list (ID: `698fc5be16a280cc321a13ec`, Board: `698fc5b8847b787a3818ad82`)
2. If the list is empty, report "No cards to process" and stop
3. Report how many cards are queued
4. Launch the orchestrator agent to process ALL cards sequentially
5. The orchestrator will:
   - Pick up each card from ToDo
   - Move to In Progress
   - Plan, implement (via implementor), test, review, validate
   - Commit and move to Done
   - Add retro comment
   - Loop until ToDo is empty
6. When the orchestrator finishes, report a summary:
   - Total cards processed
   - Cards completed vs failed
   - Total time elapsed
