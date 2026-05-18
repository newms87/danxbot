# worker-repair workspace

Dispatched cwd for the Self-Repair rebuild (DX-580 epic; this workspace
landed in DX-650 Phase 1). Spawned by the Self-Repair dispatcher
(Phase 2) when a `system_errors` row whose `category` passes
`isWorkerFaultCategory()` (`src/system-repair/dispatch-pick.ts`)
needs an autonomous fix attempt against the danxbot codebase.

The dispatch is **card-LESS** — there is no issue YAML, no `issue_id`,
no `parent_id`. The unit of work is the `system_errors` row payload
inlined in the prompt body. Lifecycle is keyed on the dispatch row.

## Job

Read the error signature + sample payload in the prompt body, identify
the worker-fault root cause in the danxbot source tree, ship a fix that
makes the failing code path succeed AND adds (or extends) a unit test
that pins the new behavior. Then call `danxbot_complete` with the
verdict prefix on `summary` so the dispatcher can categorize the
outcome.

## Tools

- **`Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob`** — full
  access to the danxbot source tree at `$DANX_REPO_ROOT`. Edit
  `src/**/*.ts`, write new files, run `npx vitest run …` /
  `npx tsc --noEmit` to verify.
- **`danxbot_complete`** — the single terminal signal. The `summary`
  string MUST start with one of the three verdict prefixes:
  - `fixed: <one-sentence change summary> @ <commit-sha>` — the
    failing code path now works AND a unit test pins it. Commit MUST
    be on `origin/main` before signalling.
  - `unfixable: <one-sentence reason>` — the root cause is outside
    the danxbot source tree (3rd-party dependency, claude CLI bug,
    OS-level breakage). Operator action required.
  - `failed: <one-sentence reason>` — the dispatch attempted a fix
    but tests / typecheck did not converge within the available
    budget. Operator should review the partial work in the dispatch
    JSONL.

## Forbidden patterns

- **No YAML edits.** This dispatch is card-less. Do NOT read or write
  any `<repo>/.danxbot/issues/**/*.yml`. Do NOT call `mcp__danx-issue__*`
  tools. Do NOT call `mcp__danxbot__danx_issue_create`.
- **No card mutations.** No `assigned_agent` changes, no `comments[]`
  appends, no triage stamps, no `blocked` / `waiting_on` records on
  any card. The worker-fault context is captured in the
  `system_errors` row and the dispatch JSONL — neither belongs on an
  issue card.
- **No `dispatch()` recursion.** Do not invoke the danxbot worker's
  `/api/launch` / `/api/resume` endpoints; do not enqueue cards; do
  not write `dispatch:` records. Spawning agents from inside a repair
  agent is a fast path to the DX-560 loop class.
- **No Trello / tracker calls.** Same reasoning — repair work is
  scoped to the source tree, not the issue surface.
- **No `git push --force` (without `--force-with-lease`).** Standard
  agent-finalize rules apply if you commit (rebase onto
  `origin/main`, `--force-with-lease` only).

## Why a separate workspace

The default `issue-worker` workspace assumes a card-shaped unit of
work and ships the danx-issue MCP toolchain. A repair agent that
inherited that toolchain could (and would, eventually) mutate cards
in response to a worker fault, conflating worker-domain bookkeeping
with agent-domain card lifecycle. Isolating the cwd + MCP surface
forces the boundary at the workspace layer.
