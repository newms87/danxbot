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
| `./repos/` | `/danxbot/repos/` |

## Connected Repo Architecture

Connected repos are cloned to `repos/<name>/` at startup. The danxbot container has git, gh, docker, and docker compose available.

- **File browsing**: Read, Glob, Grep work directly at `repos/<name>/` on host
- **Runtime commands**: Run via docker compose inside the container (see `.claude/rules/repo-workflow.md`)
- **Git commands**: Run in the danxbot container: `docker compose exec -u danxbot danxbot git -C /danxbot/repos/<name> <command>`

All repo config lives in `.danxbot/config/` (version controlled). Secrets stay in danxbot's `.env` and `repo-overrides/`.

## Tools Inside Container

The Docker image includes: gh, git, docker, docker compose, mysql. Never try to install these on the host — they're already in the image. Access them via `docker compose exec danxbot <tool>`.

## Never Run the Bot on the Host

Do not use `npm start` or `npm run dev` on the host. The bot requires Claude Code CLI, Claude auth at `/root/.claude.json`, and access to `/danxbot/repos/`. All configured inside the container.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: starts dashboard, Slack listener, thread cleanup |
| `src/agent/agent.ts` | Router (Haiku) and Agent (Claude Code SDK) |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/dashboard/server.ts` | HTTP server: API routes + static file serving |
| `src/config.ts` | Environment variable configuration |
| `src/threads.ts` | Thread state persistence |
| `src/slack/formatter.ts` | Markdown → Slack mrkdwn conversion |
