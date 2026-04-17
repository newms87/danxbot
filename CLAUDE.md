# Danxbot

An autonomous AI agent powered by Claude Code SDK. Connects to a repo, processes Trello cards, and optionally answers questions via Slack. Run `./install.sh` for interactive setup.

## CRITICAL: Read Before Touching Agent Dispatch

Dispatch, monitoring, completion, and runtime modes have a tight design contract. Before editing `src/agent/launcher.ts`, `src/terminal.ts`, `src/agent/session-log-watcher.ts`, `src/agent/stall-detector.ts`, `src/agent/laravel-forwarder.ts`, `src/mcp/danxbot-server.ts`, or `src/worker/dispatch.ts`, read `.claude/rules/agent-dispatch.md`. That file describes the single-fork principle (one claude per dispatch, runtime only decides how it's spawned), the JSONL-watcher-only monitoring rule, and the completion-signaling flow. Regressions in this area are expensive — the doc exists to stop them.

**Host mode invariant:** `claude -p` is forbidden anywhere in the host-mode terminal spawning path. Host runtime exists ONLY to give the user an interactive TUI; `-p` makes it headless. See `.claude/rules/host-mode-interactive.md`.

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

## Connected Repos (Multi-Repo)

Danxbot manages multiple repos simultaneously. Each repo is fully isolated — its own poller, Slack connection, Trello board, and database credentials. Danxbot remains a single server.

Repo-specific config lives in two places inside each connected repo:

1. `<repo>/.danxbot/config/` (committed) — config.yml, trello.yml, overview.md, workflow.md, compose.yml, tools, docs
2. `<repo>/.danxbot/.env` (gitignored) — secrets only, standardized DANX_* prefix: DANX_SLACK_BOT_TOKEN, DANX_SLACK_APP_TOKEN, DANX_SLACK_CHANNEL_ID, DANX_DB_HOST/USER/PASSWORD/NAME, DANX_GITHUB_TOKEN, DANX_TRELLO_API_KEY, DANX_TRELLO_API_TOKEN

Danxbot's own `.env` keeps only shared infrastructure: ANTHROPIC_API_KEY, CLAUDE_AUTH_MODE, REPOS, DANXBOT_DB_*, DASHBOARD_PORT, DANXBOT_GIT_EMAIL.

Each repo also needs MCP credentials in `<repo>/.claude/settings.local.json` (gitignored) under the `env` key — Claude Code does not load `.env` files for MCP servers. Required vars: `MCP_TRELLO_PATH`, `TRELLO_API_KEY`, `TRELLO_API_TOKEN`. See `docker-runtime.md` for details.

Connected repos live at `repos/<name>/` (symlinks to actual working copies). The `REPOS` env var lists all repos: `platform:url,danxbot:url`. In worker mode, `loadRepoContext()` builds the single active `RepoContext` from the named repo's config. The dashboard reads the repo list directly from `REPOS`. All services (poller, Slack, agent) receive `RepoContext` as a parameter.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/` that lists commands available to SDK agents (database schema helpers, test runners, lint commands, etc.). The poller syncs this to the repo's `.claude/rules/tools.md`, where it's automatically loaded by the Claude Code SDK via `settingSources: ["project"]`. This keeps tool definitions repo-specific — danxbot's system prompts reference the tools generically without hardcoding paths.

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick response to Slack
                    ↓ (if needsAgent)
               Agent (Claude Code SDK) → detailed response to Slack
```

- **Router** (`src/agent/router.ts`): Anthropic API call to Haiku for instant triage
- **Agent** (`src/agent/agent.ts:runAgent`): Claude Code SDK `query()` for deep exploration — accepts `RepoContext` for cwd
- **Dashboard** (`dashboard/`): Vite + Vue 3 + Tailwind CSS 4 SPA; API server on port 5555, Vite dev on 5173. Supports `?repo=` filtering and repo selector.
- **Slack listener** (`src/slack/listener.ts`): One `@slack/bolt` App per repo via `Map<string, ListenerState>`. Each repo with Slack gets independent state.
- **Poller** (`src/poller/index.ts`): One poller per repo via `Map<string, RepoPollerState>`. Independent lock files (`.poller-running-<name>`).

## Key Commands

| Command | Use |
|---------|-----|
| `make validate-repos` | Check host prerequisites before launching workers |
| `make launch-infra` | Start shared infra (MySQL + dashboard) |
| `make launch-worker REPO=platform` | Start a Docker worker for a repo |
| `make launch-worker-host REPO=platform` | Start a host worker (interactive terminals) |
| `make launch-all-workers` | Start Docker workers for all configured repos |
| `make stop-worker REPO=platform` | Stop a Docker worker |
| `make stop-infra` | Stop shared infrastructure |
| `make logs` | Tail infra logs |
| `make logs REPO=platform` | Tail worker logs |
| `make build` | Build the danxbot Docker image |
| `npx tsc --noEmit` | Type-check only (host) |
| `npm run dashboard:dev` | Vite dev server on 5173 (HMR) |
| `npm run dashboard:build` | Build dashboard for production |

## Tech Stack

- **Runtime**: Node.js 20 + `tsx` (TypeScript executed directly, no build step needed)
- **Slack**: @slack/bolt (Socket Mode)
- **AI**: @anthropic-ai/sdk (router), @anthropic-ai/claude-agent-sdk (agent)
- **Dashboard**: Vite + Vue 3 SFCs + Tailwind CSS 4 (separate app in `dashboard/`)

## Testing

Three test layers, each with different requirements and costs:

### Layer 1 — Unit + Integration (free, no external deps)

| Command | Purpose |
|---------|---------|
| `make test` | All unit + integration tests |
| `make test-unit` | Unit tests only (mocked, fast) |
| `make test-integration` | Integration tests only (fake-claude + capture server) |
| `npx vitest run src/path` | Specific test file or directory |
| `npx tsc --noEmit` | Type-check only |

Integration tests use a fake-claude process that writes JSONL to disk and a capture HTTP server that records requests. No Claude API calls, no Docker needed.

### Layer 2 — Validation (real Claude API, ~$1 per run)

| Command | Purpose |
|---------|---------|
| `make test-validate` | All validation tests (budget-capped at 150k tokens) |

Requires `ANTHROPIC_API_KEY` in `.env`. Spawns real Claude CLI/SDK processes. Tests JSONL creation, watcher discovery, summary extraction. Excluded from `make test`.

### Layer 3 — System (real Docker workers + Claude API, ~$1 per run)

| Command | Purpose |
|---------|---------|
| `make test-system` | All system tests sequentially |
| `make test-system-health` | Worker /health endpoint |
| `make test-system-dispatch` | Dispatch API happy path |
| `make test-system-heartbeat` | Heartbeat + event forwarding |
| `make test-system-cancel` | Job cancellation |
| `make test-system-error` | Error recovery |
| `make test-system-stall` | Stall detection (host mode only) |
| `make test-system-poller` | Trello poller card lifecycle |
| `make test-system-cleanup` | Orphaned temp dirs + zombie jobs |

Requires running Docker infrastructure (`make launch-infra` + `make launch-worker REPO=danxbot`) and `ANTHROPIC_API_KEY` in `.env`. Tests the full stack: real HTTP, real Claude, real Trello.

### Key files

| Path | Purpose |
|------|---------|
| `src/__tests__/` | Unit tests (co-located with source) |
| `src/__tests__/integration/` | Integration tests (fake-claude + capture server) |
| `src/__tests__/integration/helpers/` | fake-claude.ts, capture-server.ts, capture-server-cli.ts |
| `src/__tests__/validation/` | Validation tests (real Claude API) |
| `src/__tests__/system/run-system-tests.sh` | System test runner (shell script) |
| `vitest.validation.config.ts` | Validation-specific vitest config |

## Build Workflow

Every phase or unit of work follows this exact order:

0. **Load `/wow`** — invoke Ways of Working skill to reload critical rules into recency
1. **Implement** — write the code, run `npx vitest run` and `npx tsc --noEmit`
2. **Test coverage** — launch `test-reviewer` agent to audit coverage, then write tests to fill all gaps
3. **Code review** — launch `code-reviewer` agent, fix all findings
4. **Report** — present results to user, wait for approval and commit

This applies per-phase in phased plans and to any standalone work (>10 lines or multiple files). Steps 2-3 are mandatory quality gates — never skip or defer them.

## Agent Spawn Architecture

All agents are spawned via a single `spawnAgent()` function in `src/agent/launcher.ts`. Every agent process is monitored by `SessionLogWatcher` (reading Claude Code's native JSONL from `~/.claude/projects/`).

Key principle: `DANXBOT_RUNTIME=host` vs `docker` affects ONLY presentation (interactive terminal tab vs headless). Monitoring, heartbeat, event forwarding, stall detection — all behave identically regardless of runtime mode.

Core monitoring components (all in `src/agent/`):
- **SessionLogWatcher** — polls Claude's JSONL session files; the canonical monitoring source
- **LaravelForwarder** — batches and POSTs agent events to the Laravel API
- **StallDetector** — detects agents stuck after receiving tool results; wired in `dispatch.ts`
- **TerminalOutputWatcher** — tails terminal log captured by `script -q -f`; feeds StallDetector

## Autonomous Agent Team

### Triggers

Skills are injected into the target repo by the poller (danx-* prefix, gitignored).

| Skill | Purpose |
|-------|---------|
| `/danx-start` | Process ALL cards in ToDo |
| `/danx-next` | Process single top card |
| `/danx-ideate` | Build knowledge + generate feature cards |

### Team Roles

The main Claude Code session acts as the orchestrator. Subagents are launched via the Task tool with `mode: "bypassPermissions"`.

| Agent | File | Role |
|-------|------|------|
| Ideator | `.claude/agents/ideator.md` | Repo knowledge + feature generation |
| Validator | `.claude/agents/validator.md` | Runs real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Trello Board

Board/list/label IDs are in `.claude/rules/danx-trello-config.md` in the target repo (auto-generated by the poller).

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
2. `/danx-start` or `/danx-next` triggers the workflow
3. Main session picks up card, moves to In Progress (position: `"top"`), creates progress checklist
4. If the card requires human intervention (external service settings, account config, etc.), adds `Needs Help` label and moves to Needs Help list (position: `"top"`)
5. Evaluates scope — splits into epic phases if too large (3+ phases), labels parent as Epic, creates phase cards in In Progress
6. Orchestrator implements directly using TDD (failing test, implement, pass, refactor)
7. Launches Test Reviewer + Code Reviewer subagents for quality gates
8. Posts review results as Trello card comments, fixes any critical issues
9. Launches Validator subagent only for agent/SDK changes
10. Commits, moves card to Done (position: `"top"`), adds retro comment
11. Epic splitting: parent gets Epic label, phase cards named `Epic > Phase N > Description` created in In Progress
12. Every Done card gets a retro comment (What went well, What went wrong, Action items, Commits)
13. Retro action items create linked cards in the Action Items list
