# Danxbot

Autonomous AI agent that orchestrates Claude Code CLI dispatches. Connects to one or more repos, processes Trello cards, and optionally answers questions in Slack. Run `./install.sh` for interactive setup.

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
                dispatch() → spawnAgent (Claude CLI) → agent posts reply via danxbot_slack_reply

Trello card    → Poller (per-repo)        → dispatch() → spawnAgent (Claude CLI)
HTTP /launch   → Worker dispatch endpoint → dispatch() → spawnAgent (Claude CLI)
```

Every dispatched agent (Slack deep-agent, Trello poller, `/api/launch`) takes the same spawned-CLI path. The Slack listener posts the initial "thinking" placeholder, then the dispatched agent itself writes the final reply by calling the `danxbot_slack_reply` MCP tool — a worker HTTP endpoint routes the payload back to the bolt client for the originating repo.

| Component | Path | Role |
|---|---|---|
| Router | `src/agent/router.ts` | Anthropic SDK call to Haiku for instant Slack triage |
| Dispatch core | `src/dispatch/core.ts` (`dispatch`) | Unified dispatch — MCP resolution, spawnAgent, stall recovery, activeJobs |
| Launcher | `src/agent/launcher.ts` (`spawnAgent`) | Single entry point for every dispatched Claude CLI process |
| Poller | `src/poller/index.ts` | Per-repo Trello tick loop. State is in-memory (`state.teamRunning`, `state.polling`) — no on-disk lock files. |
| Slack listener | `src/slack/listener.ts` | One `@slack/bolt` App per Slack-enabled repo; calls `dispatch()` for deep-agent replies |
| Dashboard API | `src/dashboard/server.ts` | REST + SSE on port 5555 |
| Dashboard SPA | `dashboard/` | Vite + Vue 3 + Tailwind 4 |

Runtime mode is auto-detected from `/.dockerenv` at startup — inside a container → docker (headless), on host → host (interactive Windows Terminal). Runtime affects ONLY the spawn shape; monitoring, heartbeat, event forwarding, and stall detection are identical. See `.claude/rules/agent-dispatch.md` for the full contract.

## Tech Stack

- **Runtime:** Node.js 20 + `tsx` (TypeScript executed directly, no build step)
- **AI SDKs:** `@anthropic-ai/sdk` (router — Haiku triage only). Every dispatched agent runs as a spawned Claude Code CLI subprocess; there is no in-process SDK agent path.
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
| `<repo>/.danxbot/.env` | Secrets + per-repo toggles (`DANX_*` prefix) + `DANXBOT_WORKER_PORT` | gitignored |
| `<repo>/.danxbot/.env.<target>` | **Per-deploy-target overlay** — overrides keys in `.env` at deploy time only | gitignored |
| `<repo>/.danxbot/workspaces/<name>/` | Generated dispatch cwds — one dir per workspace (e.g. `issue-worker`), each with its own danxbot-owned `.mcp.json`, `CLAUDE.md`, `.claude/` subtree | gitignored |
| `<repo>/.claude/` | **Developer territory only** — danxbot never reads or writes here | dev-maintained |

`<repo>/.danxbot/.env` standardized vars: `DANX_TRELLO_ENABLED` (default `false` — explicit opt-in), `DANX_SLACK_BOT_TOKEN`, `DANX_SLACK_APP_TOKEN`, `DANX_SLACK_CHANNEL_ID`, `DANX_DB_HOST/USER/PASSWORD/NAME`, `DANX_GITHUB_TOKEN`, `DANX_TRELLO_API_KEY`, `DANX_TRELLO_API_TOKEN`, `DANXBOT_WORKER_PORT`.

Danxbot's own root `.env` keeps only shared infrastructure: `ANTHROPIC_API_KEY`, `CLAUDE_AUTH_MODE`, `REPOS`, `DANXBOT_DB_*`, `DASHBOARD_PORT`, `DANXBOT_GIT_EMAIL`.

### Per-target env overlays

`.env.<target>` files (e.g. `.env.platform`, `.env.gpt`) supply prod-only values without polluting the dev `.env`. They live alongside the `.env` they override — same directory, same key/value format — and are layered on top by `deploy/secrets.ts#collectDeploymentSecrets` ONLY when `make deploy TARGET=<target>` runs. The merge is in-memory: override keys win, base-only keys preserved, override-only keys added; missing override file is a no-op. Local dev never reads them. Three locations support overlays:

- `<root>/.env.<target>` → shared SSM keys (`/<ssm_prefix>/shared/*`)
- `<repo>/.danxbot/.env.<target>` → per-repo danxbot keys (`/<ssm_prefix>/repos/<name>/*`)
- `<repo>/<app_env_subpath>/.env.<target>` → per-repo app keys (`/<ssm_prefix>/repos/<name>/REPO_ENV_*`)

Use this for prod Slack channel IDs, prod-specific DB hosts, prod URLs — anything that diverges between local and a specific deploy target. Files are gitignored by default (`.env.*` with `!.env.example` exception).

