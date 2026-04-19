# Docker Runtime

## Runtime Modes: Docker (headless) vs Host (interactive)

Danxbot has two runtime modes, and the distinction is load-bearing:

- **Docker runtime** — the **headless** path. Agents run non-interactively (`claude -p`). No terminal, no user input during the session. Used for production workers.
- **Host runtime** — the **interactive** path. Every agent dispatch opens a Windows Terminal tab running an interactive Claude Code TUI the user can watch and type into. `claude -p` is FORBIDDEN in this path — it defeats the entire purpose of host mode.

Runtime mode ONLY decides how claude is spawned. Everything else — SessionLogWatcher, StallDetector, LaravelForwarder, heartbeat, MCP tools, usage tracking, completion signaling, cancellation — is identical across both modes. ONE claude process per dispatch, ONE JSONL, ONE watcher.

Read `.claude/rules/agent-dispatch.md` before modifying anything in the dispatch/monitoring path. It is the spec for how this all fits together. For the host-mode interactivity invariant specifically, see `.claude/rules/host-mode-interactive.md`.

## Architecture: Host-First + Minimal Containers

Danxbot uses a host-first model: the host environment is fully configured before containers start. Containers only run danxbot code (poller, Slack listener, dispatch API, dashboard). They read repo files via bind mounts and connect to pre-existing Docker networks — but never manage other containers.

- **Shared infrastructure** (`danxbot-flytebot/docker-compose.yml`): MySQL + dashboard
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
**Dashboard Vue/CSS changes:** `npm run dashboard:dev` for HMR on port 5173
**New dependencies:** `make build`

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
  features.md        # ideator's persistent memory (gitignored)
```

Per-repo secrets live in `<repo>/.danxbot/.env` (gitignored) using standardized DANX_* prefix: DANX_SLACK_BOT_TOKEN, DANX_SLACK_APP_TOKEN, DANX_SLACK_CHANNEL_ID, DANX_DB_HOST/USER/PASSWORD/NAME, DANX_GITHUB_TOKEN, DANX_TRELLO_API_KEY, DANX_TRELLO_API_TOKEN. Danxbot's own `.env` keeps only shared infrastructure (ANTHROPIC_API_KEY, REPOS, DANXBOT_DB_*, DASHBOARD_PORT, DANXBOT_GIT_EMAIL).

## Per-Repo settings.local.json — MCP Env + Worker Port

`<repo>/.claude/settings.local.json` is the single source of truth for two things:

1. **MCP server env vars** — Claude Code does NOT load `.env` files for MCP server startup; it only reads from the shell environment.
2. **Worker port** — `DANXBOT_WORKER_PORT` lives here so host and docker runtimes source the port identically. `make launch-worker` and `make launch-worker-host` both extract it via `jq` and export it before starting the process.

```json
{
  "env": {
    "DANXBOT_WORKER_PORT": "5562",
    "MCP_TRELLO_PATH": "/home/newms/web/mcp-server-trello",
    "TRELLO_API_KEY": "<repo-specific-key>",
    "TRELLO_API_TOKEN": "<repo-specific-token>"
  }
}
```

This file is gitignored (contains secrets). The `.mcp.json` in each repo references MCP vars via `${VAR}` syntax. When connecting a new repo, add these four env vars with the repo's credentials and a unique port.

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
| `src/agent/launcher.ts` | Unified `spawnAgent()` entrypoint + AgentJob lifecycle |
| `src/agent/router.ts` | Router (Haiku) — instant message triage |
| `src/agent/agent.ts` | Agent (Claude Code SDK query) — deep Slack responses |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/config.ts` | Shared config + worker/dashboard mode detection |
| `src/types.ts` | RepoContext, TrelloConfig, SlackConfig interfaces |
| `src/env-file.ts` | Parser for per-repo .danxbot/.env files |
| `Makefile` | Launch targets: launch-infra, launch-worker, launch-all-workers |
