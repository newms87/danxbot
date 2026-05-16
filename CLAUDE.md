# Danxbot

Autonomous AI agent that orchestrates Claude Code CLI dispatches. Connects to one or more repos, processes Trello cards, and optionally answers questions in Slack. Run `./install.sh` for interactive setup.

## Core Principle: Single Canonical Schema — Fail Loud, No Legacy

Every data shape in this codebase (issue YAMLs, settings.json, dispatch rows, every other persisted struct) has exactly ONE correct version at any time. For issue YAMLs that version is currently `schema_version: 10` (track `KNOWN_SCHEMA_MAX` in `src/issue-tracker/schema-versions.ts`).

- There is exactly ONE correct version of any data shape at any time. Disk YAMLs round-trip byte-stable at `KNOWN_SCHEMA_MAX`.
- Forward migration to the current version is automatic at worker boot via the registry (`src/issue-tracker/migrations/`). The boot sweep walks every YAML, runs `migrateForward` to canonicalize, then re-asserts the strict shape.
- Any YAML on disk after the boot sweep that fails strict validation is a bug, not an edge case. Fix the migration or the writer — never tolerate, never paper over with a silent default at parse time.
- Code NEVER contains back-compat reader branches, "auto-migrate on read", silent defaults at parse time, or version-conditional logic at the read path. Migration is a single, well-defined, registered, tested chain — not a scatter of read-time conditionals.
- Adding a new schema field: (a) bump `KNOWN_SCHEMA_MAX` in `src/issue-tracker/schema-versions.ts`, (b) bump the writer literal in `src/issue-tracker/yaml.ts`, (c) add one migration file under `src/issue-tracker/migrations/v<N-1>-to-v<N>.ts` with paired test, (d) ship via `make publish-danx-issue-mcp` so the bundled MCP validator catches up. The boot sweep does the rest on next worker start.
- Mismatch surfaces at the validator: a read of a YAML below `KNOWN_SCHEMA_MIN` (= `KNOWN_SCHEMA_MAX - 1`) throws fail-loud with the file path + offending field name.
- Cross-cutting: this principle applies to every persisted shape in the codebase, not only issue YAMLs. Settings files, dispatch rows, prep verdicts — same contract: one canonical version, one migration chain, no read-time tolerance.

The forbidden tokens — `back-compat`, `forward-compat`, `auto-migrate`, `schema_version` literals other than the canonical one — appear in this codebase ONLY in this section (as quoted forbidden patterns) and in `.claude/rules/agent-dispatch.md` "Forbidden Patterns" table (also as quoted forbidden patterns). Anything else is a regression.

## Core Principle: Computed Card State — Status is Derived, Not Written (DX-575)

Every issue YAML's `status` field is **derivation-owned by `deriveStatus()`** at `src/issue/derive-status.ts`. The seven-rule precedence reads lifecycle timestamps (`cancelled_at`, `completed_at`, `ready_at`, `archived_at`) + gate fields (`blocked.at`, `dispatch`) and projects them into the `IssueStatus` value the dashboard + tracker render. **Agent skills never instruct direct writes of `status: "<terminal>"`.** Trigger writes only.

The lifecycle-trigger contract (DX-584 worker write paths, Phase 4):

| Transition | Trigger write | Derived rule |
|---|---|---|
| Pickup (ToDo → In Progress) | Worker sets `dispatch != null` in `dispatch/core.ts` BEFORE `spawnAgent` | rule 4 → `In Progress` |
| Ready (Review → ToDo) | Triage Approve / agent / move-to-ready-list → `ready_at = <now ISO>` | rule 5 → `ToDo` |
| Complete (In Progress → Done) | Worker `stampIssueCompleted` on `danxbot_complete({status: "completed"})` → `completed_at = <now ISO>` + `dispatch: null` | rule 2 → `Done` |
| Cancel (any → Cancelled) | Worker `stampIssueCancelled` / triage Cancel → `cancelled_at = <now ISO>` + `dispatch: null` | rule 1 → `Cancelled` |
| Block (any → Blocked) | Agent self-block / worker `stampIssueBlocked` → `blocked: {at: <now ISO>, reason}` + `dispatch: null` | rule 3 → `Blocked` |
| Park (any → Backlog) | Move-to-archived-list → `archived_at = <now ISO>` (also clear `ready_at`) | rule 6 → `Backlog` |

