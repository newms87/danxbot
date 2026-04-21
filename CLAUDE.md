# Danxbot

Autonomous AI agent powered by the Claude Code SDK. Connects to one or more repos, processes Trello cards, and optionally answers questions in Slack. Run `./install.sh` for interactive setup.

## CRITICAL Pointers Before Touching Sensitive Areas

These rule files are auto-loaded; the pointers below exist so a fresh agent knows the contract BEFORE editing.

| If you're touching… | Read first |
|---|---|
| `src/agent/launcher.ts`, `terminal.ts`, `session-log-watcher.ts`, `stall-detector.ts`, `laravel-forwarder.ts`, `mcp/danxbot-server.ts`, `worker/dispatch.ts` | `.claude/rules/agent-dispatch.md` (single-fork, JSONL-only monitoring, completion signaling) |
| Anything that builds the host-mode bash dispatch script | `.claude/rules/host-mode-interactive.md` (`claude -p` is FORBIDDEN in host mode) |
| `<repo>/.danxbot/settings.json` ownership / feature toggles | `.claude/rules/settings-file.md` |
| Anything `make`-able | `.claude/rules/make-commands.md` |
| Anything in production (logs, status, db, ssh) | `.claude/rules/production-access.md` |
| Repo bind-mounts, container layout, runtime detection | `.claude/rules/docker-runtime.md` |

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick reply
                    ↓ (if needsAgent)
                Agent (Claude Code SDK query) → detailed reply

Trello card    → Poller (per-repo)        → spawnAgent (Claude CLI)
HTTP /launch   → Worker dispatch endpoint → spawnAgent
```

| Component | Path | Role |
|---|---|---|
| Router | `src/agent/router.ts` | Anthropic SDK call to Haiku for instant Slack triage |
| Agent (Slack) | `src/agent/agent.ts` (`runAgent`) | Claude Code SDK `query()` for deep Slack responses |
| Launcher | `src/agent/launcher.ts` (`spawnAgent`) | Single entry point for every dispatched Claude CLI process |
| Poller | `src/poller/index.ts` | Per-repo Trello tick loop. State is in-memory (`state.teamRunning`, `state.polling`) — no on-disk lock files. |
| Slack listener | `src/slack/listener.ts` | One `@slack/bolt` App per Slack-enabled repo |
| Dashboard API | `src/dashboard/server.ts` | REST + SSE on port 5555 |
| Dashboard SPA | `dashboard/` | Vite + Vue 3 + Tailwind 4 |

Runtime mode is auto-detected from `/.dockerenv` at startup — inside a container → docker (headless), on host → host (interactive Windows Terminal). Runtime affects ONLY the spawn shape; monitoring, heartbeat, event forwarding, and stall detection are identical. See `.claude/rules/agent-dispatch.md` for the full contract.

## Tech Stack

- **Runtime:** Node.js 20 + `tsx` (TypeScript executed directly, no build step)
- **AI SDKs:** `@anthropic-ai/sdk` (router), `@anthropic-ai/claude-agent-sdk` (Slack agent)
- **Slack:** `@slack/bolt` (Socket Mode)
- **Dashboard:** Vite + Vue 3 SFCs + Tailwind 4

## Setup

`./install.sh` launches an interactive wizard (`/setup` skill). It collects Anthropic / GitHub / Trello / optional Slack credentials, clones + explores the repo, and generates `.danxbot/config/`, `.env`, and tailored rules. No manual `.env` editing required.

## Connected Repos (Multi-Repo)

Danxbot manages multiple repos from one server. Each repo has independent state — its own poller, Slack connection, Trello board, and DB credentials.

**Per-repo config locations** (inside each connected repo):

| Path | Purpose | Committed? |
|---|---|---|
| `<repo>/.danxbot/config/` | `config.yml`, `trello.yml`, `compose.yml`, `overview.md`, `workflow.md`, `tools.md`, `docs/` | yes |
| `<repo>/.danxbot/.env` | Secrets + per-repo toggles (`DANX_*` prefix) | gitignored |
| `<repo>/.claude/settings.local.json` | MCP env vars + `DANXBOT_WORKER_PORT` (Claude Code does not load `.env` for MCP) | gitignored |

`<repo>/.danxbot/.env` standardized vars: `DANX_TRELLO_ENABLED` (default `false` — explicit opt-in), `DANX_SLACK_BOT_TOKEN`, `DANX_SLACK_APP_TOKEN`, `DANX_SLACK_CHANNEL_ID`, `DANX_DB_HOST/USER/PASSWORD/NAME`, `DANX_GITHUB_TOKEN`, `DANX_TRELLO_API_KEY`, `DANX_TRELLO_API_TOKEN`.

Danxbot's own root `.env` keeps only shared infrastructure: `ANTHROPIC_API_KEY`, `CLAUDE_AUTH_MODE`, `REPOS`, `DANXBOT_DB_*`, `DASHBOARD_PORT`, `DANXBOT_GIT_EMAIL`.

Connected repos live at `repos/<name>/` (symlinks to actual working copies). The `REPOS` env var lists them: `platform:url,danxbot:url`. `loadRepoContext()` in worker mode builds the single active `RepoContext` from the named repo.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/`. The poller syncs it to the repo's `.claude/rules/tools.md`, which the Claude Code SDK auto-loads via `settingSources: ["project"]`. Tool definitions stay repo-specific; danxbot's system prompts reference them generically without hardcoding paths.

