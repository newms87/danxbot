# Danxbot

Autonomous AI agent that orchestrates Claude Code CLI dispatches. Connects to one or more repos, processes Trello cards, and optionally answers questions in Slack. Run `./install.sh` for interactive setup.

## CRITICAL Pointers Before Touching Sensitive Areas

Auto-loaded rules + skills. Trigger the right one BEFORE editing.

### Rule files (auto-loaded each turn)

| Touching… | Read first |
|---|---|
| `src/agent/launcher.ts`, `terminal.ts`, `session-log-watcher.ts`, `stall-detector.ts`, `laravel-forwarder.ts`, `mcp/danxbot-server.ts`, `worker/dispatch.ts`, host-mode bash script | `.claude/rules/agent-dispatch.md` — single-fork, JSONL-only, completion signaling, "Host mode MUST be interactive" |
| `<repo>/.danxbot/settings.json` ownership / feature toggles | `.claude/rules/settings-file.md` |
| Anything `make`-able | `.claude/rules/make-commands.md` |
| Repo bind-mounts, container layout, runtime detection, root `.mcp.json` inject, `.env.<target>` overlays | `.claude/rules/docker-runtime.md` |
| Dashboard dev URLs (5566/5555), restart matrix, agent auth token | `.claude/rules/dashboard.md` |

### Skill triggers (invoke via Skill tool)

| Trigger | Skill |
|---|---|
| About to run `make launch-*`, `make deploy*`, anything that starts a poller / worker / prod target | `danxbot:no-unauthorized-worker-launch` (strict — per-invocation user auth required) |
| Anything in production: deployed job/dispatch/container/log/DB/SSH, `make deploy-*`, `danxbot.sageus.ai`, "I can't reach production" | `danxbot:prod-access` |
| Editing root `.mcp.json` inject, `deploy/secrets.ts`, `.env.<target>` overlays, workspace cwd, container paths, Laravel `.env.{APP_ENV}` trap | `danxbot:docker-deep` |
| Editing `/api/resume`, `staged_files` validation, Playwright proxy binary path, any `usage` accumulator, debugging silent-dispatch / claude-auth failures | `danxbot:dispatch-deep` |
| Editing `src/settings-file.ts`, dashboard Agents tab handlers, adding feature toggle / display field, `syncSettingsFileOnBoot`, legacy `trelloPoller` migration | `danxbot:settings-deep` |
| Reading / writing / creating any issue YAML, ESPECIALLY epic creation (epics MUST ship with phase cards same turn) | `issues:issue-card-workflow` |
| Card status `Needs Help` / `blocked != null`, `/unblock` invoked | `issues:unblock` |
| Anything about danxbot runtime / dispatch / Trello-as-background-infra / poller boundary | `danxbot:danxbot` |
| Investigating without fixing (diagnose / "why" / "how does X work" / read-only audit) | `investigate:investigate` |
| Bug, error, failing test, factual claim about codebase behavior | `dev:debugging` |
| Running / writing / fixing any test | `dev:testing` |
| Before any file edit | `dev:code-quality` |
| Before any git op | `dev:git-discipline` |
| Before any kill signal | `base:process-kill` |
| Before any Agent / Task subagent dispatch | `base:sub-agent-delegation` |
| Before EnterPlanMode, before checking off AC, before phase complete | `pipeline:planning-discipline` |

## `@thehammer/danx-issue-mcp` — danxbot owns this package

Source: `~/web/danx-issue-mcp/`. Every dispatched agent and host session resolves the MCP via `npx -y @thehammer/danx-issue-mcp` so npm IS the runtime. Source edits are not deployed until published.

**Standing authorization.** Any agent that edits `~/web/danx-issue-mcp/` source — schema bumps, handler changes, dist rebuilds — MUST run `make publish-danx-issue-mcp` from this repo as the final step of that work. The target handles version bump, per-publish `.npmrc` from `NPM_TOKEN` (in `<danxbot>/.env`), registry propagation wait, `~/.npm/_npx/` cache clear. No operator gate, no Blocked card, no "human will publish later" — publishing IS the completion of the edit. Defer only on transient registry network failures (retry).

**Sequencing rule.** When the change touches BOTH the MCP package AND danxbot's consumer side (workspace `.mcp.json`, inject contract, dispatch overlay), publish first → then commit danxbot side. Reverse order = ~60s window where every workspace dispatch breaks because the new env shape lands locally before npm propagates the matching server. The publish make target waits for `npm view` to surface the new version before exiting; once it returns, the danxbot commit is safe.

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick reply
                    ↓ (if needsAgent)
                dispatch() → spawnAgent (Claude CLI) → agent posts reply via danxbot_slack_reply

