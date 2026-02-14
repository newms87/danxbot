# Flytebot

A Slack bot powered by the Claude Code SDK that answers questions about the Flytedesk platform by exploring its codebase and querying its database.

## How It Works

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               Agent (Claude Code SDK) → detailed response to Slack
```

1. A message arrives in the configured Slack channel
2. The **Router** (a fast Haiku call) triages the message: sends an instant reply and decides whether the full agent is needed
3. If needed, the **Agent** (Claude Code SDK) explores the platform repo, queries the database, and streams a detailed answer back to Slack
4. A **Heartbeat Orchestrator** posts entertaining status updates while the agent works
5. A **Dashboard** on port 5555 shows live event tracking and analytics

## Architecture

| Module | Purpose |
|--------|---------|
| `src/agent/router.ts` | Haiku-based instant triage and quick responses |
| `src/agent/agent.ts` | Claude Code SDK agent for deep exploration |
| `src/agent/heartbeat.ts` | Orchestrator-generated status messages |
| `src/slack/listener.ts` | Slack Socket Mode message handler |
| `src/slack/heartbeat-manager.ts` | Heartbeat lifecycle during agent runs |
| `src/slack/helpers.ts` | Shared Slack API helpers (reactions, attachments) |
| `src/slack/formatter.ts` | Markdown to Slack mrkdwn conversion |
| `src/dashboard/` | Vue 3 + Tailwind monitoring dashboard |
| `src/threads.ts` | Thread state persistence (JSON files) |

## Prerequisites

- Docker and Docker Compose
- The platform repo checked out locally
- A Slack app with Socket Mode enabled
- An Anthropic API key
- Claude Code CLI auth (`~/.claude.json`)

## Setup

1. Clone this repo and the platform repo side by side:

   ```
   ~/web/platform/   # Flytedesk platform repo
   ~/web/flytebot/   # This repo
   ```

2. Copy `.env.example` to `.env` and fill in the values:

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C...
   ANTHROPIC_API_KEY=sk-ant-...
   PLATFORM_REPO_URL=git@github.com:...
   PLATFORM_DB_HOST=...
   PLATFORM_DB_USER=...
   PLATFORM_DB_PASSWORD=...
   PLATFORM_DB_NAME=...
   ```

3. Make sure the platform's Docker network exists (the bot connects to it for database access):

   ```bash
   docker network ls | grep ssap_sail
   ```

4. Start the bot:

   ```bash
   docker compose up -d
   ```

5. Verify it's running:

   ```bash
   docker logs flytebot --tail 20
   # Should see: "Dashboard running at http://localhost:5555"
   # Should see: "Flytebot is running (Socket Mode)"
   ```

## Development

The bot runs in Docker with `src/` volume-mounted. TypeScript is executed directly via `tsx` (no build step).

```bash
# Type-check on the host
npx tsc --noEmit

# Run tests
npx vitest run

# After editing TypeScript, recreate the container
docker compose up -d --force-recreate

# After changing dependencies, rebuild
docker compose up -d --build

# Tail logs
docker logs flytebot -f
```

HTML/CSS changes to the dashboard are visible on browser refresh without a restart.

## Tech Stack

- **Runtime**: Node.js 20 + tsx
- **Slack**: @slack/bolt (Socket Mode)
- **AI**: @anthropic-ai/sdk (router), @anthropic-ai/claude-agent-sdk (agent)
- **Dashboard**: Vue 3 + Tailwind CSS (CDN, single HTML file)
- **Testing**: Vitest
- **Container**: Docker with Ubuntu 22.04, PHP 8.3, MySQL client
