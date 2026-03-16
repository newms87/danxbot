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
6. **MANDATORY — Self-termination check (never skip):** Run `echo $DANXBOT_EPHEMERAL` and check the output. If the value is `1`, execute `rm -f .poller-running && kill $PPID` immediately. If it is not `1`, do nothing. **You must always run this check — never assume you know the session type.**

## Report

- Card title and outcome (completed/failed/needs-help)
- What was implemented
- Any issues encountered
