# Docker Runtime

## Runtime Modes: Docker (headless) vs Host (interactive)

Danxbot has two runtime modes, and the distinction is load-bearing:

- **Docker runtime** — the **headless** path. Agents run non-interactively (`claude -p`). No terminal, no user input during the session. Used for production workers.
- **Host runtime** — the **interactive** path. Every agent dispatch opens a Windows Terminal tab running an interactive Claude Code TUI the user can watch and type into. `claude -p` is FORBIDDEN in this path — it defeats the entire purpose of host mode.

Runtime mode ONLY decides how claude is spawned. Everything else — SessionLogWatcher, StallDetector, LaravelForwarder, heartbeat, MCP tools, usage tracking, completion signaling, cancellation — is identical across both modes. ONE claude process per dispatch, ONE JSONL, ONE watcher.

Read `.claude/rules/agent-dispatch.md` before modifying anything in the dispatch/monitoring path. It is the spec for how this all fits together. For the host-mode interactivity invariant specifically, see `.claude/rules/host-mode-interactive.md`.

## Architecture: Host-First + Minimal Containers

Danxbot uses a host-first model: the host environment is fully configured before containers start. Containers only run danxbot code (poller, Slack listener, dispatch API, dashboard). They read repo files via bind mounts and connect to pre-existing Docker networks — but never manage other containers.

- **Shared infrastructure** (`danxbot/docker-compose.yml`): MySQL + dashboard
- **Per-repo workers** (`<repo>/.danxbot/config/compose.yml`): One container per connected repo, handling poller + Slack + dispatch API

All containers join the `danxbot-net` bridge network. Workers also join their repo's Docker network if needed (e.g., `ssap_sail` for platform).

**Prerequisites:** Before launching workers, ensure connected repos have their dev stacks running on the host (Sail, Docker Compose, etc.) and dependencies installed (vendor/, node_modules/). Run `make validate-repos` to check.

## Key Commands

| Command | Use |
|---------|-----|
| `make validate-repos` | Check host prerequisites for all repos |
| `make launch-infra` | Start MySQL + dashboard |
| `make launch-worker REPO=platform` | Start Docker worker for a repo |
| `make launch-worker-host REPO=platform` | Start host worker (interactive terminals) |
| `make launch-dashboard-host` | Start dashboard on host (no Docker) |
| `make launch-all-workers` | Start Docker workers for all repos |
| `make stop-worker REPO=platform` | Stop a Docker worker |
| `make build` | Build the danxbot Docker image |
| `make logs REPO=platform` | Tail worker logs |

## Code Changes & Restarts

Edit files in `src/` on the host. Code changes are visible in the dashboard container via volume mount. Workers mount the repo directory, not danxbot source — rebuild the image (`make build`) then restart workers.

**Dashboard TypeScript changes:** `docker compose up -d --force-recreate`
**Worker code changes:** `make build && make launch-worker REPO=platform`
**Dashboard Vue/CSS changes:** HMR on port **5566** (served by the `dashboard-dev` compose service, started automatically by `docker compose up -d`)
**New dependencies:** `make build`

## Dev repo mounts — never bypass `make launch-infra`

The dashboard needs RW access to each connected repo's `.danxbot/` dir so operator toggles on the Agents tab can write `settings.json`. Those per-repo RW binds live in a gitignored `docker-compose.override.yml` auto-generated from `REPOS` by `make launch-infra` (prereq: `generate-dev-override`). Compose auto-merges the override ONLY when invoked without `-f`.

**Invariant:** use `make launch-infra` (or plain `docker compose up -d`) for dev infra. NEVER run `docker compose -f docker-compose.yml up` — `-f` suppresses override auto-merge and immediately regresses EROFS on the next settings write. If you're writing a new dev helper that needs an explicit `-f`, also pass `-f docker-compose.override.yml`.

Prod is unaffected: its `docker compose -f docker-compose.prod.yml` invocation intentionally bypasses the override (dev-only file).

## Container Paths

**Dashboard container:**

| Host | Container |
|------|-----------|
| `./src` | `/danxbot/app/src` |
| `./dashboard` | `/danxbot/app/dashboard` |

**Worker container:**

| Host | Container |
|------|-----------|
| `<repo>/` | `/danxbot/repos/<name>/` |
| `./claude-auth/` | `/danxbot/app/claude-auth/` |

## Connected Repo Architecture

Each connected repo has its own worker container. The repo is bind-mounted into the worker at `/danxbot/repos/<name>/`. The worker knows its repo via the `DANXBOT_REPO_NAME` env var.

- **File browsing** (Read, Glob, Grep) works directly via the bind mount
- **Runtime commands** depend on the repo's compose.yml (workers join the repo's Docker network)
- **Git/gh commands** run inside the worker container

All repo config lives in `<repo>/.danxbot/config/` (version controlled). Secrets stay in `<repo>/.danxbot/.env` (gitignored).

## Per-Repo Config Structure

