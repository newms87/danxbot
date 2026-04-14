# Docker Runtime

## Danxbot Runs in Docker — Always

The bot runs inside a Docker container managed by docker compose. It does NOT run directly on the host.

- Container entrypoint: `npm start` → `tsx src/index.ts`
- `tsx` executes TypeScript directly — no build step for development
- `tsc` / `npm run build` is only for type-checking, never for running the bot

## Code Changes & Restarts

Edit files in `src/` on the host. Code changes on the host are immediately visible in the container via volume mount (`./src → /danxbot/app/src`). However, `tsx` loads modules once at startup — the container must be recreated to pick up TypeScript changes.

**After modifying TypeScript files:**
```bash
docker compose up -d --force-recreate
```

**After modifying `package.json`:**
```bash
docker compose up -d --build
```

**NEVER use `docker compose restart danxbot`.** Bind-mounted files may change inodes, causing stale mount errors.

## Testing Changes

- **Dashboard changes** (Vue/CSS): `npm run dashboard:dev` for HMR on port 5173
- **Backend TypeScript changes**: `docker compose up -d --force-recreate`, then test via dashboard (port 5555) or Slack
- **New dependencies**: `docker compose up -d --build`

## Container Paths

| Host | Container |
|------|-----------|
| `./src` | `/danxbot/app/src` |
| `./package.json` | `/danxbot/app/package.json` |
| `/danxbot/repos/` | Symlinks to working copies (e.g., `/home/newms/web/gpt-manager`) |
| `./repo-overrides/` | `/danxbot/app/repo-overrides/` |

## Connected Repo Architecture

Connected repos live at `/danxbot/repos/<name>/` — these are symlinks to the actual working copies (e.g., `/danxbot/repos/gpt-manager` → `/home/newms/web/gpt-manager`). The `getReposBase()` function in `src/poller/constants.ts` always resolves to `/danxbot/repos/` and throws if it doesn't exist. There is no fallback to a project-local `repos/` directory.

- **File browsing** (Read, Glob, Grep) works directly — files are at `/danxbot/repos/<name>/` which symlinks to the working copy
- **Runtime commands** depend on the repo's runtime setting in `repo-config/config.yml`:
  - **Docker runtime:** Commands run via `docker compose exec danxbot docker compose -p <project_name> -f /danxbot/app/repo-overrides/<compose_file> run --rm <service> <command>`
  - **Local runtime:** Commands run directly in the repo directory
- **Git/gh commands** run in the danxbot container: `docker compose exec -u danxbot danxbot git -C /danxbot/repos/<name> <command>`
- Read `.claude/rules/repo-config.md` for the exact commands, service names, and paths

All repo config lives in `.danxbot/config/` (version controlled). Secrets stay in danxbot's `.env` and `repo-overrides/`.

## Tools Inside Container

```
/danxbot/repos/<name>/.danxbot/
  config/
    config.yml       # name, url, commands, docker, paths
    trello.yml       # board ID, list IDs, label IDs
    overview.md      # tech stack, architecture, patterns
    workflow.md      # how to edit, test, commit, PR
    tools.md         # agent tool commands (synced to repo's .claude/rules/)
    compose.yml      # Docker override (optional)
    post-clone.sh    # runs after cloning (optional)
    docs/
      domains/*.md   # domain knowledge
      schema/*.md    # DB relationships
  features.md        # ideator's persistent memory (gitignored)
```

Per-repo secrets live in `<repo>/.danxbot/.env` (gitignored) using standardized DANX_* prefix: DANX_SLACK_BOT_TOKEN, DANX_SLACK_APP_TOKEN, DANX_SLACK_CHANNEL_ID, DANX_DB_HOST/USER/PASSWORD/NAME, DANX_GITHUB_TOKEN, DANX_TRELLO_API_KEY, DANX_TRELLO_API_TOKEN. Danxbot's own `.env` keeps only shared infrastructure (ANTHROPIC_API_KEY, REPOS, DANXBOT_DB_*, etc.). The poller syncs `.danxbot/config/` to target locations (`.claude/rules/`, `docs/`, `repo-overrides/`) before each Claude spawn.

## Tools Available Inside the Container

The Docker image includes dev tools beyond Node.js. Use `docker compose exec danxbot <command>` to access them:

- **gh** — GitHub CLI for creating PRs, managing issues
- **git** — Full git client (HTTPS token auth via gh)
- **docker** / **docker compose** — For managing sibling containers
- **mysql** — MySQL client for direct DB access

**NEVER try to install these tools on the host.** They are already in the Docker image. Run them inside the container.

## Never Run the Bot on the Host

Do not use `npm start` or `npm run dev` on the host. The bot requires:
- Claude Code CLI installed globally
- Claude auth at `/root/.claude.json`
- Access to repo symlinks at `/danxbot/repos/`

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: starts dashboard, Slack listener, thread cleanup |
| `src/agent/agent.ts` | Router (Haiku) and Agent (Claude Code SDK) |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/dashboard/server.ts` | HTTP server: API routes + static file serving |
| `src/config.ts` | Shared config + loadRepoContexts() for per-repo config |
| `src/types.ts` | RepoContext, TrelloConfig, SlackConfig interfaces |
| `src/env-file.ts` | Parser for per-repo .danxbot/.env files |
| `src/threads.ts` | Thread state persistence |
| `src/slack/formatter.ts` | Markdown → Slack mrkdwn conversion |