`list_name` is **display-only** — workers never read it for state-machine decisions. The auto-resolve write path resolves it to the derived semantic type's default list (DX-584); humans may override via dashboard list moves. Backend logic = 100% timestamps + `dispatch` + `blocked.at` + `waiting_on` + `requires_human` + `conflict_on[]`.

**Forbidden Patterns — direct `status:` writes in agent skills:**

| Forbidden | Use instead |
|---|---|
| Edit YAML: `status: "In Progress"` (pickup) | Worker auto-flips `dispatch != null` before spawn — no agent edit |
| Edit YAML: `status: "ToDo"` (triage Approve) | Stamp `ready_at = <now ISO>` |
| Edit YAML: `status: "Done"` (complete) | Call `danxbot_complete({status: "completed"})`; worker stamps `completed_at` |
| Edit YAML: `status: "Cancelled"` (cancel) | Stamp `cancelled_at = <now ISO>` (triage) or call `danxbot_complete({status: "cancelled"})` |
| Edit YAML: `status: "Blocked"` + `blocked: {reason, timestamp}` (self-block) | Stamp `blocked: {at: <now ISO>, reason}` (single write — derives via rule 3) |
| `blocked: {reason, timestamp}` (deprecated shape) | `blocked: {at, reason}` (v10 canonical) |
| `blocked.by[]` (never existed in v10) | `waiting_on.by[]` (the v10 dep-gate primitive) |

The only legitimate `status:` literal at write time is `Review` on a freshly created card — that lands as the raw on-disk value, and `deriveStatus` rule 7 falls through to it when no lifecycle trigger is populated. Every other status surface is derived.

`status` remains a writable serializer field for round-trip stability (DX-582 description rule 7 fallthrough), but the canonical read path is `parseIssue` → `deriveStatus`. Direct on-disk drift never leaks into business logic.

## CRITICAL Pointers Before Touching Sensitive Areas

Auto-loaded rules + skills. Trigger the right one BEFORE editing.

### Rule files (auto-loaded each turn)

| Touching… | Read first |
|---|---|
| `src/agent/launcher.ts`, `terminal.ts`, `session-log-watcher.ts`, `stall-detector.ts`, `laravel-forwarder.ts`, `mcp/danxbot-server.ts`, `worker/dispatch.ts`, host-mode bash script | `.claude/rules/agent-dispatch.md` — single-fork, JSONL-only, completion signaling, "Host mode MUST be interactive" |
| `<repo>/.danxbot/settings.json` ownership / feature toggles | `.claude/rules/settings-file.md` |
| Anything `make`-able | `.claude/rules/make-commands.md` |
| Repo bind-mounts, container layout, runtime detection, root `.mcp.json` inject, `.env.<target>` overlays | `.claude/rules/docker-runtime.md` |
| Dashboard dev URLs (5566/5555), restart matrix, agent auth token, **DanxUI component-library mandate (no raw HTML tooltips, no hand-rolled modals/buttons/icons)** | `.claude/rules/dashboard.md` |

### Skill triggers (invoke via Skill tool)

