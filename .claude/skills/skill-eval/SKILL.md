---
name: skill-eval
description: |
  Run a one-shot skill-trigger probe. Given a query string and an expected
  `<plugin>:<skill>` name, dispatch the query into the isolated
  `skill-eval` workspace via the local danxbot worker (host-mode interactive,
  never `claude -p`), then assert whether the dispatched agent invoked the
  expected skill BEFORE producing its first assistant text block. Prints a
  single PASS/FAIL line plus the JSONL path. Intended use: skill-trigger
  regression checks ("does `dev:debugging` still fire on bug-language
  summary prompts?"). Invoke when the operator types `/skill-eval --query
  "<prompt>" --expect-skill <plugin>:<skill>` OR explicitly requests a
  one-shot probe for whether a particular skill loads on a given prompt.
---

# Skill-Eval — one-shot trigger probe

Minimal harness. Its only job is to prove that a single prompt either DOES
or DOES NOT cause a dispatched agent to load a given plugin skill. One
input prompt, one expected skill, one PASS/FAIL verdict.

## Invocation

```
/skill-eval --query "<prompt-text>" --expect-skill <plugin>:<skill>
```

Optional flags (rarely needed):

- `--workspace <name>` — defaults to `skill-eval`
- `--repo <name>` — defaults to `danxbot`
- `--worker-port <n>` — defaults to `$DANXBOT_WORKER_PORT` (read from
  `<repo>/.danxbot/.env`)
- `--timeout-ms <n>` — defaults to 5 minutes
- `--poll-interval-ms <n>` — defaults to 2 seconds

## What to do when the skill is invoked

1. **Parse the arguments.** Pull `--query` and `--expect-skill` out of the
   user's invocation. If either is missing, tell the operator the
   required form (see above) and stop — do NOT make up a default query
   or skill name.

2. **Run the runner.** Single Bash call:

   ```bash
   npx tsx <repo-root>/src/skill-eval/run.ts \
     --query "<exactly the operator's query>" \
     --expect-skill <expected-skill>
   ```

   `<repo-root>` is the danxbot install root (e.g.
   `/home/newms/web/danxbot`). The runner discovers the worker port
   from `$DANXBOT_WORKER_PORT` env var or `--worker-port`.

3. **Surface the runner output verbatim.** The runner writes:
   - line 1: `PASS <reason>` or `FAIL <reason>`
   - line 2: `jsonl: <absolute-path>`
   - line 3: `dispatch_tag: <!-- danxbot-dispatch:<jobId> -->`
   - on FAIL: additional lines for `observed_skills:` and
     `first_assistant_text:`.

   Do not paraphrase. The operator wants the literal PASS/FAIL and the
   JSONL path so they can grep for themselves.

4. **Exit codes.** The runner exits `0` on PASS, `1` on FAIL, `2` on
   runner error (worker unreachable, dispatch never reached terminal
   state, JSONL not found). Surface non-zero exits to the operator with
   the runner's stderr lines.

## Architecture (read once)

- **Workspace:** `<repo>/.danxbot/workspaces/skill-eval/` — fully
  isolated so probe JSONLs do not pollute the `issue-worker` /
  `system-test` projects directories. Same plugin set as `issue-worker`
  (`base`, `investigate`, `dev`, `pipeline`, `danxbot`) so any **plugin
  skill** that can fire in production can fire here. Workspace-injected
  danxbot skills (`/danx-next`, `/danx-start`, the issue-worker SKILL.md
  set under `src/poller/inject/workspaces/issue-worker/.claude/skills/`)
  are NOT installed in this workspace and cannot be probed by name — the
  harness is designed for plugin-skill trigger regression checks, not
  for whole-workflow rehearsal.

- **Dispatch surface:** the runner POSTs to `POST /api/launch` on the
  local worker, which is the exact entry point `make test-system` uses.
  No new HTTP routes, no new MCP servers — `dispatch()` from
  `src/dispatch/core.ts` is the only spawn path.

- **Host-mode only:** the runner never invokes `claude` directly. The
  worker handles the spawn shape; on the developer's host that means
  `script -q -f` wrapping interactive claude inside a Windows Terminal
  tab, NEVER `claude -p`. Bugs #36570 and #556 (Claude Code repo) affect
  `-p`-mode skill loading in ways that would invalidate every verdict —
  the harness sidesteps them by routing through host-mode dispatch.

- **JSONL parsing:** `src/skill-eval/jsonl-parser.ts` is pure. It finds
  the dispatch tag, walks entries in order, and matches the first
  `Skill` tool_use (`name: "Skill"`, `input.skill === expected`) against
  the first non-empty assistant text block.

## Limitations

- One probe per invocation. Parallel runs are a future enhancement.
- No eval-set format yet. The operator hand-supplies the query.
- No accuracy aggregation. One PASS/FAIL per call.
- Sub-agent skill calls (`isSidechain: true`) do not count — only the
  top-level session.

## Cost note

Each probe is one real Claude API dispatch (roughly the cost of a single
`/danx-next` pickup minus the implementation work — typically pennies
for a short prompt). The default runner `--timeout-ms` is 5 minutes, so
a stalled probe burns up to that wall-clock time waiting on the worker
before giving up. Drop `--timeout-ms` for short probes against
known-fast prompts. The budget cap is enforced upstream by the worker,
not the runner.
