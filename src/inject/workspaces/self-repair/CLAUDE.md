# self-repair workspace

Dispatched cwd for the per-error repair flow (DX-564 — Phase 4 of
DX-560 Self-Repair). Spawned by the picker when the candidate card's
title starts with `Self-Repair > Attempt N:` — the marker the
Phase-3 dispatcher (`src/cron/jobs/self-repair-dispatch.ts`) stamps
when it creates a repair attempt card under epic DX-560.

## Job

Read the card's `## Repair Target` block (signature hash + category
key + sample payload), root-cause the deterministic problem behind
the signature, apply a scoped fix, verify the originating error
stops reproducing, write a `## Repair Report` comment, then signal
a verdict-prefixed `danxbot_complete` (`fixed:` / `failed:` /
`unfixable:`) the Phase-3 finalize hook
(`src/system-repair/finalize.ts#parseVerdictFromSummary`) parses to
flip `system_errors.status` and stamp the `system_error_repairs`
row.

Full per-step contract lives in the `danxbot:self-repair` plugin
skill (auto-loaded via `danxbot@newms-plugins` enabled in
`.claude/settings.json`).

## Tools

- `mcp__danx-issue__danx_issue_save` / `mcp__danx-issue__danx_issue_create` —
  available but **scoped to the candidate card only**. Do NOT
  create follow-up cards from inside self-repair; the next dispatch
  handles attempt N+1.
- `danxbot_complete` — the verdict-prefixed terminal signal. The
  first line of `summary` MUST start with `fixed:` / `failed:` /
  `unfixable:` so `parseVerdictFromSummary` classifies the row
  correctly.
- `Read` / `Grep` / `Glob` / `Edit` / `Write` / `Bash` — standard
  agent toolbox for in-worktree investigation + fixes.
- `Agent` (subagent dispatch) — for the read-only investigator and
  the bounded builder. Skill body declares the boundary contract.

NOT available: no Slack tools, no Trello MCP, no schema MCP. The
`.mcp.json` declares ONLY the `danx-issue` server (DX-203 contract —
issues are local YAMLs; `DANX_REPO_ROOT` is the sole env the server
needs).

## What you can do

- Read this card's YAML at `<worktree>/.danxbot/issues/open/<id>.yml`
  (fall back to `closed/<id>.yml`) with the `Read` tool.
- Read any other file in the worktree (`Read`, `Grep`, `Glob`) to
  trace the root cause + plan the fix.
- Edit code, configs, or templates the verifier touches in Step 5
  of the skill body.
- Append a `## Repair Report` comment to the candidate's
  `comments[]` with `Edit` / `Write` on the YAML.

## What you do NOT do

- **Do NOT edit cards other than the candidate.** Authority is
  scoped to the dispatched card id; the PreToolUse worktree-guard
  hook rejects writes outside `<worktree>/`.
- **Do NOT flip the card YAML's `status` to `Done` / `Cancelled`.**
  Phase-3 finalize owns the lifecycle; double-mutating confuses
  the auto-sync.
- **Do NOT call `danx_issue_create`** — self-repair never spawns
  follow-up cards. The next dispatch handles attempt N+1 if the
  verdict is `failed`.
- **Do NOT run `make deploy` / `make launch-*`** — the
  `danxbot:no-unauthorized-worker-launch` skill applies. Self-repair
  is a local fix flow.

## Verdict prefix is load-bearing

`src/system-repair/finalize.ts#parseVerdictFromSummary` scans the
FIRST line of `danxbot_complete({summary})` for `unfixable`, `fixed`,
or `failed` (order matters — `unfixable` is checked before `fixed`
because the substring `fixable` would trap the matcher otherwise).
Always lead `summary` with one of:

- `fixed:<signature_hash>` — patches landed; verifier green; the
  hook flips `system_errors.status` to `fixed`.
- `failed:<signature_hash>:<one-line reason>` — verifier still
  throws; the hook leaves `system_errors.status` at `repairing` so
  the next tick can dispatch attempt N+1.
- `unfixable:<signature_hash>:<reason>` — no programmatic path
  exists; the hook flips `system_errors.status` to `unfixable`.

A successful repair without `fixed:` prefix is recorded as
`failed` by the default-branch in the parser. Read the skill body
(Step 7) for examples.
