# Multi-Worker Dispatch — Design

Status: Draft (brainstorm 2026-05-08)
Blocked by: Issues DB Mirror epic (`2026-05-08-issues-db-mirror-design.md`, DX-151) — locks need DB queries on the `issues` table

## Goal

Run multiple danxbot workers per repo without code-edit collisions. Each named agent (Alice, Bob, etc.) owns a persistent git worktree, has a personality + avatar + work hours, and can serve any dispatch type it's enabled for (issue / slack / api). Only one dispatch per agent at a time. The poller picks (agent, card) pairs, runs a triage-precursor conflict check when other agents are working, dispatches, and the agent commits + squash-merges its work into `main`.

## Non-goals

- Touching the multi-card-per-agent pattern (one dispatch per agent — period).
- Replacing the agent-side YAML read flow (still `Glob`/`Read`).
- Cross-repo agents (each agent belongs to exactly one repo).
- Adding new dispatch types — issue-worker / slack / api are the existing three.

## Locked decisions (from brainstorm 2026-05-08)

| Topic | Decision |
|---|---|
| Worktree lifecycle | Persistent per-agent. `<repo>/.danxbot/worktrees/<agent-name>/` reused across dispatches |
| Agent identity | Operator-named in `<repo>/.danxbot/settings.json`, dashboard-editable, max 5 per repo |
| Agent capability | Each agent declares which dispatch types it can serve via `capabilities: ('issue-worker'|'slack'|'api')[]` — not per-type pools |
| Agent profile | Free-form markdown `bio`, avatar (filesystem upload), `schedule {tz, mon..sun: [windows]}`, `enabled` flag |
| Personality injection | Persona block prepended as the first paragraph of every dispatch prompt |
| Branch model | One branch per agent (named after the agent — `alice`, `bob`). Persistent. Rebased onto `origin/main` at dispatch start |
| Push strategy | Squash-merge to `main` on completion. Conventional Commits format. Rebase-loop on push race; cap retries; mark Needs Help on exhaustion |
| Branch state recovery | Worker pre-dispatch check: if agent branch is dirty / divergent / has unmerged work, dispatch a **branch-recovery** task instead of next card. Recovery agent finishes any WIP card on the branch, never destroys work, exits clean. Worker re-dispatches with next card |
| Agent lock | One dispatch per agent at any time regardless of dispatch type. Derived from `dispatches` table (status=running AND agent_name=X) |
| Card lock | One agent per card. Derived from `issues.assigned_agent` column (set at dispatch start, persists to closed/) |
| Conflict detection | Triage agent in `--conflict-check` precursor mode. Runs every dispatch where ≥1 other agent has an in-progress card. Toggleable per repo via dashboard |
| Conflict resolution | Triage returns `{ok|conflict, reason, blocked_by?}`. On conflict: stamp `blocked` on candidate card, log, poller picks next candidate (no agent spawn) |
| Avatar storage | Filesystem at `<repo>/.danxbot/agents/<name>/avatar.<ext>`; gitignored |
| UI restructure | Existing per-repo settings move to a "Settings" tab scoped to the **currently selected repo**. The "Agents" tab is repurposed for agent CRUD |
| Card UI badge | `<avatar><name>` chip inline on issue list rows + drawer header when `assigned_agent` set |

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │ <repo>/.danxbot/settings.json — agents[…]    │
                 │ <repo>/.danxbot/agents/<name>/avatar.png     │
                 └──────────────────────────────────────────────┘
                                       │
                                       ▼
               ┌──────────────────────────────────────────────────┐
               │            poller _poll() per repo               │
               │                                                  │
               │  1. Pick free agent A (capability + schedule +   │
               │     enabled + not busy in dispatches table)      │
               │  2. Pick free card C (status=ToDo, !blocked,     │
               │     assigned_agent IS NULL) by ICE / priority    │
               │  3. If ≥1 other agent has in-progress card AND   │
               │     conflictCheckEnabled → run triage precursor  │
               │     ────────────────────────                      │
               │     spawn triage --conflict-check C against [in_progress…]
               │     wait for {ok|conflict, reason}               │
               │     ────────────────────────                      │
               │     conflict → stamp blocked on C, retry pick    │
               │  4. Pre-dispatch branch validation in            │
               │     <repo>/.danxbot/worktrees/<A>/               │
               │     ────────────────────────                      │
               │     git fetch origin                             │
               │     git -C wt status --porcelain                 │
               │     ahead/behind vs origin/main check            │
               │     ────────────────────────                      │
               │     dirty/divergent → branch-recovery dispatch    │
               │     clean → reset hard origin/main; checkout A   │
               │  5. Set issues.assigned_agent = A.name on C YAML │
               │  6. Spawn agent w/ persona-prepended prompt      │
               └──────────────────────────────────────────────────┘
                                       │
                                       ▼
               ┌──────────────────────────────────────────────────┐
               │ Agent in worktree <repo>/.danxbot/worktrees/<A>/ │
               │ branch = <A>; HEAD = origin/main                 │
               │                                                  │
               │ does the work, runs tests, etc.                  │
               │                                                  │
               │ On completion (issue-worker only):               │
               │   git pull --rebase origin main                  │
               │   git checkout main                              │
               │   git merge --squash <A>                         │
               │   git commit -m "feat(DX-N): <title>"            │
               │     -m "- bullet" -m "- bullet"                  │
               │   git push origin main (rebase-loop on conflict, │
               │     cap N retries; on exhaustion → Needs Help)   │
               │   danxbot_complete                               │
               └──────────────────────────────────────────────────┘
