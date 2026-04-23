# Danxbot

An autonomous AI agent that orchestrates Claude Code CLI dispatches. Connects to any repo, processes Trello cards, and optionally answers questions via Slack.

## How It Works

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               dispatch() → Claude Code CLI → agent posts reply via danxbot_slack_reply MCP tool
```

1. A message arrives in the configured Slack channel (optional)
2. The **Router** (a fast Haiku call) triages the message: sends an instant reply and decides whether the full agent is needed
3. If needed, `dispatch()` spawns a Claude Code CLI subprocess; the dispatched agent explores the connected repo and writes its final reply back to the Slack thread via the `danxbot_slack_reply` MCP tool
4. A **Dashboard** on port 5555 shows live event tracking and analytics
5. A **Poller** watches a Trello board and autonomously processes cards (works without Slack)

## Quick Start

```bash
git clone <this-repo> danxbot && cd danxbot && ./install.sh
```

The interactive setup wizard guides you through credentials, Trello board setup, repo connection, and generates all config files. No manual `.env` editing needed.

## Architecture

| Module | Purpose |
|--------|---------|
| `src/agent/router.ts` | Haiku-based instant triage and quick responses |
| `src/dispatch/core.ts` | Unified `dispatch()` — every deep-agent path (Slack, poller, `/api/launch`) funnels through here |
| `src/agent/launcher.ts` | `spawnAgent()` — single Claude Code CLI fork per dispatch |
| `src/agent/heartbeat.ts` | Token-usage heartbeat (liveness PUTs to `statusUrl`) |
| `src/slack/listener.ts` | Slack Socket Mode message handler |
| `src/slack/helpers.ts` | Shared Slack API helpers (reactions) |
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
docker compose logs danxbot -f
```

## Tech Stack

- **Runtime**: Node.js 20 + tsx
- **Slack**: @slack/bolt (Socket Mode) — optional
- **AI**: @anthropic-ai/sdk (router — Haiku triage). The dispatched agents run as Claude Code CLI subprocesses; there is no in-process SDK agent path.
- **Dashboard**: Vite + Vue 3 + Tailwind CSS 4
- **Testing**: Vitest
- **Container**: Docker with Ubuntu 22.04
