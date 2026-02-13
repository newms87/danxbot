# Flytebot

A Slack bot powered by Claude Code SDK that answers questions about the Flytedesk platform by exploring its codebase and querying its database.

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               Agent (Claude Code SDK) → detailed response to Slack
```

- **Router** (`src/agent/agent.ts:runRouter`): Anthropic API call to Haiku for instant triage
- **Agent** (`src/agent/agent.ts:runAgent`): Claude Code SDK `query()` for deep exploration
- **Dashboard** (`src/dashboard/`): Vue 3 SPA on port 5555, served as static HTML
- **Slack listener** (`src/slack/listener.ts`): Socket Mode via @slack/bolt

## Key Commands

| Command | Use |
|---------|-----|
| `docker compose up -d` | Start the bot |
| `docker compose down` | Stop the bot |
| `docker restart flytebot` | Restart (picks up code changes) |
| `docker logs flytebot -f` | Tail logs |
| `npx tsc --noEmit` | Type-check only (host) |

## Tech Stack

- **Runtime**: Node.js 20 + `tsx` (TypeScript executed directly, no build step needed)
- **Slack**: @slack/bolt (Socket Mode)
- **AI**: @anthropic-ai/sdk (router), @anthropic-ai/claude-agent-sdk (agent)
- **Dashboard**: Vue 3 + Tailwind CSS (CDN, single HTML file)