Connected repos live at `repos/<name>/` (symlinks to actual working copies). The `REPOS` env var lists them: `platform:url,danxbot:url`. `loadRepoContext()` in worker mode builds the single active `RepoContext` from the named repo.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/`. The poller syncs it into every plural workspace's `.claude/rules/danx-tools.md` (e.g. `<repo>/.danxbot/workspaces/issue-worker/.claude/rules/danx-tools.md`). Each dispatched agent cwds into its workspace dir so the file resolves cwd-relative — claude never path-walks to the developer's repo-root `.claude/`. Tool definitions stay repo-specific; danxbot's system prompts reference them generically without hardcoding paths.

### Per-Repo Feature Toggles

Three runtime toggles per repo (Slack / Trello poller / Dispatch API) live at `<repo>/.danxbot/settings.json` — three-valued (`true` / `false` / `null` defers to env default). Workers re-read on every event so toggles take effect with no restart. Operator overrides survive every redeploy. Full ownership contract + schema: `.claude/rules/settings-file.md`. Spec: `docs/superpowers/specs/2026-04-20-agents-tab-design.md`.

## External Dispatch API (Production)

Workers bind only on `danxbot-net`. The dashboard (Caddy → 443) proxies auth-gated dispatch requests to the right worker. Bearer token: `DANXBOT_DISPATCH_TOKEN` (per-deployment, persisted to SSM at `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`).

Quickstart:

```bash
curl -sS -X POST https://danxbot.sageus.ai/api/launch \
  -H "Authorization: Bearer $DANXBOT_DISPATCH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo": "gpt-manager", "workspace": "system-test", "task": "Reply OK and call danxbot_complete.", "api_token": "'"$DANXBOT_DISPATCH_TOKEN"'"}'
```

`workspace` is required since the P5 cutover (commit `9baf431`) — the worker rejects any body that uses the legacy caller-supplied `allow_tools`/`agents`/`schema_*` fields. Substitute the workspace name your deployment ships under `<repo>/.danxbot/workspaces/`. The danxbot-shipped `system-test` workspace works for connectivity smoke against any deployed target.

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

**Before ANY test-related action — running, writing, fixing, inspecting, or reasoning about tests — invoke the `testing` skill.** This is mandatory on the FIRST test-related action per session and is the TodoWrite checklist for the entire testing discipline (run/write/fix procedure, output-to-file rule, `--filter` protocol, anti-patterns). The section below only documents danxbot-specific paths and layers; the HOW lives in the skill.

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

Backend tests are at `src/**/*.test.ts`. Dashboard tests are at `dashboard/src/**/*.test.ts`. Running `npx vitest run` from the repo root only picks up backend — `cd dashboard && npx vitest run` for the SPA. (The `testing` skill's "Mandatory Setup" requires output-to-file; the danxbot convention is `> /tmp/vitest.log 2>&1`.)

### UI Frontend Test Exemption

**The Vue UI layer under `dashboard/src/` does NOT require tests.** This includes Vue SFCs (`*.vue`), composables (`dashboard/src/composables/**`), UI-only utilities, and `api.ts` typed fetch wrappers. Writing tests for them is optional; the `test-reviewer` subagent and pipeline step 2 (Test coverage) MUST NOT flag missing coverage in these paths, and a >10-line change confined to `dashboard/src/` does NOT trigger the mandatory test-coverage gate.

**Still required** (no exemption):

- Backend API + SSE + auth + analytics under `src/dashboard/**` (`server.ts`, `events.ts`, `auth-db.ts`, `jsonl-reader.ts`, `dispatch-proxy.ts`, `playwright-proxy.ts`, etc.) — unit + integration tests mandatory
- Everything else under `src/**` (agent, poller, slack, worker, dispatch, mcp, deploy)
- Type checking: `cd dashboard && npx vue-tsc --noEmit` still required (type-check ≠ test)

Existing dashboard tests under `dashboard/src/**/*.test.ts` are kept as-is — exemption means "not required going forward," not "delete what's there."

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

Board / list / label IDs live in each connected repo's `<repo>/.danxbot/config/trello.yml`. Workspace skills resolve them through the `IssueTracker` interface (`src/issue-tracker/`); Trello-specific bookkeeping stays inside `src/issue-tracker/trello.ts`.

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
10. Action items → linked cards in the Action Items list. **Action items are a LAST RESORT** — see `src/poller/inject/workspaces/issue-worker/.claude/skills/danx-next/SKILL.md` Step 1.5. Anything required for the current card's ACs is the current card's work, not an action item. Anything small + unrelated should also be done in this session, not deferred. Action items only for large, unrelated, separately-scopeable work that genuinely needs its own card. Same rule applies to Needs Help — last resort, only for true human / external blockers, never as a deferral mechanism for in-scope or small fixes.
11. Signal completion via the `danxbot_complete` MCP tool — never exit silently. The worker uses the signal to finalize the dispatch row in MySQL.