| Trigger | Skill |
|---|---|
| About to run `make launch-*`, `make deploy*`, anything that starts a poller / worker / prod target | `danxbot:no-unauthorized-worker-launch` (strict — per-invocation user auth required) |
| Anything in production: deployed job/dispatch/container/log/DB/SSH, `make deploy-*`, `danxbot.sageus.ai`, "I can't reach production" | `danxbot:prod-access` |
| Editing root `.mcp.json` inject, `deploy/secrets.ts`, `.env.<target>` overlays, workspace cwd, container paths, Laravel `.env.{APP_ENV}` trap | `danxbot:docker-deep` |
| Editing `/api/resume`, `staged_files` validation, Playwright proxy binary path, any `usage` accumulator, debugging silent-dispatch / claude-auth failures | `danxbot:dispatch-deep` |
| Editing `src/settings-file.ts`, dashboard Agents tab handlers, adding feature toggle / display field, `syncSettingsFileOnBoot`, pre-rename `trelloPoller` key fallback | `danxbot:settings-deep` |
| Reading / writing / creating any issue YAML, ESPECIALLY epic creation (epics MUST ship with phase cards same turn) | `danxbot:issue-card-workflow` |
| Card status `Needs Help` / `blocked != null`, `/unblock` invoked | `danxbot:unblock` |
| Anything about danxbot runtime / dispatch / Trello-as-background-infra / poller boundary | `danxbot:danxbot` |
| Investigating without fixing (diagnose / "why" / "how does X work" / read-only audit) | `investigate:investigate` |
| Bug, error, failing test, factual claim about codebase behavior | `dev:debugging` |
| Running / writing / fixing any test | `dev:testing` |
| Before any file edit | `dev:code-quality` |
| Before any git op | `dev:git-discipline` |
| Before any kill signal | `base:process-kill` |
| Before any Agent / Task subagent dispatch | `base:sub-agent-delegation` |
| Before EnterPlanMode, before checking off AC, before phase complete | `pipeline:pipe-plan` |

## `@thehammer/danx-issue-mcp` — danxbot owns this package

Source: `~/web/danx-issue-mcp/`. Every dispatched agent and host session resolves the MCP via `npx -y @thehammer/danx-issue-mcp` so npm IS the runtime. Source edits are not deployed until published.

**Standing authorization.** Any agent that edits `~/web/danx-issue-mcp/` source — schema bumps, handler changes, dist rebuilds — MUST run `make publish-danx-issue-mcp` from this repo as the final step of that work. The target handles version bump, per-publish `.npmrc` from `NPM_TOKEN` (in `<danxbot>/.env`), registry propagation wait, `~/.npm/_npx/` cache clear. No operator gate, no Blocked card, no "human will publish later" — publishing IS the completion of the edit. Defer only on transient registry network failures (retry).

**Sequencing rule.** When the change touches BOTH the MCP package AND danxbot's consumer side (workspace `.mcp.json`, inject contract, dispatch overlay), publish first → then commit danxbot side. Reverse order = ~60s window where every workspace dispatch breaks because the new env shape lands locally before npm propagates the matching server. The publish make target waits for `npm view` to surface the new version before exiting; once it returns, the danxbot commit is safe.

**Schema bump contract.** Bump = (1) writer literal in `src/issue-tracker/yaml.ts` bumped, (2) `KNOWN_SCHEMA_MAX` in `src/issue-tracker/schema-versions.ts` bumped, (3) one migration file added under `src/issue-tracker/migrations/v<N-1>-to-v<N>.ts` with paired test, (4) same-commit publish via `make publish-danx-issue-mcp` so the bundled MCP validator catches up. Readers accept `KNOWN_SCHEMA_MAX` (canonical) and `KNOWN_SCHEMA_MAX - 1` (defense-in-depth tier handed off to `migrateForward` inline); the boot sweep handles the drift window so reads at canonical happen the vast majority of the time. Anything `< KNOWN_SCHEMA_MIN` throws fail-loud with the file path. The writer == `KNOWN_SCHEMA_MAX` invariant is pinned by the unit suite — a one-sided bump fails CI before it reaches a host session. Sequencing: when the change touches the MCP package AND danxbot consumer side, publish first → commit consumer side, otherwise the ~60s npm propagation gap breaks every workspace dispatch.

## Architecture

```
Slack message → Router (Haiku, ~300ms) → quick reply
                    ↓ (if needsAgent)
                dispatch() → spawnAgent (Claude CLI) → agent posts reply via danxbot_slack_reply

Local YAML     → Poller (per-repo)        → dispatch() → spawnAgent (Claude CLI)
HTTP /launch   → Worker dispatch endpoint → dispatch() → spawnAgent (Claude CLI)
```

The poller dispatches off `<repo>/.danxbot/issues/open/*.yml` (status: ToDo, waiting_on: null, list_kind != "action_items"). The Trello tracker is a one-way mirror; the poller never reads Trello to decide what to dispatch. See "Source of Truth" below.

