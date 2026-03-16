# Flytebot

An autonomous AI agent powered by the Claude Code SDK. Connects to any repo, processes Trello cards, and optionally answers questions via Slack.

## How It Works

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               Agent (Claude Code SDK) → detailed response to Slack
```

1. A message arrives in the configured Slack channel (optional)
2. The **Router** (a fast Haiku call) triages the message: sends an instant reply and decides whether the full agent is needed
3. If needed, the **Agent** (Claude Code SDK) explores the connected repo, queries the database, and streams a detailed answer back to Slack
4. A **Heartbeat Orchestrator** posts entertaining status updates while the agent works
5. A **Dashboard** on port 5555 shows live event tracking and analytics
6. A **Poller** watches a Trello board and autonomously processes cards (works without Slack)

## Quick Start

```bash
git clone <this-repo> flytebot && cd flytebot && ./install.sh
```

The interactive setup wizard guides you through credentials, Trello board setup, repo connection, and generates all config files. No manual `.env` editing needed.

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
| `src/poller/` | Trello card poller + autonomous agent launcher |
| `src/threads.ts` | Thread state persistence |

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- Claude Code CLI (`npm i -g @anthropic-ai/claude-code`)
- An Anthropic API key
- A GitHub personal access token
- A Trello account

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

## Tech Stack

- **Runtime**: Node.js 20 + tsx
- **Slack**: @slack/bolt (Socket Mode) — optional
- **AI**: @anthropic-ai/sdk (router), @anthropic-ai/claude-agent-sdk (agent)
- **Dashboard**: Vite + Vue 3 + Tailwind CSS 4
- **Testing**: Vitest
- **Container**: Docker with Ubuntu 22.04
