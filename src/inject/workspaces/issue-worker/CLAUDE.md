# issue-worker workspace

This directory is the dispatched cwd for the danxbot poller. Operational rules,
skills, and tools live in `.claude/`. The danxbot MCP server is infrastructure
injected at dispatch time; any additional MCP servers (e.g. playwright) are
declared in `.mcp.json` and resolved from overlay placeholders. There is no
tracker MCP — issues are local YAMLs at `$DANX_REPO_ROOT/.danxbot/issues/open/`.

## Pre-task sync

Before reading the issue YAML or writing any code, your worktree MUST be at
`origin/main` HEAD with the agent branch replayed on top. The
`danxbot:danx-prep` skill (auto-invoked as the first step of every dispatch)
owns the contract:

1. `git fetch origin`.
2. If `git status --porcelain` is non-empty, commit the residue on the agent
   branch — never `git stash` / `git reset --hard` / `git clean -f`. The
   default commit shape is `wip(autosave): pre-sync snapshot of
   prior-dispatch residue`. The prep skill's Step 3 owner-resolution may
   rewrite to a clean `feat(...)` / `fix(...)` message when it identifies
   which card the residue belonged to.
3. `git rebase origin/main`. On clean rebase, the agent branch is now
   replayed on top of upstream.
4. On rebase conflict, RESOLVE IN PLACE file by file — never
   `git rebase --abort`. Policy: inject-pipeline files under
   `.danxbot/workspaces/*/` take `origin/main`'s side (they regenerate per
   tick); other files resolve on merit using semantic understanding of both
   sides.
5. `git push --force-with-lease origin <agent-branch>` so the remote agent
   branch tracks the rebased state (not `origin/main` — main updates happen
   at task completion, see Post-task sync below).

The contract runs INSIDE the dispatched agent (not just on the worker's
pre-flight) so a dirty worktree from a crashed prior dispatch heals at
agent-start, not only at boot.

## Post-task sync

After every AC verifies and the test suite is green — but BEFORE calling
`danxbot_complete` — the agent's task-completion commit must land on
`origin/main` directly. The canonical implementation is
`.danxbot/scripts/agent-finalize.sh` (sourced from
`src/inject/scripts/agent-finalize.sh`). Invoke it from inside your
worktree:

```
bash .danxbot/scripts/agent-finalize.sh <YOUR-NAME> <CARD-ID> "<title>" "<bullet 1>" "<bullet 2>" ...
```

The script:

1. WIP-commits any uncommitted changes (so the squash sees everything).
2. `git fetch origin && git rebase origin/main`. On conflict (exit 1), resolve
   in-session using the same policy as Pre-task sync, then re-invoke.
3. Squashes every commit ahead of `origin/main` into ONE Conventional
   Commits commit `feat(<CARD-ID>): <title>` with each bullet on its own
   `-` line in the body.
4. Pushes `HEAD:main` directly with rebase-loop on push race (5 retries
   max, exit 2 on `PUSH_RACE_EXHAUSTED`).
5. Resets the local `<agent>` branch to the just-pushed `origin/main`.
6. Fast-forwards `origin/<agent>` to match `origin/main` so the remote
   agent branch never lags its own pushes (DX-644).

Capture the `PUSHED <sha>` token from stdout and push it into
`retro.commits[]` before signalling `danxbot_complete`. The skill's
Step 7a covers exit-code routing (`0` PUSHED, `1` rebase conflict, `2`
push race exhausted, `64` usage error, `65` wrong branch, `NO_OP` for
docs-only dispatches).

## Path placeholder convention — use `$DANX_REPO_ROOT`

`$DANX_REPO_ROOT` is the ONE source of truth for absolute paths your
dispatch operates on. It is always populated in the agent's bash session
(DX-660 wired it through the workspace's `.claude/settings.json` env
block); use it for every Read / Edit / Write / Bash path you produce.
Issue YAMLs live at `$DANX_REPO_ROOT/.danxbot/issues/{open,closed}/<id>.yml`
— canonical regardless of dispatch shape.