Every dispatched agent (Slack deep-agent, Trello poller, `/api/launch`) takes the same spawned-CLI path. The Slack listener posts the initial "thinking" placeholder, then the dispatched agent itself writes the final reply by calling the `danxbot_slack_reply` MCP tool — a worker HTTP endpoint routes the payload back to the bolt client for the originating repo.

| Component | Path | Role |
|---|---|---|
| Router | `src/agent/router.ts` | Anthropic SDK call to Haiku for instant Slack triage |
| Dispatch core | `src/dispatch/core.ts` (`dispatch`) | Unified dispatch — MCP resolution, spawnAgent, stall recovery, activeJobs |
| Launcher | `src/agent/launcher.ts` (`spawnAgent`) | Single entry point for every dispatched Claude CLI process |
| Poller | `src/poller/index.ts` | Per-repo tick loop. Reads local YAML for dispatch decisions. Mirrors YAML state to Trello + pulls new tracker-born cards and human comments inbound. State is in-memory (`state.teamRunning`, `state.polling`) — no on-disk lock files. |
| Slack listener | `src/slack/listener.ts` | One `@slack/bolt` App per Slack-enabled repo; calls `dispatch()` for deep-agent replies |
| Dashboard API | `src/dashboard/server.ts` | REST + SSE on port 5555 |
| Dashboard SPA | `dashboard/` | Vite + Vue 3 + Tailwind 4 |

Runtime mode is auto-detected from `/.dockerenv` at startup — inside a container → docker (headless), on host → host (interactive Windows Terminal). Runtime affects ONLY the spawn shape; monitoring, heartbeat, event forwarding, and stall detection are identical. See `.claude/rules/agent-dispatch.md` for the full contract.

**Host-mode process confinement + orphan-reap safety net (DX-323 / DX-551).** On host, every dispatch is wrapped in a per-dispatch transient systemd user-scope unit (`danxbot-dispatch-<id>.scope`) so backgrounded grandchildren the agent's Bash tool spawns (`yes &`, double-forks, daemons) inherit the cgroup. `systemctl --user stop <scope>.scope` reaps the entire tree atomically — there is no `kill(pid)` fallback on host, and the worker refuses to boot without `systemd-run --user --version` + `systemctl --user is-system-running`. The worker's boot path runs a one-shot `reap-orphan-dispatches` pass (`src/cron/worker-loop.ts` → `src/cron/jobs/index.ts`) BEFORE the HTTP listener accepts dispatches, then a 60s in-worker `setInterval` re-fires the same registry while the worker is alive — catches scopes the worker leaked through an unclean death (OOM, kill -9, host reboot) by joining live scope units with the `dispatches` table and stopping every unit whose row is terminal-or-missing. Per-job `lastRunMs` persists in `<repo>/.danxbot/cron-state.json` so a worker bounce inside an interval does not double-fire. DX-551 retired the prior `make install-cron` / `src/cron/tick.ts` system-crontab install surface — the worker owns the loop now. Docker runtime SKIPS the scope wrapper because the container boundary already confines the tree.

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

`.env.<target>` files (e.g. `.env.gpt`) layer over the base `.env` ONLY at `make deploy TARGET=<target>` time (in-memory merge in `deploy/secrets.ts#collectDeploymentSecrets`). Local dev never reads them. Three overlay locations: `<root>/.env.<target>` (shared SSM), `<repo>/.danxbot/.env.<target>` (per-repo danxbot), `<repo>/<app_env_subpath>/.env.<target>` (per-repo app). Full contract: `.claude/rules/docker-runtime.md`.

Connected repos live at `repos/<name>/` (symlinks). `REPOS` env var lists them: `platform:url,danxbot:url`. `loadRepoContext()` builds the single active `RepoContext` from the named repo.

### Agent Tools

