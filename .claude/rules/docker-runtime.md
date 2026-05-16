# Docker Runtime

## Runtime Modes: Docker (headless) vs Host (interactive)

Two runtime modes, distinction is load-bearing:

- **Docker** — headless. Agents run non-interactively (`claude -p`). No terminal, no user input. Production workers.
- **Host** — interactive. Every dispatch opens a Windows Terminal tab running an interactive Claude Code TUI. `claude -p` is FORBIDDEN here — see `.claude/rules/agent-dispatch.md` "Host mode MUST be interactive".

Mode auto-detected from `/.dockerenv`. Mode ONLY decides spawn shape — SessionLogWatcher, StallDetector, LaravelForwarder, heartbeat, MCP tools, usage, completion, cancellation are identical. ONE claude process per dispatch, ONE JSONL, ONE watcher.

Read `.claude/rules/agent-dispatch.md` before modifying anything in the dispatch/monitoring path.

## Architecture: Host-First + Minimal Containers

Host environment fully configured before containers start. Containers run only danxbot code (poller, Slack listener, dispatch API, dashboard). Read repo files via bind mounts; join pre-existing Docker networks; never manage other containers.

- **Shared infra** (`danxbot/docker-compose.yml`): MySQL + dashboard
- **Per-repo workers** (`<repo>/.danxbot/config/compose.yml`): One container per connected repo (poller + Slack + dispatch API)

All containers join `danxbot-net`. Workers also join their repo's Docker network if needed (e.g., `ssap_sail` for platform).

**Prereq:** connected repos need their dev stacks running on host (Sail, Compose, vendor/, node_modules/). `make validate-repos` checks.

## Key Commands

| Command | Use |
|---------|-----|
| `make validate-repos` | Check host prerequisites |
| `make launch-infra` | Start MySQL + dashboard |
| `make launch-worker REPO=<name>` | Docker worker |
| `make launch-worker-host REPO=<name>` | Host worker (interactive terminals) |
| `make launch-dashboard-host` | Dashboard on host (no Docker) |
| `make launch-all-workers` | Docker workers for all repos |
| `make stop-worker REPO=<name>` | Stop docker worker |
| `make build` | Build the danxbot Docker image |
| `make logs REPO=<name>` | Tail worker logs |

## Code Changes & Restarts

Edit `src/` on host. Dashboard container sees changes via volume mount. Workers mount the repo dir, NOT danxbot source — rebuild + restart for worker code changes.

| Change | Action |
|---|---|
| Dashboard TS | `docker compose up -d --force-recreate` |
| Worker code | `make build && make launch-worker REPO=<name>` |
| Dashboard Vue/CSS | HMR on port **5566** (`dashboard-dev` compose service auto-starts) |
| New deps | `make build` |

## Dev repo mounts — never bypass `make launch-infra`

The dashboard needs RW access to each connected repo's `.danxbot/` dir so operator toggles on the Agents tab can write `settings.json`. Per-repo RW binds live in a gitignored `docker-compose.override.yml` auto-generated from `REPOS` by `make launch-infra` (prereq: `generate-dev-override`). Compose auto-merges the override ONLY when invoked without `-f`.

**Invariant:** use `make launch-infra` (or plain `docker compose up -d`) for dev infra. NEVER `docker compose -f docker-compose.yml up` — `-f` suppresses override auto-merge → EROFS on next settings write. New dev helpers needing explicit `-f` MUST also pass `-f docker-compose.override.yml`.

Prod unaffected: `docker compose -f docker-compose.prod.yml` intentionally bypasses the override (dev-only file).

## Connected Repo Architecture

Each connected repo has its own worker container. Repo bind-mounted into worker at `/danxbot/repos/<name>/`. Worker knows its repo via `DANXBOT_REPO_NAME` env var.

- **File browsing** (Read, Glob, Grep) works directly via bind mount
- **Runtime commands** depend on the repo's compose.yml (workers join the repo's Docker network)
- **Git/gh commands** run inside the worker container

All repo config in `<repo>/.danxbot/config/` (version controlled). Secrets in `<repo>/.danxbot/.env` (gitignored).