```

## Settings.json schema

```jsonc
{
  // existing overrides + display sections unchanged

  "agents": {
    "alice": {
      "type": "agent",                 // discriminator (forward-compat)
      "bio": "Senior backend engineer. Terse code reviews. Hates mocks.",
      "avatar_path": "agents/alice/avatar.png",   // relative to <repo>/.danxbot/
      "capabilities": ["issue-worker", "slack", "api"],
      "schedule": {
        "tz": "America/Chicago",
        "mon": ["09:00-17:00"],
        "tue": ["09:00-17:00"],
        "wed": ["09:00-17:00"],
        "thu": ["09:00-17:00"],
        "fri": ["09:00-12:00"],
        "sat": [],
        "sun": []
      },
      "enabled": true,
      "created_at": "2026-05-08T12:00:00Z",
      "updated_at": "2026-05-08T12:00:00Z"
    },
    "bob": { … capabilities: ["issue-worker"] … },
    "charlie": { … capabilities: ["slack"] … }
  },

  "agentDefaults": {
    "conflictCheckEnabled": true        // dashboard-toggleable, default true
  }
}
```

Validation (`src/settings-file.ts#normalize`):

- Max 5 entries in `agents`.
- Names: `^[a-z][a-z0-9_-]{0,31}$` (URL-safe, used in branch + worktree path + container hostnames).
- `capabilities` non-empty subset of `{"issue-worker","slack","api"}`.
- `schedule.tz` parseable by `Intl.DateTimeFormat`.
- Per-day windows: `["HH:MM-HH:MM", …]`, empty array allowed (= unavailable).
- Avatar path is OPTIONAL; missing means UI shows initials.

The existing `display`/`overrides` sections stay; the brainstormed UI rework moves them into a "Settings" tab without changing the file schema.

## Issue YAML — `assigned_agent`

Already on the schema (referenced by the DB-mirror epic). Multi-worker spec consumes:

- Set to the agent's `name` at dispatch start (poller writes when it stamps `dispatch.id`).
- Persists through completion — on `Done`, the field stays so the audit trail survives in `closed/`.
- Cleared (set to empty / `null`) when an operator manually re-opens a card or the poller invalidates a dispatch.

DB index `(repo_name, assigned_agent) WHERE assigned_agent IS NOT NULL` answers "is alice busy on a card?" in microseconds.

## Worktree management

### Layout

```
<repo>/.danxbot/worktrees/
  alice/        ← persistent worktree, branch = alice
  bob/          ← persistent worktree, branch = bob
  …
```

`<repo>/.danxbot/worktrees/` is gitignored. The actual git operations all happen inside each `<name>/` dir, which is a `git worktree add` of the repo's main checkout.

### Bootstrap (run during agent-create flow)

```bash
cd <repo>            # main checkout
git fetch origin
git worktree add -B <name> <repo>/.danxbot/worktrees/<name> origin/main
```

Idempotent — re-running on an existing worktree is a no-op.

### Per-dispatch validation (worker, before spawn)

```bash
cd <repo>/.danxbot/worktrees/<name>
git fetch origin

# 1. Working tree clean?
test -z "$(git status --porcelain)"

# 2. Branch up-to-date with origin/main? (no commits ahead, no commits behind on a divergent path)
local=$(git rev-parse HEAD)
main=$(git rev-parse origin/main)
ancestor=$(git merge-base HEAD origin/main)

# 3. Decide
if clean && (local == main OR local == ancestor):
    git checkout <name>
    git reset --hard origin/main
    proceed: dispatch normally
else:
    proceed: branch-recovery dispatch (DO NOT touch state)
```