Each connected repo can define a `tools.md` in `.danxbot/config/`. The poller syncs it into every plural workspace's `.claude/rules/danx-tools.md` (e.g. `<repo>/.danxbot/workspaces/issue-worker/.claude/rules/danx-tools.md`). Each dispatched agent cwds into its workspace dir so the file resolves cwd-relative — claude never path-walks to the developer's repo-root `.claude/`. Tool definitions stay repo-specific; danxbot's system prompts reference them generically without hardcoding paths.

### Per-Repo Feature Toggles

Five runtime toggles per repo (Slack / Issue poller / Dispatch API / Ideator / Auto-triage) live at `<repo>/.danxbot/settings.json` — three-valued (`true` / `false` / `null` defers to env default). Workers re-read on every event so toggles take effect with no restart. Operator overrides survive every redeploy. `autoTriage` (env default `false` — explicit opt-in) lets the poller spawn the `danx-triage` agent in `auto` mode when the ToDo queue is empty AND there are untriaged Action Items / Review cards; triage spawn preempts the ideator on the same tick. Full ownership contract + schema: `.claude/rules/settings-file.md`. Spec: `docs/superpowers/specs/2026-04-20-agents-tab-design.md`.

## Self-Repair — WORKER FAULTS ONLY

Self-repair concept is valid **only for broken workers** — worker boot failure, MCP server load failure, unexpected exception in dispatch/poller code, anything where the worker itself is broken and a fresh agent dispatched against the worker codebase can plausibly fix it. The previous card-creating implementation (DX-560 epic) was retired — it conflated agent-domain YAML errors (`audit-pass:ReconcileValidationError`, `orphan-ip-heal`, `invariant-heal`) with worker faults and spawned card-based repairs that looped because the YAML status never flipped terminal.

