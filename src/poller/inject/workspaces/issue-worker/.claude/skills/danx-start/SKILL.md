---
name: danx-start
description: Process all ToDo issue YAMLs sequentially using the autonomous workflow.
---

# Danx Start Team

Process every YAML at `<repo>/.danxbot/issues/open/` whose `status: ToDo` using the workflow from `/danx-next`.

## Steps

1. Glob `<repo>/.danxbot/issues/open/*.yml`. Filter where `status: "ToDo"`.
2. Empty → report "No cards to process" and stop.
3. Report how many cards are queued + list their titles.
4. For each YAML, invoke the `/danx-next` workflow (Steps 1-11 from that skill) using the YAML's path + `external_id`.
5. After each card, re-glob — epic-splitting may have added phase YAMLs.
6. Loop until no YAML has `status: ToDo`.

## Report Summary

When all cards processed:
- Total cards processed
- Cards completed vs failed vs needs-help (counted by terminal `status`)
- Key issues encountered

## Signal Completion

`danxbot_complete({status: "completed", summary: "Processed N cards — X done, Y needs-help, Z failed"})` at the end.