Local YAML     → Poller (per-repo)        → dispatch() → spawnAgent (Claude CLI)
HTTP /launch   → Worker dispatch endpoint → dispatch() → spawnAgent (Claude CLI)
```

The poller dispatches off `<repo>/.danxbot/issues/open/*.yml` (status: ToDo, waiting_on: null, list_kind != "action_items"). The Trello tracker is a one-way mirror; the poller never reads Trello to decide what to dispatch. See "Source of Truth" below.

Every dispatched agent (Slack deep-agent, Trello poller, `/api/launch`) takes the same spawned-CLI path. The Slack listener posts the initial "thinking" placeholder, then the dispatched agent itself writes the final reply by calling the `danxbot_slack_reply` MCP tool — a worker HTTP endpoint routes the payload back to the bolt client for the originating repo.

| Component | Path | Role |
|---|---|---|
| Router | `src/agent/router.ts` | Anthropic SDK call to Haiku for instant Slack triage |
| Dispatch core | `src/dispatch/core.ts` (`dispatch`) | Unified dispatch — MCP resolution, spawnAgent, stall recovery, activeJobs |
| Launcher | `src/agent/launcher.ts` (`spawnAgent`) | Single entry point for every dispatched Claude CLI process |
| Poller | `src/poller/index.ts` | Per-repo tick loop. Reads local YAML for dispatch decisions. Mirrors YAML state to Trello + pulls new tracker-born cards and human comments inbound. State is in-memory (`state.teamRunning`, `state.polling`) — no on-disk lock files. |
| Slack listener | `src/slack/listener.ts` | One `@slack/bolt` App per Slack-enabled repo; calls `dispatch()` for deep-agent replies |
| Dashboard API | `src/dashboard/server.ts` | REST + SSE on port 5555 |
| Dashboard SPA | `dashboard/` | Vite + Vue 3 + Tailwind 4 |

Runtime mode is auto-detected from `/.dockerenv` at startup — inside a container → docker (headless), on host → host (interactive Windows Terminal). Runtime affects ONLY the spawn shape; monitoring, heartbeat, event forwarding, and stall detection are identical. See `.claude/rules/agent-dispatch.md` for the full contract.

## Tech Stack

- **Runtime:** Node.js 20 + `tsx` (TypeScript executed directly, no build step)
- **AI SDKs:** `@anthropic-ai/sdk` (router — Haiku triage only). Every dispatched agent runs as a spawned Claude Code CLI subprocess; there is no in-process SDK agent path.
- **Slack:** `@slack/bolt` (Socket Mode)
- **Dashboard:** Vite + Vue 3 SFCs + Tailwind 4

## Setup

`./install.sh` launches an interactive wizard (`/setup` skill). It collects Anthropic / GitHub / Trello / optional Slack credentials, clones + explores the repo, and generates `.danxbot/config/`, `.env`, and tailored rules. No manual `.env` editing required.

## Connected Repos (Multi-Repo)

Danxbot manages multiple repos from one server. Each repo has independent state — its own poller, Slack connection, Trello board, and DB credentials.

**Per-repo config locations** (inside each connected repo):

| Path | Purpose | Committed? |
|---|---|---|
| `<repo>/.danxbot/config/` | `config.yml`, `trello.yml`, `compose.yml`, `overview.md`, `workflow.md`, `tools.md`, `docs/` | yes |
| `<repo>/.danxbot/.env` | Secrets + per-repo toggles (`DANX_*` prefix) + `DANXBOT_WORKER_PORT` | gitignored |
| `<repo>/.danxbot/.env.<target>` | **Per-deploy-target overlay** — overrides keys in `.env` at deploy time only | gitignored |
| `<repo>/.danxbot/workspaces/<name>/` | Generated dispatch cwds — one dir per workspace (e.g. `issue-worker`), each with its own danxbot-owned `.mcp.json`, `CLAUDE.md`, `.claude/` subtree | gitignored |
| `<repo>/.claude/` | **Developer territory only** — danxbot never reads or writes here | dev-maintained |

`<repo>/.danxbot/.env` standardized vars: `DANX_TRELLO_ENABLED` (default `false` — explicit opt-in), `DANX_SLACK_BOT_TOKEN`, `DANX_SLACK_APP_TOKEN`, `DANX_SLACK_CHANNEL_ID`, `DANX_DB_HOST/USER/PASSWORD/NAME`, `DANX_GITHUB_TOKEN`, `DANX_TRELLO_API_KEY`, `DANX_TRELLO_API_TOKEN`, `DANXBOT_WORKER_PORT`.

Danxbot's own root `.env` keeps only shared infrastructure: `ANTHROPIC_API_KEY`, `CLAUDE_AUTH_MODE`, `REPOS`, `DANXBOT_DB_*`, `DASHBOARD_PORT`, `DANXBOT_GIT_EMAIL`.

### Per-target env overlays

`.env.<target>` files (e.g. `.env.gpt`) layer over the base `.env` ONLY at `make deploy TARGET=<target>` time (in-memory merge in `deploy/secrets.ts#collectDeploymentSecrets`). Local dev never reads them. Three overlay locations: `<root>/.env.<target>` (shared SSM), `<repo>/.danxbot/.env.<target>` (per-repo danxbot), `<repo>/<app_env_subpath>/.env.<target>` (per-repo app). Full contract: `.claude/rules/docker-runtime.md`.

Connected repos live at `repos/<name>/` (symlinks). `REPOS` env var lists them: `platform:url,danxbot:url`. `loadRepoContext()` builds the single active `RepoContext` from the named repo.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/`. The poller syncs it into every plural workspace's `.claude/rules/danx-tools.md` (e.g. `<repo>/.danxbot/workspaces/issue-worker/.claude/rules/danx-tools.md`). Each dispatched agent cwds into its workspace dir so the file resolves cwd-relative — claude never path-walks to the developer's repo-root `.claude/`. Tool definitions stay repo-specific; danxbot's system prompts reference them generically without hardcoding paths.

### Per-Repo Feature Toggles

Five runtime toggles per repo (Slack / Issue poller / Dispatch API / Ideator / Auto-triage) live at `<repo>/.danxbot/settings.json` — three-valued (`true` / `false` / `null` defers to env default). Workers re-read on every event so toggles take effect with no restart. Operator overrides survive every redeploy. `autoTriage` (env default `false` — explicit opt-in) lets the poller spawn the `danx-triage` agent in `auto` mode when the ToDo queue is empty AND there are untriaged Action Items / Review cards; triage spawn preempts the ideator on the same tick. Full ownership contract + schema: `.claude/rules/settings-file.md`. Spec: `docs/superpowers/specs/2026-04-20-agents-tab-design.md`.

## External Dispatch API + Deployment

Workers bind only on `danxbot-net`; dashboard (Caddy → 443) proxies auth-gated dispatch via `DANXBOT_DISPATCH_TOKEN` bearer. Per-target AWS deploys at `deploy/targets/<target>.yml`. Current targets: `gpt`.

**"Deploy the X danxbot" ALWAYS means `make deploy TARGET=<x>`** — NEVER `make launch-worker` (local), NEVER the connected repo's own app deploy.

**Production IS reachable from this shell.** Routes (`/api/launch|resume|status|cancel|stop`), curl quickstart, SSH/docker-exec recipes, debug recipes → invoke `danxbot:prod-access` skill. Route + auth contract spec → `.claude/rules/agent-dispatch.md` "External Entry".

## Make Commands & Build Workflow

All `make` targets, when to use which, and the production-vs-local invocation conventions: `.claude/rules/make-commands.md`. Required reading before running any `make` command — it's auto-loaded.

Per-phase / per-unit-of-work pipeline (project-specific):

0. Invoke `/pipe-start` to reload critical rules into recency
1. **Implement** — write code, run `npx vitest run` and `npx tsc --noEmit`
2. **Test coverage** — launch the `test-reviewer` subagent, fill all gaps it flags
3. **Code review** — launch the `code-reviewer` subagent, fix all findings
4. **Report** — present results, wait for approval, commit via `/pipe-commit`

Steps 2 and 3 are mandatory quality gates. Applies to every phase in phased plans and every standalone change >10 lines or touching multiple files.

## Testing

**Before any test-related action: invoke `dev:testing` skill.** Skill owns the HOW (run/write/fix, output-to-file, `--filter`, anti-patterns). Section below = danxbot-specific paths only.

Three layers (commands + cost: `.claude/rules/make-commands.md`):
- **Layer 1** — unit + integration: free, Docker-free. `src/__tests__/`, helpers at `src/__tests__/integration/helpers/` (`fake-claude.ts`, `capture-server.ts`)
- **Layer 2** — validation: ~$1, real Claude API. `src/__tests__/validation/` + `vitest.validation.config.ts`
- **Layer 3** — system: ~$1, needs infra+worker+`ANTHROPIC_API_KEY`. `src/__tests__/system/run-system-tests.sh`

Backend = `src/**/*.test.ts` (root vitest). Dashboard = `dashboard/src/**/*.test.ts` (`cd dashboard && npx vitest run`). Output convention: `> /tmp/vitest.log 2>&1`.

**UI frontend test exemption.** Vue layer under `dashboard/src/` (SFCs, composables, `api.ts`) does NOT require tests; `test-reviewer` + pipeline step 2 MUST NOT flag missing coverage there. Still required: backend API + SSE + auth + analytics under `src/dashboard/**`, everything else under `src/**`, and `cd dashboard && npx vue-tsc --noEmit` type-check.

## Agent Spawn Architecture (Summary)

Every dispatched agent goes through `spawnAgent()` in `src/agent/launcher.ts`. Every spawn is monitored by `SessionLogWatcher` reading Claude Code's native JSONL from `~/.claude/projects/`. ONE claude process per dispatch, ONE JSONL, ONE watcher. Runtime mode (auto-detected) only changes the spawn shape — everything downstream is identical.

| Component | File | Role |
|---|---|---|
| `SessionLogWatcher` | `src/agent/session-log-watcher.ts` | Canonical monitoring source — JSONL polling |
| `LaravelForwarder` | `src/agent/laravel-forwarder.ts` | Batches and POSTs agent events to a Laravel API |
| `StallDetector` | `src/agent/stall-detector.ts` | Detects stuck agents; nudges + kills |
| `TerminalOutputWatcher` | `src/agent/terminal-output-watcher.ts` | Tails terminal log for ✻ thinking indicator (stall-input only) |

Full contract — what to do, what NOT to do, the forbidden-patterns table, the resume protocol — lives in `.claude/rules/agent-dispatch.md`.

## Autonomous Agent Team

### Triggers

Skills are injected into each connected repo by the poller (gitignored, `danx-*` prefix). The inject step is authoritative — files removed from `src/poller/inject/` are pruned from consuming repos on the next poll tick.

| Skill | Purpose |
|---|---|
| `/danx-start` | Process ALL cards in ToDo |
| `/danx-next` | Process the single top card |
| `/danx-ideate` | Build knowledge + generate feature cards |

### Subagent Roles

The main session is the orchestrator. Subagents are launched via Task with `mode: "bypassPermissions"`.

| Agent | File | Role |
|---|---|---|
| Ideator | `.claude/agents/ideator.md` | Repo knowledge + feature generation |
| Validator | `.claude/agents/validator.md` | Real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Source of Truth

**Local YAML at `<repo>/.danxbot/issues/{open,closed}/<id>.yml` is the single source of truth for every issue.** The poller's dispatch decisions read local YAML. The danxbot agent path reads + writes local YAML.

The backend tracker (Trello) is a **one-way mirror** with two narrow inbound exceptions: (a) new cards created on the tracker get hydrated into a fresh YAML on the next tick, and (b) human-authored comments on the tracker get pulled into the YAML's `comments[]`. Everything else inbound is ignored — a human dragging a card between lists, ticking an AC checkbox, or editing the title on Trello has no effect on the local YAML; the next tick re-asserts YAML state. Tracker = view + comment surface, not an editing surface for card structure.

Outbound (every tick): every YAML field — title, description, status, AC, phases, labels, comments, blocked record — is pushed to the tracker so humans see current state.

### Trello Is Background Infrastructure — Never In The Agent's Critical Path

**The agent flow (read YAML → edit YAML → done) MUST NOT depend on Trello.** Load-bearing architectural rule. The MCP server (`@thehammer/danx-issue-mcp`) is YAML-only (DX-203); agent edits go through `Edit` / `Write` and the chokidar watcher (`src/db/issues-mirror.ts`) mirrors to Postgres on file events; the worker's poll loop + post-completion auto-sync (`src/worker/auto-sync.ts`) push YAML→Trello asynchronously. Trello errors surface ONLY in the dashboard.

Forbidden: calling `mcp__trello__*` from agent flow; re-introducing tracker plumbing into `@thehammer/danx-issue-mcp`; treating "Trello unreachable" as agent-blocking; surfacing Trello creds to dispatched agents.

Full table + implications: `.claude/rules/agent-dispatch.md` Forbidden Patterns row + `danxbot:danxbot` skill.

### Trello Board

IDs in `<repo>/.danxbot/config/trello.yml`. Resolved via `IssueTracker` interface (`src/issue-tracker/`). Lists: Review → ToDo → In Progress → Blocked / Done / Cancelled + Action Items. `status: "Blocked"` populates `Issue.blocked = {reason, timestamp}`; cards waiting on OTHER cards use `Issue.waiting_on` + STAY in ToDo (different concept).

### Card Workflow (Orchestrator)

**Before touching any issue YAML — load `issues:issue-card-workflow` skill via the Skill tool.** Skill is authoritative: epic creation MUST ship phase cards same turn (`children: []` on epic = never acceptable); pickup → In Progress → TDD → quality gates (Test Reviewer + Code Reviewer subagents in parallel) → commit → Done with retro → `danxbot_complete`. Action items + `status: Blocked` are LAST RESORT (see `src/poller/inject/workspaces/issue-worker/.claude/skills/danx-next/SKILL.md` Step 1.5). Validator subagent only for agent/SDK changes.
