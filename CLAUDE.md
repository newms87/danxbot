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

## Testing

| Command | Purpose |
|---------|---------|
| `npx vitest run` | Unit tests (all) |
| `npx vitest run src/path` | Unit tests (specific) |
| `npm run test:validate` | Validation tests (real Claude API, $2 budget) |
| `npx tsc --noEmit` | Type-check only |

Validation tests require `ANTHROPIC_API_KEY` env var and are excluded from the default `npx vitest run`.

## Autonomous Agent Team

### Triggers

| Skill | Purpose |
|-------|---------|
| `/start-team` | Process ALL cards in ToDo |
| `/next-card` | Process single top card |
| `/ideate` | Build knowledge + generate feature cards |

### Team Roles

| Agent | File | Role |
|-------|------|------|
| Orchestrator | `.claude/agents/orchestrator.md` | Central coordinator, manages Trello workflow |
| Ideator | `.claude/agents/ideator.md` | Platform knowledge + feature generation |
| Implementor | `.claude/agents/implementor.md` | TDD builder, writes code |
| Validator | `.claude/agents/validator.md` | Runs real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Trello Board

Board ID: `698fc5b8847b787a3818ad82`

| List | Purpose |
|------|---------|
| Review | New cards for human review |
| ToDo | Approved cards ready for work |
| In Progress | Currently being worked on |
| Done | Completed cards |
| Cancelled | Dropped cards |

### Workflow

1. Human moves approved cards from Review to ToDo
2. `/start-team` or `/next-card` triggers the Orchestrator
3. Orchestrator picks up card, moves to In Progress, creates progress checklist
4. Orchestrator evaluates scope — splits into epic phases if too large (3+ phases)
5. Implementor builds via TDD (failing test, implement, pass, refactor)
6. Test Reviewer audits coverage, Code Reviewer checks quality
7. Validator runs real API tests (only for agent/SDK changes)
8. Orchestrator commits, moves to Done, adds retro comment
9. Epic splitting: cards named `Epic > Phase N > Description`
10. Every Done card gets a retro comment (what went well/wrong, optimizations)
