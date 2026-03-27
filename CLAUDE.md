# Danxbot

An autonomous AI agent powered by Claude Code SDK. Connects to a repo, processes Trello cards, and optionally answers questions via Slack. Run `./install.sh` for interactive setup.

## Setup

Run `./install.sh` to launch the interactive setup wizard. It checks prerequisites, installs dependencies, and launches `claude '/setup'` which guides you through:

1. Anthropic API key
2. GitHub token + repo selection
3. Trello credentials + board setup
4. Slack integration (optional)
5. Repo cloning + exploration
6. Config and rules generation
7. Smoke test + proof-of-life PR

The setup generates `.danxbot/config/` in the connected repo, `.env`, and tailored rules files. No manual `.env` editing needed.

## Connected Repo

All repo-specific config lives in `.danxbot/config/` inside the connected repo (version controlled). Trello IDs, repo commands, overview, workflow, domain docs, and agent tools are stored there. Secrets (API keys, tokens, passwords) stay in danxbot's `.env`. The poller syncs config to `.claude/rules/`, `docs/`, and `repo-overrides/` before each Claude spawn. The connected repo is cloned to `repos/<name>/` and is the target for Trello card work.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/` that lists commands available to SDK agents (database schema helpers, test runners, lint commands, etc.). The poller syncs this to the repo's `.claude/rules/tools.md`, where it's automatically loaded by the Claude Code SDK via `settingSources: ["project"]`. This keeps tool definitions repo-specific — danxbot's system prompts reference the tools generically without hardcoding paths.

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               Agent (Claude Code SDK) → detailed response to Slack
```

- **Router** (`src/agent/agent.ts:runRouter`): Anthropic API call to Haiku for instant triage
- **Agent** (`src/agent/agent.ts:runAgent`): Claude Code SDK `query()` for deep exploration
- **Dashboard** (`dashboard/`): Vite + Vue 3 + Tailwind CSS 4 SPA; API server on port 5555, Vite dev on 5173
- **Slack listener** (`src/slack/listener.ts`): Socket Mode via @slack/bolt (optional — bot works without Slack for Trello card processing)

## Key Commands

| Command | Use |
|---------|-----|
| `docker compose up -d` | Start the bot |
| `docker compose down` | Stop the bot |
| `docker compose up -d --force-recreate` | Restart (picks up code changes) |
| `docker compose logs danxbot -f` | Tail logs |
| `curl localhost:$DASHBOARD_PORT/health` | Check bot health status |
| `npx tsc --noEmit` | Type-check only (host) |
| `npm run dashboard:dev` | Vite dev server on 5173 (HMR) |
| `npm run dashboard:build` | Build dashboard for production |

## Tech Stack

- **Runtime**: Node.js 20 + `tsx` (TypeScript executed directly, no build step needed)
- **Slack**: @slack/bolt (Socket Mode)
- **AI**: @anthropic-ai/sdk (router), @anthropic-ai/claude-agent-sdk (agent)
- **Dashboard**: Vite + Vue 3 SFCs + Tailwind CSS 4 (separate app in `dashboard/`)

## Testing

| Command | Purpose |
|---------|---------|
| `npx vitest run` | Unit tests (all) |
| `npx vitest run src/path` | Unit tests (specific) |
| `npm run test:validate` | Validation tests (real Claude API, $2 budget) |
| `npx tsc --noEmit` | Type-check only |

Validation tests require `ANTHROPIC_API_KEY` env var and are excluded from the default `npx vitest run`.

## Build Workflow

Every phase or unit of work follows this exact order:

1. **Implement** — write the code, run `npx vitest run` and `npx tsc --noEmit`
2. **Test coverage** — launch `test-reviewer` agent to audit coverage, then write tests to fill all gaps
3. **Code review** — launch `code-reviewer` agent, fix all findings
4. **Report** — present results to user, wait for approval and commit

This applies per-phase in phased plans and to any standalone work (>10 lines or multiple files). Steps 2-3 are mandatory quality gates — never skip or defer them.

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
| Ideator | `.claude/agents/ideator.md` | Repo knowledge + feature generation |
| Validator | `.claude/agents/validator.md` | Runs real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Trello Board

Board/list/label IDs are in `.claude/rules/trello-config.md` (auto-generated from `.env` by the poller).

| List | Purpose |
|------|---------|
| Review | New cards for human review |
| ToDo | Approved cards ready for work |
| In Progress | Currently being worked on |
| Needs Help | Blocked on human intervention |
| Done | Completed cards |
| Cancelled | Dropped cards |
| Action Items | Retro action items for future improvement |

### Workflow

1. Human moves approved cards from Review to ToDo
2. `/start-team` or `/next-card` triggers the workflow
3. Main session picks up card, moves to In Progress, creates progress checklist
4. If the card requires human intervention (external service settings, account config, etc.), adds `Needs Help` label and moves to Needs Help list
5. Evaluates scope — splits into epic phases if too large (3+ phases), labels parent as Epic, creates phase cards in In Progress
6. Orchestrator implements directly using TDD (failing test, implement, pass, refactor)
7. Launches Test Reviewer + Code Reviewer subagents for quality gates
8. Posts review results as Trello card comments, fixes any critical issues
9. Launches Validator subagent only for agent/SDK changes
10. Commits, moves card to Done, adds retro comment
11. Epic splitting: parent gets Epic label, phase cards named `Epic > Phase N > Description` created in In Progress
12. Every Done card gets a retro comment (What went well, What went wrong, Action items, Commits)
13. Retro action items create linked cards in the Action Items list