### Per-Repo Feature Toggles

Three runtime toggles per repo (Slack / Trello poller / Dispatch API) live at `<repo>/.danxbot/settings.json` — three-valued (`true` / `false` / `null` defers to env default). Workers re-read on every event so toggles take effect with no restart. Operator overrides survive every redeploy. Full ownership contract + schema: `.claude/rules/settings-file.md`. Spec: `docs/superpowers/specs/2026-04-20-agents-tab-design.md`.

## External Dispatch API (Production)

Workers bind only on `danxbot-net`. The dashboard (Caddy → 443) proxies auth-gated dispatch requests to the right worker. Bearer token: `DANXBOT_DISPATCH_TOKEN` (per-deployment, persisted to SSM at `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`).

Quickstart:

```bash
curl -sS -X POST https://danxbot.sageus.ai/api/launch \
  -H "Authorization: Bearer $DANXBOT_DISPATCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "gpt-manager", "task": "Reply OK and call danxbot_complete.", "api_token": "'"$DANXBOT_DISPATCH_TOKEN"'"}'
```

Full route table (`/api/launch`, `/api/resume`, `/api/status/:id`, `/api/cancel/:id`, `/api/stop/:id`), the resume protocol, the disabled-state semantics, and the proxy 404 invariant: `.claude/rules/agent-dispatch.md#external-entry`.

## Deployment

Per-target AWS deploys; per-target config at `.danxbot/deployments/<target>.yml`. Deploy source: `deploy/cli.ts`, terraform under `deploy/terraform/`.

**Current targets:** `gpt` (hosts both `danxbot` and `gpt-manager` workers).

**"Deploy the X danxbot" ALWAYS means `make deploy TARGET=<x>`** from this repo. NEVER `make launch-worker` (local docker), NEVER deploying the connected repo's own app.

**Production IS reachable from this shell** — never say "I can't reach production from here". Use the proxy / SSH / `docker exec` recipes in `.claude/rules/production-access.md`.

## Make Commands & Build Workflow

All `make` targets, when to use which, and the production-vs-local invocation conventions: `.claude/rules/make-commands.md`. Required reading before running any `make` command — it's auto-loaded.

Per-phase / per-unit-of-work pipeline (project-specific):

0. Invoke `/wow` to reload critical rules into recency
1. **Implement** — write code, run `npx vitest run` and `npx tsc --noEmit`
2. **Test coverage** — launch the `test-reviewer` subagent, fill all gaps it flags
3. **Code review** — launch the `code-reviewer` subagent, fix all findings
4. **Report** — present results, wait for approval, commit via `/flow-commit`

Steps 2 and 3 are mandatory quality gates. Applies to every phase in phased plans and every standalone change >10 lines or touching multiple files.

## Testing

Three layers; commands and cost are in `.claude/rules/make-commands.md`. Layer 1 (unit + integration) is free and Docker-free. Layer 2 (validation) hits the real Claude API. Layer 3 (system) needs running infra + worker + `ANTHROPIC_API_KEY`.

