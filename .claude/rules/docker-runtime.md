# Docker Runtime

## Architecture: Shared Infra + Per-Repo Workers

Danxbot runs as multiple Docker containers:

- **Shared infrastructure** (`danxbot-flytebot/docker-compose.yml`): MySQL + dashboard
- **Per-repo workers** (`<repo>/.danxbot/config/compose.yml`): One container per connected repo, handling poller + Slack + dispatch API

All containers join the `danxbot-net` bridge network. Workers also join their repo's Docker network if needed (e.g., `ssap_sail` for platform).

## Key Commands

| Command | Use |
|---------|-----|
| `make launch-infra` | Start MySQL + dashboard |
| `make launch-worker REPO=platform` | Start worker for a repo |
| `make launch-all-workers` | Start all repo workers |
| `make stop-worker REPO=platform` | Stop a worker |
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
| `./claude-auth/` | `/danxbot/claude-auth/` |

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

## MCP Environment Variables

Claude Code does NOT load `.env` files for MCP server startup — it only reads from the shell environment. Per-repo MCP credentials (Trello API key/token, MCP server path) must be set in `<repo>/.claude/settings.local.json` under the `env` key:

```json
{
  "env": {
    "MCP_TRELLO_PATH": "/home/newms/web/mcp-server-trello",
    "TRELLO_API_KEY": "<repo-specific-key>",
    "TRELLO_API_TOKEN": "<repo-specific-token>"
  }
}
```

This file is gitignored (contains secrets). The `.mcp.json` in each repo references these via `${VAR}` syntax. When connecting a new repo, add these three env vars to its `settings.local.json` using the Trello credentials from that repo's `.danxbot/.env`.

## Tools Available Inside Containers

The Docker image includes dev tools beyond Node.js:

- **gh** — GitHub CLI for creating PRs, managing issues
- **git** — Full git client (HTTPS token auth via gh)
- **mysql** — MySQL client for direct DB access

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: branches into worker, dashboard, or legacy mode |
| `src/worker/server.ts` | Worker HTTP server: /api/launch, /health, /api/status |
| `src/dashboard/server.ts` | Dashboard HTTP server: API routes + static file serving |
| `src/agent/agent.ts` | Router (Haiku) and Agent (Claude Code SDK) |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/config.ts` | Shared config + worker/dashboard mode detection |
| `src/types.ts` | RepoContext, TrelloConfig, SlackConfig interfaces |
| `src/env-file.ts` | Parser for per-repo .danxbot/.env files |
| `Makefile` | Launch targets: launch-infra, launch-worker, launch-all-workers |
