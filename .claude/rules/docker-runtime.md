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

## Interactive CLI — MCP Env via direnv + `.danxbot/mcp.env`

Use case #1 (developer runs bare `claude` at repo root) resolves `.mcp.json`'s `${VAR}` placeholders ONLY from the shell process env of the `claude` command. Claude Code's `settings.json.env` is NOT exported to MCP subprocesses ([anthropics/claude-code#1254](https://github.com/anthropics/claude-code/issues/1254), closed "not planned"). There is no first-party `--env-file` or `mcpEnv` mechanism. The documented path is shell env.

The repo uses **direnv** for this:

- `<repo>/.envrc` (committed) contains `dotenv_if_exists .danxbot/mcp.env`.
- `<repo>/.danxbot/mcp.env` (gitignored, dev-owned) holds the dev's MCP secrets, e.g. `TRELLO_API_KEY=...` / `TRELLO_API_TOKEN=...` / `MCP_TRELLO_PATH=...`.
- `.mcp.json` interpolates `${TRELLO_API_KEY}` / `${TRELLO_TOKEN}` against the process env direnv exports.

One-time dev setup: `sudo apt-get install -y direnv` + `echo 'eval "$(direnv hook bash)"' >> ~/.bashrc` + `direnv allow` once in the repo. Every `cd` into the repo after that auto-exports `.danxbot/mcp.env` into the shell — bare `claude` Just Works.

### CRITICAL: never put an `.env.local` (or any `.env.{APP_ENV}`) file at the connected repo's root

Laravel's `LoadEnvironmentVariables::checkForSpecificEnvironmentFile()` substitutes `.env.{APP_ENV}` in place of `.env` whenever `APP_ENV` is already in the env repository at bootstrap time. Under plain `artisan tinker` this is harmless (APP_ENV is not yet set at the check). Under Octane's swoole worker bootstrap, APP_ENV is inherited from the parent process, so every worker loads `.env.{APP_ENV}` INSTEAD of `.env` — stripping `APP_KEY`, `REDIS_HOST`, and every other Laravel var not duplicated in the overlay file. Result: `MissingAppKeyException`, Clockwork/Redis connection refused, supervisor FATAL, HTTP RST. This has bitten us in production once; do not reintroduce it.

This is why the dev secrets file lives at `<repo>/.danxbot/mcp.env`, NOT at `<repo>/.env.local`:

- Laravel only opens `.env` and `.env.{APP_ENV}` at the **repo root**. It never walks into `.danxbot/` and never reads `.envrc` (direnv's bash script).
- `.envrc` at repo root is required (direnv only activates on ancestor directories of `cwd`) and is safe — it's a direnv config, not an env file.
- Naming the secrets file `mcp.env` (not `.env.*`) is belt-and-suspenders: even a future `APP_ENV=mcp` cannot match because the file is not at repo root.

When wiring up a new connected repo (especially Laravel / any framework with an env overlay convention), verify zero files at the repo root match `.env*` beyond what the framework itself expects. The dev MCP secrets ALWAYS go under `<repo>/.danxbot/mcp.env`.

### `.claude/settings.local.json` — Developer-Only

`<repo>/.claude/settings.local.json` is STRICTLY the developer's file (permissions, personal allowlists, local MCP toggles for their interactive `claude`). Danxbot does NOT read or write it. The worker port lives in `<repo>/.danxbot/.env` (`DANXBOT_WORKER_PORT=<port>`) alongside the rest of the bot-owned per-repo env; production gets it via `process.env.DANXBOT_WORKER_PORT` injected by compose from `.danxbot/deployments/<target>.yml`.

### Strict isolation from danxbot

Use case #1's `.danxbot/mcp.env` governs the DEVELOPER's interactive `claude` only. Danxbot-dispatched agents (poller, `/api/launch`, Slack) do NOT read it — they use their own per-dispatch MCP config and env from `<repo>/.danxbot/.env` delivered to the worker container via `env_file: ../.env` in `<repo>/.danxbot/config/compose.yml`. Zero overlap between dev env and bot env — by design. Dev creds and bot creds can (and usually should) differ.

### The workspace: dispatched-agent cwd

Every dispatched agent (poller, HTTP `/api/launch`, Slack) runs with `cwd = <repo>/.danxbot/workspace/`. The workspace is a fully generated directory (`src/workspace/generate.ts`) containing danxbot-owned `.mcp.json`, `CLAUDE.md`, `.claude/settings.json`, and a `.claude/` subtree populated by the poller inject pipeline (`src/poller/index.ts#syncRepoFiles`) — rules, skills, tools, agents. This is the ONE path through which danxbot hands configuration to its dispatched claude processes. The repo-root `.claude/` is strictly developer-owned; the inject pipeline NEVER writes there. See agent-isolation epic `7ha2CSpc`, Phase 5.

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
