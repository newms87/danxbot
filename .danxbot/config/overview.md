# Danxbot Overview

Autonomous AI agent powered by Claude Code SDK. Connects to repos, processes Trello cards, and answers questions via Slack. Node.js 20 + TypeScript, @slack/bolt, @anthropic-ai/sdk, Vue 3 + Vite dashboard.

## Architecture

Slack message -> Router (Haiku) -> quick response
                    | (if needsAgent)
               Agent (Claude Code SDK) -> detailed response

## Key Directories

- `src/` — Backend TypeScript (bot, agent, poller, dashboard API)
- `dashboard/` — Vite + Vue 3 SPA
- `repos/` — Symlinks to connected repos