What `$DANX_REPO_ROOT` resolves to per dispatch shape (the dispatch core
swaps this in `src/dispatch/core.ts:1152`, so the value is always
correct for THIS dispatch):

- **Agent-bound** (multi-worker workers like `phil`) → agent worktree
  at `<repo>/.danxbot/worktrees/<name>`. The worktree's `.danxbot/issues`
  is a symlink back to the main clone so every agent shares one
  canonical issue store.
- **Workspace-mode** (`/api/flesh-out`, `/api/launch` without an `agent`
  field) → main clone path. `.danxbot/issues` is the real directory.

When plugin-skill bodies use `<worktree>` as a placeholder, substitute
`$DANX_REPO_ROOT`. The `<worktree>` literal predates DX-660 and only
distinguished agent-bound from workspace-mode; `$DANX_REPO_ROOT` already
encodes that distinction.

Persona-block dispatches additionally echo the literal absolute path on a
`Your worktree: <absolute path>` line — that string equals `$DANX_REPO_ROOT`
on agent-bound dispatches; use the literal form when the read-before-edit
gate keys on it (verbatim absolute paths only).

A second env var, `$DANX_AGENT_WORKTREE`, exists for the PreToolUse
worktree-guard hook (`_shared/hooks/worktree-guard.mjs`) — non-empty
only on agent-bound dispatches, where it equals `$DANX_REPO_ROOT` and
gates write paths against the worktree boundary. Workspace-mode
dispatches see `""`, the hook gracefully no-ops, and the boundary
intentionally does not apply. Agents do not normally reference this
var directly — use `$DANX_REPO_ROOT`.

Do NOT walk through `repos/<name>` symlinks — Claude's read-before-edit
gate keys on the literal path string, so an aliased spelling that resolves
to the same inode still fails because the gate sees a different string
than the one you Read from. The worktree-guard hook also rejects writes
whose literal prefix is not under your worktree.

## Skill triggers (invoke via Skill tool)

| Trigger | Skill |
|---|---|
| About to set `status: "Blocked"`, populate `blocked: {reason, ...}`, append `## Blocked` comment, OR call `danxbot_complete({status: "failed", ...})` with operator-must-X framing | `danxbot:issue-blocker` (8-item gating checklist; refuses the move if any item fails) |
| About to mark a card Blocked because of "pre-existing flaky test," "manual UI smoke," or "post-`danxbot_complete` self-derived state" | `danxbot:no-false-blockers` (the three patterns with programmatic substitutes) |
| Picking up any card whose `status: Blocked` or `waiting_on` is non-null | `danxbot:unblock` |

DX-272 moved the operational rules + skills that used to live under
`.claude/rules/danx-*.md` and `.claude/skills/{danx-*,issue-blocker}/`
into the `danxbot@newms-plugins` plugin. The plugin auto-installs in
every dispatched session via the workspace `.claude/settings.json`
`enabledPlugins` entry, so loading by `<plugin>:<skill>` form is
equivalent to (and faster than) reading the old inject paths. The
inject pipeline no longer ships those files; the per-tick prune
deletes any stale copy.

## Tools you have for "operator-only-looking" verification

Before moving a card to Blocked because of "manual UI smoke," "pre-existing
flaky test," or "post-save behavior I can't observe," invoke the
`danxbot:no-false-blockers` skill. None of those are valid blockers;
programmatic substitutes exist for each.

- **Dashboard auth** (host-mode dispatch): persistent bearer token at
  `~/.config/danxbot/dashboard-token` (read with `cat`). Use against
  `http://localhost:5566/api/*` (Vite proxy) or `http://localhost:5555/api/*`
  (direct API). Sanity check: `curl -H "Authorization: Bearer $(cat ~/.config/danxbot/dashboard-token)" http://localhost:5555/api/auth/me` returns `{"user":{"username":"monitor"}}`.
- **Playwright MCP** for browser-driven smoke (`mcp__playwright__*` tools
  declared in `.mcp.json`). Inject the bearer / cookie before navigating.
- **Dashboard component tests** for "renders X when state Y" ACs:
  `cd dashboard && npx vitest run <path>` mounts the SFC with
  `@vue/test-utils` — deterministic + browser-free.
