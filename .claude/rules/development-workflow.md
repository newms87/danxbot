# Development Workflow

## Making Changes

1. Edit files in `src/` on the host
2. Type-check: `npx tsc --noEmit`
3. Restart the container: `docker restart flytebot`
4. Check logs: `docker logs flytebot --tail 20`
5. Test in the dashboard (localhost:5555) or Slack

## No Build Step

This project uses `tsx` to run TypeScript directly. There is no build step for development.

`npm run build` (`tsc`) compiles to `dist/` but the bot never runs from `dist/`. The build script exists only for type-checking and CI validation.

## Testing Changes

- **HTML/CSS changes**: Hard-refresh the browser (Ctrl+Shift+R)
- **TypeScript changes**: `docker restart flytebot`, then test
- **New dependencies**: `docker compose up -d --build`

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint: starts dashboard, Slack listener, thread cleanup |
| `src/agent/agent.ts` | Router (Haiku) and Agent (Claude Code SDK) |
| `src/slack/listener.ts` | Slack message handler, orchestrates router → agent flow |
| `src/dashboard/events.ts` | Event tracking, SSE broadcasting, analytics |
| `src/dashboard/server.ts` | HTTP server for dashboard on port 5555 |
| `src/dashboard/index.html` | Dashboard SPA (Vue 3 + Tailwind) |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/config.ts` | Environment variable configuration |
| `src/threads.ts` | Thread state persistence (JSON files) |
| `src/slack/formatter.ts` | Markdown → Slack mrkdwn conversion |