```
<repo>/.danxbot/
  config/
    config.yml       # name, url, commands, docker, paths
    trello.yml       # board ID, list IDs, label IDs
    compose.yml      # Worker Docker compose (defines container, networks, ports)
    overview.md      # tech stack, architecture, patterns
    workflow.md      # how to edit, test, commit, PR
    tools.md         # agent tool commands (synced to repo's .claude/rules/)
    docs/
      domains/*.md   # domain knowledge
      schema/*.md    # DB relationships
  .env               # Per-repo secrets (gitignored, DANX_* prefix)
  .env.<target>      # Per-deploy-target overlay (gitignored, optional)
  features.md        # ideator's persistent memory (gitignored)
```

Per-repo secrets live in `<repo>/.danxbot/.env` (gitignored) using standardized DANX_* prefix: DANX_SLACK_BOT_TOKEN, DANX_SLACK_APP_TOKEN, DANX_SLACK_CHANNEL_ID, DANX_DB_HOST/USER/PASSWORD/NAME, DANX_GITHUB_TOKEN, DANX_TRELLO_API_KEY, DANX_TRELLO_API_TOKEN. Danxbot's own `.env` keeps only shared infrastructure (ANTHROPIC_API_KEY, REPOS, DANXBOT_DB_*, DASHBOARD_PORT, DANXBOT_GIT_EMAIL).

### Per-target env overlays — `.env.<target>`

When values must differ between local dev and a specific deploy target (prod Slack channel ID, prod-only DB host, prod URLs), put the override in a sibling `.env.<target>` file at the SAME directory as the `.env` it overrides. `<target>` matches the deploy target name (`make deploy TARGET=<target>`), e.g. `.env.platform` or `.env.gpt`.

Three overlay locations (the deploy collector reads all three):

| Base file | Overlay | Resulting SSM path |
|---|---|---|
| `<root>/.env` | `<root>/.env.<target>` | `/<ssm_prefix>/shared/*` |
| `<repo>/.danxbot/.env` | `<repo>/.danxbot/.env.<target>` | `/<ssm_prefix>/repos/<name>/*` |
| `<repo>/<app_env_subpath>/.env` | `<repo>/<app_env_subpath>/.env.<target>` | `/<ssm_prefix>/repos/<name>/REPO_ENV_*` |

Merge contract (`deploy/secrets.ts#collectDeploymentSecrets`):
- Override keys win; base-only keys preserved; override-only keys added.
- Missing overlay file is a no-op (returns the base map unchanged).
- The merge is in-memory at deploy time only — local files are never modified.
- Local dev (any consumer that reads `.env` without going through deploy) NEVER sees overlay values; the worker container only ever reads what `materialize-secrets.sh` writes from SSM after the deploy push.
- Per-target scope: an overlay named `.env.platform` is read ONLY when `make deploy TARGET=platform` runs. `.env.gpt` does not bleed into a platform deploy.

Files are gitignored by default — `.env.*` with `!.env.example` exception so any `.env.example` you commit for documentation stays trackable.

## Root `.mcp.json` injection contract (DX-201)

The poller injects exactly ONE MCP server — `danx-issue` — into every connected repo's root `.mcp.json` on every tick. A developer running bare `claude` at the repo root sees the `danx-issue` tool surface (atomic `ISS-N` allocation via `danx_issue_create`, list/get/save/close) and nothing else from danxbot. Worker-only MCPs (Trello, Playwright, context7, ...) still live exclusively inside per-workspace dirs (`<repo>/.danxbot/workspaces/<name>/.mcp.json`); they are NEVER added at the repo root.

The injection is implemented by `src/poller/inject/inject-root-mcp.ts#injectDanxIssueMcp` and wired into `syncRepoFiles`. Contract:

- ADDS the `danx-issue` entry to `mcpServers` when the key is missing.
- NEVER deletes, rewrites, or reorders any other `mcpServers` entry — pre-existing servers (operator's own MCPs, playwright in repos that ship one at root, etc.) survive byte-identical.
- NEVER touches top-level keys outside `mcpServers`.
- Operator override wins: if `mcpServers["danx-issue"]` already exists with different content, it is left alone.
- Malformed JSON → log error, no write. The user's file is never overwritten when we can't parse it.
- Atomic write via `.tmp` + `renameSync`; a poller crash mid-write leaves the original file intact.
- Idempotent — re-running is a no-op when the key already exists. Safe to run every tick.

Operators can opt out by adding `danx-issue` themselves with different content — the poller leaves whatever exists alone. Operators can also gitignore the file or commit it; danxbot doesn't dictate either way. The poller re-asserts the key on the next tick only when it's missing — files that already contain `danx-issue` are not rewritten.

Workers' per-dispatch MCPs are unchanged — they still come from `<repo>/.danxbot/workspaces/<name>/.mcp.json` merged with the danxbot infrastructure server inside `dispatch()`. The root `.mcp.json` is the dev's interactive surface only; it does not feed worker dispatches.

### CRITICAL: never put an `.env.local` (or any `.env.{APP_ENV}`) file at the connected repo's root

Laravel's `LoadEnvironmentVariables::checkForSpecificEnvironmentFile()` substitutes `.env.{APP_ENV}` in place of `.env` whenever `APP_ENV` is already in the env repository at bootstrap time. Under plain `artisan tinker` this is harmless (APP_ENV is not yet set at the check). Under Octane's swoole worker bootstrap, APP_ENV is inherited from the parent process, so every worker loads `.env.{APP_ENV}` INSTEAD of `.env` — stripping `APP_KEY`, `REDIS_HOST`, and every other Laravel var not duplicated in the overlay file. Result: `MissingAppKeyException`, Clockwork/Redis connection refused, supervisor FATAL, HTTP RST. This has bitten us in production once; do not reintroduce it.

When wiring up a new connected repo (especially Laravel / any framework with an env overlay convention), verify zero files at the repo root match `.env*` beyond what the framework itself expects.

### `.claude/settings.local.json` — Developer-Only

`<repo>/.claude/settings.local.json` is STRICTLY the developer's file (permissions, personal allowlists, local MCP toggles for their interactive `claude`). Danxbot does NOT read or write it. The worker port lives in `<repo>/.danxbot/.env` (`DANXBOT_WORKER_PORT=<port>`) alongside the rest of the bot-owned per-repo env; production gets it via `process.env.DANXBOT_WORKER_PORT` injected by compose from `deploy/targets/<target>.yml`.

### Strict isolation from danxbot

Danxbot-dispatched agents (poller, `/api/launch`, Slack) use their own per-dispatch MCP config and env from `<repo>/.danxbot/.env` delivered to the worker container via `env_file: ../.env` in `<repo>/.danxbot/config/compose.yml`. The dev's interactive `claude` at the repo root only sees the single `danx-issue` MCP server the poller injects (DX-201) — zero overlap with the worker's broader MCP surface (Trello, Playwright, etc.). The worker's own dispatches still source MCP from the workspace dir, never from the repo root.

### The workspace: dispatched-agent cwd

Every dispatched agent (poller, HTTP `/api/launch`, Slack) runs with `cwd = <repo>/.danxbot/workspaces/<name>/` — one resolved workspace per dispatch. Each plural workspace is fully self-contained: `workspace.yml`, `.mcp.json`, `CLAUDE.md`, `.claude/skills/`, `.claude/rules/` (static + per-repo rendered), `.claude/tools/`. The poller inject pipeline (`src/poller/index.ts#syncRepoFiles`) mirrors static workspace fixtures from `src/poller/inject/workspaces/<name>/` and writes per-repo rendered files into each plural workspace's `.claude/` on every tick. The repo-root `.claude/` is strictly developer-owned; the inject pipeline actively scrubs any leftover `danx-*` artifacts there. See agent-dispatch.md "Workspace isolation" + the workspace-dispatch epic.

## Per-Repo Trello Toggle

`DANX_TRELLO_ENABLED` in `<repo>/.danxbot/.env` controls whether the poller runs for that repo. Defaults to `false` (explicit opt-in). Both host and docker runtimes read this var the same way — docker via `env_file`, host via `make launch-worker-host` sourcing the per-repo `.env`.

## Claude Code Session Logs (JSONL)

Claude Code writes native JSONL session logs to `~/.claude/projects/<cwd-path>/<session-uuid>.jsonl` for ALL invocation modes — verified empirically:
- CLI headless via `spawnAgent()` (plain `-p`, no stream-json — stdout is ignored; JSONL is the monitoring source)
- CLI interactive (terminal mode via `spawnInTerminal()` bash script)
- SDK `query()` (Slack agent)

These files contain the full session history: assistant messages, tool calls, tool results, system events, usage stats. They are the canonical source of truth for what an agent did during a session.

`SessionLogWatcher` polls these files to provide runtime-agnostic monitoring. It is always started by `spawnAgent()` and uses a dispatch tag prepended to the prompt to find the correct JSONL file when multiple sessions are active.

Note: `logPromptToDisk()` in `process-utils.ts` writes debug artifacts (`prompt.md`, `agents.json`) to `logs/<jobId>/` for debugging — this is separate from JSONL session logs and intentional.

## Tools Available Inside Containers

The Docker image includes dev tools beyond Node.js:

- **gh** — GitHub CLI for creating PRs, managing issues
- **git** — Full git client (HTTPS token auth via gh)
- **mysql** — MySQL client for direct DB access

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: branches into worker or dashboard mode |
| `src/worker/server.ts` | Worker HTTP server: /api/launch, /health, /api/status |
| `src/dashboard/server.ts` | Dashboard HTTP server: API routes + static file serving |
| `src/dispatch/core.ts` | Unified `dispatch()` — every deep-agent path funnels through here |
| `src/agent/launcher.ts` | `spawnAgent()` — the one Claude Code CLI fork per dispatch |
| `src/agent/router.ts` | Router (Haiku) — instant message triage |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → dispatch flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/config.ts` | Shared config + worker/dashboard mode detection |
| `src/types.ts` | RepoContext, TrelloConfig, SlackConfig interfaces |
| `src/env-file.ts` | Parser for per-repo .danxbot/.env files |
| `Makefile` | Launch targets: launch-infra, launch-worker, launch-all-workers |
