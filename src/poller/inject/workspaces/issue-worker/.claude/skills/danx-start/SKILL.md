---
name: danx-start
description: Process all ToDo issue YAMLs sequentially using the autonomous workflow.
---

# Danx Start Team

Process every YAML at `<repo>/.danxbot/issues/open/` whose `status: ToDo` using the workflow from `/danx-next`.

## Resume self-check (read first, every dispatch — ISS-135)

Before processing ANY card, read the YAML. If status is terminal (`Done` / `Cancelled`) AND every AC item is checked AND retro is filled — the prior session already finished that card. Call `danxbot_complete({status: "completed", summary: "Prior session already completed; verified terminal state on resume."})` and stop. **Do not redo work.** Do not flip status. Do not re-save the YAML. The full per-card contract lives in the `danx-next` skill's Step 1.1 — load it via the Skill tool when in doubt.

This guards against the May-7 incident: an orphan-resumed agent that re-runs `/danx-start` from scratch against a card whose prior session already shipped the work creates duplicate retro comments and duplicate `danxbot_complete` calls. The self-check is a 30-second read that costs zero tokens of redo.

## /loop and ScheduleWakeup — narrow contract

You may use Claude Code's `/loop` skill (and the underlying
`ScheduleWakeup` tool) ONLY for in-card async monitoring. Anything else is
a workflow violation — dispatched agents have one exit
(`danxbot_complete`); using `/loop` to defer completion or wait for state
outside this card's scope is the May-7 failure mode (ISS-135 / ISS-136).

**ALLOWED:**

- Polling an async pipeline whose result IS part of this card's AC (e.g.
  dispatch a build, `/loop` every 5 min until it finishes, then verify the
  artifact and proceed).
- Monitoring a long-running test whose pass/fail is the AC under test.
- Watching for the next state of an external system you triggered AS PART
  OF THIS CARD's WORK.

**FORBIDDEN:**

- Waiting for a human to reply (use `status: Blocked` instead — the
  operator opens the card, answers, moves it back).
- Waiting for the next card to land (the poller dispatches; you exit when
  this card is done).
- "Let me check on this in N minutes" for anything outside this card's
  scope.
- Arming `/loop` and then calling `danxbot_complete` in the same dispatch.
  Loop owns completion timing — if you call complete, disarm the loop
  first; if a loop is active, do not call complete.

**RULE:** when you call `danxbot_complete`, every `ScheduleWakeup` armed
during this dispatch must be disarmed (or have already fired and exited).
Active loop + complete signal = workflow violation; the next resume will
re-fire the loop after the dispatch is logically over.

## Steps

1. Glob `<repo>/.danxbot/issues/open/*.yml`. Filter where `status: "ToDo"`.
2. Empty → report "No cards to process" and stop.
3. Report how many cards are queued + list their titles.
4. For each YAML, invoke the `/danx-next` workflow (Steps 1-11 from that skill) using the YAML's path + `id`. The first step inside `/danx-next` is the same Resume self-check above — terminal-state cards short-circuit there. Step 10 handles Blocked moves, Step 10b handles Waiting On moves.
5. After each card, re-glob — epic-splitting may have added phase YAMLs.
6. Loop until no YAML has `status: ToDo`.

## Report Summary

When all cards processed:
- Total cards processed
- Cards completed vs failed vs blocked (counted by terminal `status`)
- Key issues encountered

## Signal Completion

`danxbot_complete({status: "completed", summary: "Processed N cards — X done, Y blocked, Z failed"})` at the end.