Key test paths (project-specific, not duplicated elsewhere):

| Path | Purpose |
|---|---|
| `src/__tests__/` | Unit + integration test root |
| `src/__tests__/integration/helpers/` | `fake-claude.ts`, `capture-server.ts`, `capture-server-cli.ts` |
| `src/__tests__/validation/` | Validation tests (real Claude API) |
| `src/__tests__/system/run-system-tests.sh` | System test runner shell script |
| `vitest.validation.config.ts` | Validation-specific vitest config |
| `dashboard/vitest.config.ts` | Dashboard SFC tests (separate from backend `vitest.config.ts`) |

Backend tests are at `src/**/*.test.ts`. Dashboard tests are at `dashboard/src/**/*.test.ts`. Running `npx vitest run` from the repo root only picks up backend — `cd dashboard && npx vitest run` for the SPA.

## Agent Spawn Architecture (Summary)

Every dispatched agent goes through `spawnAgent()` in `src/agent/launcher.ts`. Every spawn is monitored by `SessionLogWatcher` reading Claude Code's native JSONL from `~/.claude/projects/`. ONE claude process per dispatch, ONE JSONL, ONE watcher. Runtime mode (auto-detected) only changes the spawn shape — everything downstream is identical.

| Component | File | Role |
|---|---|---|
| `SessionLogWatcher` | `src/agent/session-log-watcher.ts` | Canonical monitoring source — JSONL polling |
| `LaravelForwarder` | `src/agent/laravel-forwarder.ts` | Batches and POSTs agent events to a Laravel API |
| `StallDetector` | `src/agent/stall-detector.ts` | Detects stuck agents; nudges + kills |
| `TerminalOutputWatcher` | `src/agent/terminal-output-watcher.ts` | Tails terminal log for ✻ thinking indicator (stall-input only) |

Full contract — what to do, what NOT to do, the forbidden-patterns table, the resume protocol — lives in `.claude/rules/agent-dispatch.md`.

## Autonomous Agent Team

### Triggers

Skills are injected into each connected repo by the poller (gitignored, `danx-*` prefix). The inject step is authoritative — files removed from `src/poller/inject/` are pruned from consuming repos on the next poll tick.

| Skill | Purpose |
|---|---|
| `/danx-start` | Process ALL cards in ToDo |
| `/danx-next` | Process the single top card |
| `/danx-ideate` | Build knowledge + generate feature cards |

### Subagent Roles

The main session is the orchestrator. Subagents are launched via Task with `mode: "bypassPermissions"`.

| Agent | File | Role |
|---|---|---|
| Ideator | `.claude/agents/ideator.md` | Repo knowledge + feature generation |
| Validator | `.claude/agents/validator.md` | Real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Trello Board

Board / list / label IDs are auto-generated by the poller into `.claude/rules/danx-trello-config.md` of each connected repo.

| List | Purpose |
|---|---|
| Review | New cards awaiting human review |
| ToDo | Approved cards ready for work |
| In Progress | Currently being worked on |
| Needs Help | Blocked on human intervention |
| Done | Completed |
| Cancelled | Dropped |
| Action Items | Retro action items for future improvement |

### Card Workflow (Orchestrator)

1. Move approved card from Review → ToDo (human action)
2. `/danx-start` or `/danx-next` triggers the orchestrator
3. Pick up card → move to In Progress (`position: "top"`) → add Progress checklist
4. If human intervention needed → add `Needs Help` label → move to Needs Help
5. Evaluate scope; split into epic + phase cards if 3+ phases
6. TDD implementation (failing test → implement → verify)
7. Quality gates: launch Test Reviewer + Code Reviewer subagents in parallel; post results as Trello comments; fix critical findings
8. Validator subagent only for agent / SDK changes
9. Commit, move card to Done (`position: "top"`), add retro comment (What went well / What went wrong / Action items / Commits)
10. Action items → linked cards in the Action Items list
11. Signal completion via the `danxbot_complete` MCP tool — never exit silently. The worker uses the signal to finalize the dispatch row in MySQL.