The recovery dispatch's prompt explicitly forbids destructive operations and instructs the agent to commit any in-progress work, then exit. After the recovery dispatch completes, the worker re-runs validation and either dispatches the next card or files a Needs Help if the branch is still wedged.

### Per-dispatch completion (issue-worker only — slack / api don't push code)

Inside the agent's prompt:

```
On completion, before calling danxbot_complete:

1. Stage every change you made under <repo>/.danxbot/worktrees/<your-name>/.
2. git add . && git commit -m "WIP" — small intermediate commits welcome; the squash flattens them.
3. git fetch origin
4. git rebase origin/main
   - If conflicts: resolve them. Never `git rebase --abort` and exit; the worker treats that as a failure.
5. git checkout main
6. git merge --squash <your-name>
7. git commit -m "feat(DX-N): <title>" \
              -m "- <bullet 1>" -m "- <bullet 2>" -m "- <bullet 3>"
   ── Conventional Commits — type(scope) header, blank line, bullet body.
   ── Allowed types: feat, fix, refactor, test, chore, docs, perf, build, ci.
   ── Scope = the card id (DX-N).
8. push_with_retry() — git push origin main; on rejection, git pull --rebase, retry.
   Cap retries at 5. On exhaustion: stop, file a comment on the card, signal
   danxbot_complete({status: "needs_help", summary: "Push race exceeded retries"}).
9. git checkout <your-name>; git reset --hard origin/main  (back to clean for next dispatch)
10. danxbot_complete({status: "completed", summary: "<commit sha>"})
```

The worker exposes a small helper script `<repo>/.danxbot/scripts/agent-finalize.sh` that runs steps 3-9 mechanically; the agent invokes it instead of running each command by hand. Reduces room for error.

## Persona injection

Worker builds the dispatch prompt in this order:

```
You are <Name>. <bio markdown>.

Your worktree: <repo>/.danxbot/worktrees/<name>/
Your branch: <name>

[task description from the card]

[standard danxbot dispatch instructions]
```

The persona block is the FIRST paragraph of the prompt. Bio is verbatim — operator content. ~200 tokens overhead per dispatch is acceptable.

## Triage-precursor — conflict check

### When it runs

Pre-flight inside `dispatch()` (`src/dispatch/core.ts`). Conditions:

- `agentDefaults.conflictCheckEnabled !== false` for this repo.
- The candidate agent is an issue-worker dispatch (slack / api skip — they don't touch code).
- ≥1 other agent has a card in `In Progress` status (queried from `issues` table).

### Mechanics

The existing triage agent (`/danx-triage` skill, `<repo>/.danxbot/workspaces/issue-worker/.claude/skills/danx-triage/`) gets a new mode:

```
/danx-triage --conflict-check <candidate-id>
```

Input (auto-staged via `staged_files`): the candidate card YAML + every in-progress card YAML.

Output (via `danxbot_complete` summary, JSON-shaped):

```json
{
  "ok": true,
  "reason": "Candidate touches src/dashboard/server.ts; in-progress cards touch src/poller/* — no overlap"
}
```

or

```json
{
  "ok": false,
  "reason": "Both candidate and in-progress DX-141 modify src/agent/launcher.ts — collision risk",
  "blocked_by": ["DX-141"]
}
```

On `ok: false`, the worker stamps:

```yaml
blocked:
  reason: "Conflict-check rejection: <reason>"
  timestamp: <iso>
  by: <blocked_by ids>
```

on the candidate's YAML, then aborts the dispatch (no issue-worker spawn). The poller picks the next candidate next tick.

### Cost

One Haiku/Sonnet call per dispatch when contention exists. Budget: ~$0.005-0.02 per call. Toggleable for cost-sensitive ops.

## Dashboard UI

### Tab restructure

| Today | After |
|---|---|
| `Agents` tab — shows every connected repo's env-feature toggles all at once | `Settings` tab — scoped to currently-selected repo via the existing repo switcher; shows env-feature toggles + the `agentDefaults.conflictCheckEnabled` toggle |
| (no equivalent) | `Agents` tab — agent roster CRUD for the currently-selected repo |

Repo switcher mechanism: dashboard already routes per-repo views via `?repo=<name>`. Both tabs reuse it.

### Agents tab layout

- Top: "+ New Agent" button (disabled when 5 already exist).
- Grid of agent cards:
  - Avatar (initials fallback).
  - Name, capability chips (`issue-worker`, `slack`, `api`).
  - Currently-busy badge (live data from `dispatches` table — green dot + card id when running, gray when idle).
  - Schedule summary: `Mon-Thu 9-5 CT, Fri 9-12, off weekends`.
  - Edit button → opens edit drawer with all fields.
- Edit drawer (right side):
  - Avatar upload (file picker; max 1 MB; jpeg/png/webp).
  - Name (immutable after creation — branches + worktrees depend on it).
  - Bio (markdown editor).
  - Capabilities (3 checkboxes).
  - Schedule (per-day window editor + tz picker).
  - Enabled toggle.
  - Delete (with confirmation: "Will tear down the worktree at `<path>` and remove the branch. The branch will be force-pushed to delete from origin.").

### Card / list UI badges

- Issue list rows: when `assigned_agent` set, render `<avatar 16x16> <name>` chip after the title.
- Issue drawer header: same chip but 24x24 + clickable → links to that agent's detail panel.
- "All Dispatches" view: filter dropdown by agent.

### REST surface

```
GET  /api/agents?repo=<name>                    → roster + busy state
POST /api/agents                                → create (validates 5-cap)
PATCH /api/agents/:name?repo=<name>             → edit (avatar via separate POST)
POST /api/agents/:name/avatar?repo=<name>       → multipart upload
GET  /api/agents/:name/avatar?repo=<name>       → serve image
DELETE /api/agents/:name?repo=<name>            → tear down worktree, remove branch, drop record
PATCH /api/agents-settings?repo=<name>          → conflictCheckEnabled toggle
```

All routes auth-gated by the existing dashboard auth layer. Worktree teardown on DELETE: `git worktree remove --force <path>` + `git push origin --delete <name>` + `rm -rf <repo>/.danxbot/agents/<name>/`.

## Failure modes + recovery

| Failure | Recovery |
|---|---|
| Worktree not bootstrapped on first dispatch | Worker bootstraps lazily on first pick of the agent (`git worktree add`). Failure → operator-visible error, agent marked unavailable until cleared |
| Branch dirty / divergent at dispatch start | Branch-recovery dispatch (described above) |
| Push race exhausted retries | Agent signals `danxbot_complete({status:'needs_help'})`, comment on card explains, operator unblocks |
| Triage-precursor returns malformed JSON | Treat as `ok: false`; conservative — better to defer than risk collision. Log loudly |
| Triage-precursor times out | Same — treat as `ok: false`; mark card with `blocked.reason: "Conflict check timed out"` and retry next tick |
| Operator deletes an agent while it's mid-dispatch | DELETE is rejected with 409; operator must cancel the dispatch first |
| Avatar upload exceeds 1 MB | 413 with helpful error |
| Schedule says agent is off-hours | Poller skips that agent for picks; UI shows "off-hours" badge |

## Multi-worker tests against multi-card concurrency

System-test scenario (Layer 3): seed 3 agents (alice/bob/charlie all with issue-worker capability), inject 3 ToDo cards touching disjoint files, observe all three dispatched concurrently, all three finish, three squash-merge commits land on main with no rebase failures. Already-similar scenarios exist as fixtures; this is a new permutation.

## Implementation phasing (rough — full breakdown lands in the implementation plan)

- **A.** Settings-file schema + validation + repo-scoped Settings/Agents tab restructure.
- **B.** Agent CRUD UI + REST endpoints + avatar storage.
- **C.** Worktree manager: bootstrap, per-dispatch validation, branch-recovery dispatch path.
- **D.** Persona injection into dispatch prompt + agent-finalize.sh helper.
- **E.** Agent + card lock queries (DB-driven, requires DB-mirror epic done).
- **F.** Triage-precursor — conflict-check mode in the existing triage skill, wired into dispatch pipeline.
- **G.** Card UI badges + agent detail panel + busy state on roster.
- **H.** End-to-end system tests.

## Out of scope (this epic)

- Multi-repo agents.
- Cross-agent collaboration (an agent picking up another agent's WIP intentionally).
- Auto-scaling agent count based on queue depth.
- Per-agent model preference (gpt-4 vs sonnet vs haiku) — possible later.
- Per-agent allowed-tool-set (every agent inherits the workspace's tool surface today).
- Slack / API dispatch-type wiring of `assigned_agent` — deferrable; the LOCK contract still applies (one dispatch per agent), but the YAML stamp is issue-worker-specific because slack/api dispatches don't have an issue card.

## Implementation plan

To be written via `writing-plans` after this spec is approved.
