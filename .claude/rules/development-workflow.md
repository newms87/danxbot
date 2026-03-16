# Development Workflow

## Making Changes

1. Edit files in `src/` on the host
2. Type-check: `npx tsc --noEmit`
3. Restart the container: `docker restart danxbot`
4. Check logs: `docker logs danxbot --tail 20`
5. Test in the dashboard (localhost:5555) or Slack

## No Build Step

This project uses `tsx` to run TypeScript directly. There is no build step for development.

`npm run build` (`tsc`) compiles to `dist/` but the bot never runs from `dist/`. The build script exists only for type-checking and CI validation.

## Testing Changes

- **Dashboard changes**: `npm run dashboard:dev` for HMR on port 5173
- **Backend TypeScript changes**: `docker compose up -d --force-recreate`, then test
- **New dependencies**: `docker compose up -d --build`

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: starts dashboard, Slack listener, thread cleanup |
| `src/agent/agent.ts` | Router (Haiku) and Agent (Claude Code SDK) |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/dashboard/server.ts` | HTTP server: API routes + static file serving |
| `dashboard/` | Vite + Vue 3 SPA (see `.claude/rules/dashboard.md`) |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/config.ts` | Environment variable configuration |
| `src/threads.ts` | Thread state persistence (JSON files) |
| `src/slack/formatter.ts` | Markdown → Slack mrkdwn conversion |
