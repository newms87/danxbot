# system-evaluator workspace

Dispatched cwd for the post-3-strike root-cause evaluator (DX-367 — Phase 4
of DX-363). Spawned by `src/agent/evaluator-dispatcher.ts` when an agent's
strike count crosses `STRIKES_MAX` and `agent.broken` flips from `null` to
populated.

## Job

Read the 3 dispatch JSONLs named in the prompt, identify the failure
mode(s) across the strikes, and call `danxbot_set_evaluator_summary` with
a structured markdown summary the operator banner (Phase 6) will render.

## Tools

- `danxbot_set_evaluator_summary` — the single write surface. Writes
  `{reason, suggested_steps}` to the target agent's `broken` record
  (`agent.broken.reason` + `agent.broken.suggested_steps`) and stamps
  `agent.broken.evaluator_status = "completed"`. Required call before
  `danxbot_complete`.
- `danxbot_complete` — always signal `completed` when the summary write
  succeeded, `failed` otherwise.
- Read issue context at `<repo>/.danxbot/issues/open/<id>.yml` (fall back
  to `closed/<id>.yml`) with the `Read` tool if the strike's `issue_id`
  is relevant to the failure analysis. For multi-card scans use
  `mcp__danx-issue__danx_issue_list`.
- `Bash` / `Read` / `Grep` — find + read the JSONL session logs.

## Finding the JSONL files

The dispatcher passes each strike's `dispatch_id` in the prompt body. Each
JSONL session log lives under `~/.claude/projects/<encoded-cwd>/`. To find
the session file for a given dispatch_id:

```bash
grep -lr "danxbot-dispatch:<dispatch_id>" ~/.claude/projects/ | head -1
```

Read the resulting file with `Read`. If the grep returns no matches, the
JSONL was rotated or never written — note that strike as unreadable in
the summary; do NOT fail the dispatch over a missing file.

## Output shape

Call `danxbot_set_evaluator_summary({reason, suggested_steps})` with:

- `reason` — markdown body the dashboard banner renders. Structure:

  ```
  ## Root cause(s)
  <1–3 bullets identifying distinct root causes across the 3 strikes>

  ## Per-strike detail
  - Strike 1 (<issue-id>, <terminal-status>, <timestamp>): <2–3 sentences>
  - Strike 2 (...): <2–3 sentences>
  - Strike 3 (...): <2–3 sentences>

  ## Recommended human action
  <1 paragraph: what the operator should investigate / fix / decide>
  ```

- `suggested_steps` — ordered list of concrete operator actions
  (`["Check git auth on the worktree", "Review the failing test in <file>", ...]`).
  Empty array is allowed when the root cause has no clear operator action;
  the banner falls back to displaying just the `reason` markdown.
