---
name: next-card
description: Pull the top card from ToDo and run the full autonomous workflow for just that one card.
---

# Next Card

Process a SINGLE card from the ToDo list using the orchestrator workflow defined in `.claude/rules/orchestrator.md`.

## Steps

1. Fetch cards from the ToDo list
2. If the list is empty, report "No cards to process" — then execute the self-termination check below
3. Take the top card (first in the list) and report which card is being processed
4. Process the card using the Card Processing Workflow (Steps 1-8 in the orchestrator rule)
5. **Stop after this single card.**
6. **MANDATORY — Self-termination check (never skip):** Run `./scripts/self-terminate.sh $PPID` via Bash. The script checks `DANXBOT_EPHEMERAL` and handles lock file removal and process termination atomically. Never assume you know the session type — always run the script.

## Report

- Card title and outcome (completed/failed/needs-help)
- What was implemented
- Any issues encountered