## Per-Repo Config Structure

```
<repo>/.danxbot/
  config/
    config.yml       # name, url, commands, docker, paths
    trello.yml       # board ID, list IDs, label IDs
    compose.yml      # Worker Docker compose
    overview.md      # tech stack, architecture
    workflow.md      # how to edit, test, commit, PR
    tools.md         # agent tool commands
    docs/
      domains/*.md
      schema/*.md
  .env               # Per-repo secrets (gitignored, DANX_* prefix)
  .env.<target>      # Per-deploy-target overlay (gitignored)
  features.md        # ideator's persistent memory (gitignored)
```

Per-repo secrets use standardized `DANX_*` prefix: `DANX_SLACK_BOT_TOKEN`, `DANX_SLACK_APP_TOKEN`, `DANX_SLACK_CHANNEL_ID`, `DANX_DB_HOST/USER/PASSWORD/NAME`, `DANX_GITHUB_TOKEN`, `DANX_TRELLO_API_KEY`, `DANX_TRELLO_API_TOKEN`. Danxbot's own `.env` keeps shared infra only: `ANTHROPIC_API_KEY`, `REPOS`, `DANXBOT_DB_*`, `DASHBOARD_PORT`, `DANXBOT_GIT_EMAIL`.

## Portable Repo Path (DX-230)

Every per-repo `compose.yml` MUST declare `DANXBOT_REPO_HOST_PATH: ${DANXBOT_REPO_ROOT}` in `environment:` AND a second mirror-bind volume `${DANXBOT_REPO_ROOT}:${DANXBOT_REPO_HOST_PATH:?...}`. The mirror-bind makes the repo visible at TWO real paths inside the container — the container-internal `/danxbot/app/repos/<name>` and the host's absolute path — so `git worktree add` (which calls `realpath()` on its cwd before writing metadata) bakes runtime-agnostic paths. Adding a new connected repo without these two lines = worker boot fails loud (`ensurePortableRepoPath` throws). `scripts/worker-env.sh` exports `DANXBOT_REPO_HOST_PATH=DANXBOT_REPO_ROOT` for compose-up; both `make launch-worker` and `make launch-worker-host` source it. See `src/agent/portable-path.ts`.

## Per-Repo Trello Toggle

`DANX_TRELLO_ENABLED` in `<repo>/.danxbot/.env` controls whether the poller runs for that repo. Defaults to `false` (explicit opt-in). Both runtimes read identically — docker via `env_file`, host via `make launch-worker-host` sourcing the per-repo `.env`.

## Claude Code Session Logs (JSONL)

Claude Code writes native JSONL session logs to `~/.claude/projects/<cwd-path>/<session-uuid>.jsonl` for every invocation mode (CLI headless via `spawnAgent()`, CLI interactive via `spawnInTerminal()`, SDK `query()`). Files contain full session: assistant messages, tool calls, results, system events, usage. Canonical source of truth for what the agent did.

`SessionLogWatcher` polls these files for runtime-agnostic monitoring. Started by `spawnAgent()`; uses dispatch tag prepended to prompt to disambiguate among concurrent sessions.

`logPromptToDisk()` in `process-utils.ts` writes debug artifacts (`prompt.md`, `agents.json`) to `logs/<jobId>/` — separate from JSONL session logs, intentional.

## Tools Available Inside Containers

The Docker image includes dev tools beyond Node.js: **gh** (GitHub CLI), **git** (HTTPS token auth via gh), **mysql** (DB client).

## Deep contracts → invoke `danxbot:docker-deep` skill

When editing root `.mcp.json` inject (`src/poller/inject/inject-root-mcp.ts`), `.env.<target>` overlay merge (`deploy/secrets.ts`), workspace cwd isolation, container path tables, settings.local.json clarification, or the Laravel `.env.{APP_ENV}` production trap → load `danxbot:docker-deep` skill via Skill tool. Those contracts moved out of this file to keep the always-on rule slim; the skill is the authoritative reference.

## Key Files

Component file table → see CLAUDE.md "Architecture" section. Mode-detection lives in `src/config.ts`; entry routing in `src/index.ts`.
