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
| `curl localhost:5555/health` | Check bot health status |
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

The main Claude Code session acts as the orchestrator. Subagents are launched via the Task tool with `mode: "bypassPermissions"`.

| Agent | File | Role |
|-------|------|------|
| Ideator | `.claude/agents/ideator.md` | Platform knowledge + feature generation |
| Implementor | `.claude/agents/implementor.md` | TDD builder, writes code |
| Validator | `.claude/agents/validator.md` | Runs real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Trello Board

Board ID: `698fc5b8847b787a3818ad82` (always pass as `boardId` to Trello MCP tools)

| List | Purpose |
|------|---------|
| Review | New cards for human review |
| ToDo | Approved cards ready for work |
| In Progress | Currently being worked on |
| Needs Help | Blocked on human intervention |
| Done | Completed cards |
| Cancelled | Dropped cards |

### Workflow

1. Human moves approved cards from Review to ToDo
2. `/start-team` or `/next-card` triggers the workflow
3. Main session picks up card, moves to In Progress, creates progress checklist
4. If the card requires human intervention (external service settings, account config, etc.), adds `Needs Help` label and moves to Needs Help list
5. Evaluates scope — splits into epic phases if too large (3+ phases)
6. Launches Implementor subagent for TDD (failing test, implement, pass, refactor)
7. Launches Test Reviewer + Code Reviewer subagents for quality gates
8. Launches Validator subagent only for agent/SDK changes
9. Commits, moves card to Done, adds retro comment
10. Epic splitting: cards named `Epic > Phase N > Description`
11. Every Done card gets a retro comment (what went well/wrong, optimizations)