**Hard rules:**
- Agent failures (mid-dispatch crash, timeout, can't complete a card) do NOT trigger self-repair. They use the existing strike→Blocked-agent flow (`agents.<name>.broken` after 3 strikes, surfaced in the dashboard Agents tab).
- An agent that can't complete its card stamps the card itself (`status: Blocked` + `blocked.reason` OR `requires_human` OR `conflict_on[]`). The card carries the failure mode; no second agent is dispatched to "fix" the first agent's card.
- Self-repair, when rebuilt, will be card-LESS — `dispatch()` fires with an inline task body (worker repair instructions + signature + sample payload), no YAML, no issueId, lifecycle keyed on the dispatch row.
- `recordSystemError` / `reportSystemError` keep recording errors to `system_errors` for operator visibility on the Self-Repair dashboard tab. No auto-dispatch fires off that table today.

## External Dispatch API + Deployment

Workers bind only on `danxbot-net`; dashboard (Caddy → 443) proxies auth-gated dispatch via `DANXBOT_DISPATCH_TOKEN` bearer. Per-target AWS deploys at `deploy/targets/<target>.yml`. Current targets: `gpt`.

**"Deploy the X danxbot" ALWAYS means `make deploy TARGET=<x>`** — NEVER `make launch-worker` (local), NEVER the connected repo's own app deploy.

**Production IS reachable from this shell.** Routes (`/api/launch|resume|status|cancel|stop`), curl quickstart, SSH/docker-exec recipes, debug recipes → invoke `danxbot:prod-access` skill. Route + auth contract spec → `.claude/rules/agent-dispatch.md` "External Entry".

## Make Commands & Build Workflow

All `make` targets, when to use which, and the production-vs-local invocation conventions: `.claude/rules/make-commands.md`. Required reading before running any `make` command — it's auto-loaded.

Per-phase / per-unit-of-work pipeline (project-specific):

0. Invoke `/pipe-start` to reload critical rules into recency
1. **Implement** — write code, run `npx vitest run` and `npx tsc --noEmit`
2. **Test coverage** — launch the `test-reviewer` subagent, fill all gaps it flags
3. **Code review** — launch the `code-reviewer` subagent, fix all findings
4. **Report** — present results, wait for approval, commit via `/pipe-commit`

Steps 2 and 3 are mandatory quality gates. Applies to every phase in phased plans and every standalone change >10 lines or touching multiple files.

## Testing

**Before any test-related action: invoke `dev:testing` skill.** Skill owns the HOW (run/write/fix, output-to-file, `--filter`, anti-patterns). Section below = danxbot-specific paths only.

Three layers (commands + cost: `.claude/rules/make-commands.md`):
- **Layer 1** — unit + integration: free, Docker-free. `src/__tests__/`, helpers at `src/__tests__/integration/helpers/` (`fake-claude.ts`, `capture-server.ts`)
- **Layer 2** — validation: ~$1, real Claude API. `src/__tests__/validation/` + `vitest.validation.config.ts`
- **Layer 3** — system: ~$1, needs infra+worker+`ANTHROPIC_API_KEY`. `src/__tests__/system/run-system-tests.sh`

Backend = `src/**/*.test.ts` (root vitest). Dashboard = `dashboard/src/**/*.test.ts` (`cd dashboard && npx vitest run`). Output convention: `> /tmp/vitest.log 2>&1`.

**UI frontend test exemption.** Vue layer under `dashboard/src/` (SFCs, composables, `api.ts`) does NOT require tests; `test-reviewer` + pipeline step 2 MUST NOT flag missing coverage there. Still required: backend API + SSE + auth + analytics under `src/dashboard/**`, everything else under `src/**`, and `cd dashboard && npx vue-tsc --noEmit` type-check.

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

Skills live in the `danxbot@newms-plugins` plugin (`~/web/claude-plugins/danxbot/skills/`). Every dispatched workspace's `.claude/settings.json` enables the plugin with `autoUpdate: true`, so plugin edits propagate to dispatched workers without any inject ceremony.

| Skill | Purpose |
|---|---|
| `/danx-prep` | Pre-dispatch prep — WIP recovery + branch sync + file-scope conflict + self-stuck check. Runs first on every multi-agent dispatch (DX-291); emits a verdict via `mcp__danxbot__danxbot_prep_verdict` (`ok` / `conflict_on` / `blocked` / `abort`). Mode (`combined` vs `separate`) controlled by `agentDefaults.prepMode` in `<repo>/.danxbot/settings.json`. Replaces the retired `runConflictCheck` precursor + `dispatchInRecoveryMode` recovery prompt (DX-297). |
| `/danx-start` | Process ALL cards in ToDo |
| `/danx-next` | Process the single top card |
| `/danx-ideate` | Build knowledge + generate feature cards |

The `abort` verdict stamps `agents.<name>.broken` on `<repo>/.danxbot/settings.json` — the picker filters that agent out until the operator clears the field via the dashboard Agents tab. `conflict_on` stamps `conflict_on[]` on the candidate YAML so the poller's `isAnyKindBlocked` filter skips it while any partner is non-terminal.

### Subagent Roles

The main session is the orchestrator. Subagents are launched via Task with `mode: "bypassPermissions"`.

| Agent | File | Role |
|---|---|---|
| Ideator | `.claude/agents/ideator.md` | Repo knowledge + feature generation |
| Validator | `.claude/agents/validator.md` | Real Claude API validation tests |
| Test Reviewer | `.claude/agents/test-reviewer.md` | Audits test coverage (read-only) |
| Code Reviewer | `.claude/agents/code-reviewer.md` | Reviews code quality (read-only) |

### Source of Truth

**Local YAML at `<repo>/.danxbot/issues/{open,closed}/<id>.yml` is the single source of truth for every issue.** The poller's dispatch decisions read local YAML. The danxbot agent path reads + writes local YAML.

The backend tracker (Trello) is a **one-way mirror** with two narrow inbound exceptions: (a) new cards created on the tracker get hydrated into a fresh YAML on the next tick, and (b) human-authored comments on the tracker get pulled into the YAML's `comments[]`. Everything else inbound is ignored — a human dragging a card between lists, ticking an AC checkbox, or editing the title on Trello has no effect on the local YAML; the next tick re-asserts YAML state. Tracker = view + comment surface, not an editing surface for card structure.

Outbound (every tick): every YAML field — title, description, status, AC, phases, labels, comments, blocked record — is pushed to the tracker so humans see current state.

### Trello Is Background Infrastructure — 100% Decoupled From Issue-Tracker Business Logic

**Trello is a side system. Erasing it must have ZERO effect on the issue tracker.** Load-bearing architectural rule. The issue tracker — YAML on disk + DB mirror + dispatch lifecycle + picker + reconcile + scheduler poke chain — runs identically whether Trello is enabled, disabled, or removed entirely.

The ONLY Trello surface area:

1. **Inbound loop (when enabled).** `src/cron/inbound-fetch.ts` polls the tracker every cron tick: hydrates new cards into fresh YAMLs, pulls human comments into `comments[]`, flips Needs-Help cards back to ToDo. Gated entirely on `trelloSync.enabled`; disabled = skip the whole inbound module. Side effect on issue tracker: writes new YAMLs (chokidar → reconcile fires as if a human created the file). No business-logic dependency.
2. **Outbound push (when enabled).** A single step inside `reconcileIssue` (`src/issue/reconcile.ts:614` — step 7, `pushTrelloDiff`) pushes the diff to the tracker when the YAML changes. Gated by `trelloSync.enabled` AT THIS ONE LINE. The rest of reconcile (parent-derive, file-move heal, hash-diff, dispatchable fanout, scheduler poke, recurse parent/dependents) runs unconditionally.

**Forbidden — coupling issue-tracker business logic to Trello:**
- Gating `reconcileIssue` invocation on `trelloSync.enabled` (the call site, not the push step). Reconcile is business logic — it MUST always run when triggered (chokidar event, lifecycle event, audit pass). The Trello push is one of its eight steps and gates itself.
- Gating the picker / scheduler / `onReconcileResult` / `onAgentRosterChange` / `kickPickerOnceAtBoot` on `trelloSync`. Picker dispatching is independent of Trello availability.
- Gating `autoSyncTrackedIssue` (the post-dispatch reconcile in `src/worker/auto-sync.ts`) on `trelloSync` or on dispatch trigger source. Every dispatch with `issueId` non-null MUST reconcile post-completion regardless of trigger or Trello flag (history: a prior version of this module short-circuited on `trelloSync=false` → picker silently froze every Trello-disabled repo).
- Treating "Trello unreachable" as agent-blocking. Trello errors surface ONLY in the dashboard system-errors stream; they never block dispatch, never propagate to the agent.
- Calling `mcp__trello__*` from agent flow.
- Re-introducing tracker plumbing into `@thehammer/danx-issue-mcp` (DX-203 retired it; the MCP is YAML-only).
- Surfacing Trello creds to dispatched agents (env scrub at workspace boundary).

**Decoupling invariant** — the codebase, the docs, the tests, and the operator-visible surface must all read: "the issue tracker would run identically if every Trello-shaped file in `src/issue-tracker/`, every Trello-gated branch, and every Trello-shaped reconcile step were deleted in one commit." Reviewer agents and pipeline gates MUST flag any new code that adds a Trello-coupled branch outside the two surfaces above.

Full table + implications: `.claude/rules/agent-dispatch.md` Forbidden Patterns row + `danxbot:danxbot` skill.

### Trello Board

IDs in `<repo>/.danxbot/config/trello.yml`. Resolved via `IssueTracker` interface (`src/issue-tracker/`). Lists: Review → ToDo → In Progress → Blocked / Done / Cancelled + Action Items. The card's derived status comes from `deriveStatus()` reading the lifecycle triggers — stamping `blocked: {at, reason}` derives the card to `Blocked` via rule 3; cards waiting on OTHER cards use `Issue.waiting_on` (independent dispatch gate — picker skips dispatch while any dep is non-terminal; the field itself is a durable record decoupled from status).

### Card Workflow (Orchestrator)

**Before touching any issue YAML — load `danxbot:issue-card-workflow` skill via the Skill tool.** Skill is authoritative: epic creation MUST ship phase cards same turn (`children: []` on epic = never acceptable); pickup → In Progress → TDD → quality gates (Test Reviewer + Code Reviewer subagents in parallel) → commit → Done with retro → `danxbot_complete`. Action items + `status: Blocked` are LAST RESORT (see `danxbot:danx-next` skill Step 1.5). Validator subagent only for agent/SDK changes.
