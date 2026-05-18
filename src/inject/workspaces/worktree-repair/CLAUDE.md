# worktree-repair workspace

Dispatched cwd for the self-healing sync repair (DX-645 — Phase 3 of
DX-576). Spawned by `src/agent/sync-repair-dispatcher.ts` when
`dispatchWithRecovery` observes `syncWorktree.kind === "abort"` — the
prior dispatch left autosave commits the rebase-onto-`origin/main`
cannot fast-forward, AND the picker has stamped
`agents.<broken-agent>.broken` as the gate so no further dispatch
lands until you resolve.

## Pre-task sync

The Pre-task contract is identical to the `issue-worker` workspace
because the repair agent runs INSIDE the broken agent's worktree —
the same contract that should have run on the broken agent applies
here. Steps live in `src/inject/scripts/agent-finalize.sh` and the
embedded prompt; the canonical English version sits in the
`issue-worker/CLAUDE.md` Pre-task sync section. The repair prompt
reiterates the contract inline so the agent has every step at hand
without ancestor reads.

## Post-task sync

You do NOT run `agent-finalize.sh`. The repair task's output IS the
rebase + push that resolves the broken state — there is no issue
card to finalize, no `feat(<CARD-ID>): <title>` squash to produce.
The dispatch is worker-initiated against a wedged worktree, NOT a
card pickup.

Push the rebased agent branch via `git push --force-with-lease`
(never `--force`) so the remote agent branch tracks the resolved
state. Do NOT push to `origin/main` from the repair flow — main
updates happen at task completion of the ORIGINAL card, which is a
future event that does not occur in this dispatch.

## Job

Re-run the steady-state rebase that the worker's `syncWorktree`
pre-flight could not handle (the pre-flight refuses to resolve
conflicts; the agent must). The dispatch prompt names:

- `Broken agent: <name>` — the agent whose worktree is wedged.
- `Worktree: <absolute path>` — where to `cd` to do the work.
- `Agent branch: <name>` — `git branch --show-current` must match.
- `Abort reason: <text>` — the short label from the `SyncResult.abort`.

The body inside the prompt carries the full step-by-step contract.
This file is the workspace-level orientation — the prompt is
authoritative.

## Tools

- `Bash` — every git op. The repair workspace's cwd is NOT inside the
  broken worktree; every `git` command MUST be `cd <worktree>; git ...`
  (or a single shell pipeline with `cd` as the first step). The
  `worktree-guard` PreToolUse hook does NOT apply here — the workspace
  is intentionally tool-restricted by `.mcp.json` (no per-worktree
  edit fence) so the agent can operate cross-worktree.
- `Read` / `Grep` — inspect the rebase residue. The conflicting files
  live under `<worktree>/...`; read both sides before reconciling.
- `Edit` / `Write` — apply the conflict resolution to individual files.
- `danxbot_complete` — terminal signal. `completed` triggers the
  dispatcher's broken-clear; `failed` preserves the operator gate.

## Conflict resolution policy

The two categories of file that show up in this conflict surface:

| Category | Policy |
|---|---|
| `<worktree>/.danxbot/workspaces/*/**` (inject-pipeline regenerated) | Take `origin/main`'s side. These files are regenerated per cron tick from `<repo>/.danxbot/config/` + the inject sources; agent-authored content here would be erased on the next tick anyway. |
| Anything under `src/`, `dashboard/src/`, `docs/`, `<worktree>/**/*` not in the bucket above | Read BOTH sides and reconcile on merit. Keep the merge that lines up with the work the broken agent was attempting (look at the recent commit log on the agent branch — that's the work being preserved). Do NOT just take one side wholesale unless the two edits are semantically identical. |

The first category covers the most common failure mode the repair
agent sees: three competing `wip(autosave): pre-sync snapshot of
prior-dispatch residue` commits touching the same workspace file's
`.mcp.json`. Take `origin/main` and move on.

## Escalation

`git rebase --abort` is FORBIDDEN. The repair agent's whole purpose
is to resolve the rebase the worker could not. Aborting punts the
work to no one — the broken agent stays broken; the operator must
intervene manually.

Only legitimate escalation: call
`danxbot_complete({status: "failed", summary: "<specific file +
region>: <why unreconcilable>"})` when a conflict region carries two
semantically incompatible same-line edits to application code
(`src/...`, `dashboard/src/...`) AND you cannot reconstruct either
side's intent from the prior commit messages. The dispatcher leaves
`agent.broken` populated and the operator clears it via the
dashboard after resolving by hand.

## Strike accumulation — bypassed (worker-initiated dispatch)

The repair dispatch's row carries `agent_name = null` (worker-
initiated, not picker-spawned), so the strike accumulator's
`agent_name != null` guard short-circuits. The broken agent's
strike counter is not touched by repair outcomes — desired
behavior per the DX-645 "bypass strike counter" decision.
