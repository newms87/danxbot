# Agent Dispatch Architecture

Canonical spec for how danxbot launches a Claude Code agent (Trello card / Slack / HTTP). `CLAUDE.md` = overview; this file = always-on contracts. Deep contracts (resume, staged_files, Playwright proxy, usage dedup, claude-auth diag, DX-242 fallback chain, DX-246 stream-idle recover) live in the `danxbot:dispatch-deep` skill — load via Skill tool before editing those code paths.

## Workspace isolation — the cwd contract

Every dispatch runs with `cwd = <repo>/.danxbot/workspaces/<name>/`. Contents:

- `.mcp.json` (per-workspace + `--strict-mcp-config` → only this workspace's MCP servers visible; danxbot infra server merged at spawn time)
- `workspace.yml`, `CLAUDE.md`, `.claude/settings.json` (enables `danxbot@newms-plugins`)
- Static rules + skills resolve via the `danxbot@newms-plugins` plugin (enabled in `.claude/settings.json`). Workspace `.claude/{rules,skills}/` contains ONLY per-repo rendered files — the inject pipeline no longer ships static rules or skills (epic DX-269 retired that surface).
- `.claude/rules/danx-repo-{config,overview,workflow}.md` + `danx-tools.md` — rendered fresh from `RepoContext` every tick by `renderPerRepoFilesIntoWorkspaces`, duplicated per workspace so cwd-relative `Read .claude/rules/...` resolves locally without ancestor walk
- `.claude/tools/` — copied from `<repo>/.danxbot/config/tools/`

**Repo-root `<repo>/.claude/` is developer territory.** Danxbot never writes there and scrubs any `danx-*` artifact + legacy singular `<repo>/.danxbot/workspace/` dir every tick (`scrubRepoRootDanxArtifacts`, `scrubLegacySingularWorkspace`). `src/poller/index.test.ts` asserts zero writes outside `<repo>/.danxbot/workspaces/` — reintroducing a repo-root write fails CI.

`DANXBOT_WORKER_PORT` source chain (`src/repo-context.ts#readWorkerPort`): `<repo>/.danxbot/.env` (dev) → `process.env` (prod compose). No longer reads `<repo>/.claude/settings.local.json`.

Epic: agent-isolation `7ha2CSpc`.

## External Entry — Dashboard → Worker Proxy

Workers bind only on `danxbot-net` (no public ingress). Caddy → port 443 → dashboard; dashboard proxies auth-gated routes to the named worker container.

| Route | Method | Notes |
|---|---|---|
| `/api/launch` | POST | `{repo, workspace, task, api_token, overlay?, staged_files?, ...}` → `http://danxbot-worker-<repo>:<workerPort>/api/launch`. Legacy `allow_tools`/`agents`/`schema_*` 400 since P5 (`9baf431`). |
| `/api/resume` | POST | `{repo, job_id, task, api_token, ...}` → `claude --resume`. See dispatch-deep skill. |
| `/api/status/:jobId?repo=` | GET | Status forward. |
| `/api/cancel/:jobId?repo=` | POST | Cancel forward. |
| `/api/stop/:jobId?repo=` | POST | External stop. The in-agent `danxbot_complete` callback targets `localhost:<workerPort>` directly. |

All require `Authorization: Bearer $DANXBOT_DISPATCH_TOKEN`. Token generated per-target at deploy (`deploy/secrets.ts::getOrCreateDispatchToken`), persisted at `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`, materialized into dashboard container's `/danxbot/.env`. `checkAuth` (`src/dashboard/dispatch-proxy.ts`) is timing-safe: 401 bad/missing, 500 dashboard has no token.

Worker hostname: `workerHost(name) = danxbot-worker-<name>` (compose `container_name`). Resolved via Docker DNS on `danxbot-net`. Worker port from `deploy/targets/<DANXBOT_TARGET>.yml`'s per-repo `worker_port:` via `src/target.ts#loadTarget` (legacy `REPO_WORKER_PORTS` retired in Phase B).

**Playwright proxy** `/api/playwright/<tail>` is binary-safe — do NOT reuse `proxyToWorker` (corrupts PNG bytes). Full contract → dispatch-deep skill.

**Router is strict allowlist.** Unknown path or method → `{"error":"Not found"}` 404. No SPA fallback except `GET /` serving `index.html`. Prevents the regression where `POST /api/launch` returned SPA HTML 200.

## The Single Fork Principle

Every dispatch spawns EXACTLY ONE claude process. Runtime auto-detected from `/.dockerenv` (container → docker; host → host); runtime is never set via env var. Mode only changes the spawn shape — everything downstream is identical.

| Concern | Docker | Host |
|---|---|---|
| Spawn | `spawn("claude", ["-p", taggedPrompt, ...])` headless | `wt.exe` opens Windows Terminal tab; bash script runs `script -q -f -c "claude <flags> -- <firstMessage>"` interactive |
| User-visible | Nothing | Live TUI |
| Prompt | `-p` argv | Positional arg after `--` |
| Monitoring / StallDetector / LaravelForwarder / Heartbeat / Usage / `danxbot_complete` | Identical (SessionLogWatcher → JSONL) |
| Cancel | SIGTERM `job.process` | SIGTERM tracked PID (claude inside terminal) |

ONE fork, ONE process, ONE JSONL, ONE watcher. Adding a second spawn / observer / monitoring path = STOP, you're unwinding this contract.

## SessionLogWatcher — the only monitoring mechanism

Claude Code writes native JSONL at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` for every invocation. `SessionLogWatcher` (`src/agent/session-log-watcher.ts`) polls it. Faster than stdout `--output-format stream-json` (benchmarked — do not add stdout parsing back). Identical in both runtimes.

All observers subscribe to the watcher:

- `StallDetector` — nudge/kill stuck agents. Reads watcher + ✻ thinking indicator from `TerminalOutputWatcher`.
- `LaravelForwarder` — batches watcher entries → POSTs `statusUrl`.
- Heartbeat — periodic PUTs to `statusUrl` keyed off watcher liveness.
- Summary extraction — last assistant text block.
- Usage totals — `usage` field on assistant entries (MUST dedupe by `message.id` → dispatch-deep skill).

Dispatch tag `<!-- danxbot-dispatch:<jobId> -->` prepended to every prompt for watcher disambiguation in shared JSONL files. Never skip the tag.

Only legitimate second observer: `TerminalOutputWatcher` (`src/agent/terminal-output-watcher.ts`) — detects ✻ thinking indicator in the `script -q -f` terminal log. Stall-detection input only, not a semantic event stream.

## Completion Signaling

Agents call `danxbot_complete({status, summary})` (MCP tool, `src/mcp/danxbot-server.ts`). MCP server POSTs `DANXBOT_STOP_URL` (`http://localhost:<worker_port>/api/stop/<dispatchId>`). Worker `job.stop`:

1. Set `job.status` + `job.summary` BEFORE killing (prevents exit handler race).
2. Register close listener BEFORE signal (catch fast exit).
3. SIGTERM tracked PID; 5s grace → SIGKILL.
4. Run `job._cleanup` (watcher.stop, forwarder.flush, heartbeat stop, inactivity timer clear, MCP settings-dir rm).
5. PUT final status to `statusUrl` if configured.

Host mode: killing claude → bash script exits → Windows Terminal tab closes.

**Fallback chain (DX-242):** if HTTP fails (worker dead), MCP server falls through to direct DB UPDATE then atomic filesystem queue at `<repoRoot>/.danxbot/dispatch-stops/<dispatchId>.json` for boot replay. Full contract + boot replay invariants → dispatch-deep skill.

### Per-dispatch callback URLs

`dispatch()` (`src/dispatch/core.ts`) auto-injects all `http://localhost:<worker_port>/api/<route>/<dispatchId>` URLs into the per-dispatch overlay — callers never pre-compute:

| Env var | Route | Tool |
|---|---|---|
| `DANXBOT_STOP_URL` | `/api/stop/<id>` | `danxbot_complete` |
| `DANXBOT_SLACK_REPLY_URL` | `/api/slack/reply/<id>` | `danxbot_slack_reply` (Slack only) |
| `DANXBOT_SLACK_UPDATE_URL` | `/api/slack/update/<id>` | `danxbot_slack_post_update` (Slack only) |
| `DANXBOT_ISSUE_CREATE_URL` | `/api/issue-create/<id>` | `danx_issue_create` |
| `DANXBOT_RESTART_WORKER_URL` | `/api/restart/<id>` | `danxbot_restart_worker` |

Plus `DANXBOT_DISPATCH_ID` + `DANX_REPO_ROOT` + `DANXBOT_DB_*` for the DX-242 fallback context (no URL).

`buildActiveTools` in `danxbot-server.ts` is the SOLE filter hiding each tool when its URL is absent from `DanxbotToolUrls`. `callTool` also fail-loud-throws on missing URL (defense in depth). Adding a new tool: extend `DanxbotToolUrls`, `McpFactoryOptions`, inject in `mcp-registry.ts`, auto-inject in `dispatch/core.ts` overlay, register tool def + dispatcher case + advertise-filter case in `danxbot-server.ts`, register worker-side route in `src/worker/server.ts`.

`danxbot_complete` is always available — launcher injects it even when the dispatch passes no other MCP config.

DX-157 retired the agent-facing save URL: agents `Edit`/`Write` the YAML directly; chokidar (`src/db/issues-mirror.ts`) mirrors to Postgres on file events; post-completion auto-sync (`src/worker/auto-sync.ts`) pushes to tracker on `danxbot_complete`. Poller per-tick mirror = eventual consistency safety net.

## Pre-dispatch staging — `staged_files`

`/api/launch` accepts `staged_files: [{path, content}]`. Written before `spawnAgent`. Workspace `workspace.yml` declares `staging-paths:` allowlist (with `${KEY}` overlay-substituted placeholders); workspace without `staging-paths` rejects non-empty `staged_files` 400. Cleanup on terminal state removes only paths this dispatch wrote. Full validation pipeline + path-traversal defenses → dispatch-deep skill.

## Usage accumulation MUST dedupe by `message.id`

Multi-block assistant turns emit one JSONL entry per content block but stamp identical `message.usage` on every entry (same `message.id`). Consumers summing `usage` MUST dedupe by `messageId` or count 2–5× real cost (bit prod once, commit `d11b63d`). Existing dedupers: `src/agent/launcher.ts` `seenUsageMessageIds`, `src/dashboard/jsonl-reader.ts` `parseJsonlContent`. New consumers MUST follow. Full evidence + producer list → dispatch-deep skill.

## JSONL layout — parents + sub-agents

- Parent: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- Sub-agent: `<session-uuid>/subagents/agent-<hash>.jsonl` + sidecar `agent-<hash>.meta.json` carrying `{agentType, description}`.

Parent→child linkage is by `description` text — parent's `tool_use.input.description` matches sub-agent meta's `description`. NOT by UUID or `agentId`. Sub-agent entries carry `isSidechain: true` + `agentId` matching the filename hash. Tool name is `Agent` (older captures: `Task`); readers should accept both. Relevant when walking sub-agents in `src/dashboard/jsonl-reader.ts`.

## Stall Recovery

`StallDetector`: no watcher activity + no ✻ indicator for threshold → nudge up to `DEFAULT_MAX_NUDGES` → kill + resume with nudge prompt → after max exhausted, mark failed. Identical in both runtimes (reads watcher, not process).

**Silent dispatch failures (timeout, no JSONL ever appears) are almost always broken claude-auth, not a stall.** Three known auth misconfigs: read-only `.claude.json`/`.claude/` bind, expired OAuth, mismatched UID. Diagnostic recipe → dispatch-deep skill BEFORE chasing StallDetector logic.

## Claude API stream-idle auto-recover (DX-246)

Distinct from Stall Recovery. Anthropic stream times out mid-turn → Claude Code writes a synthetic JSONL assistant entry (`model: "<synthetic>"`, content starts `API Error:`) optionally followed by `{type: "system", subtype: "turn_duration"}`. `ApiErrorDetector` matches, arms a 5s confirmation window (cancels if a real assistant entry arrives), then triggers recover: increment `recoverCount`; if `> MAX_RECOVERS (=3)` → write CRITICAL_FAILURE + `job.stop("api_error_failed")`; else → `job.stop("api_error_recover")` (collapses row to `status: "recovered"`) + `POST /api/resume` with `parent_recover_id`. Sub-agent entries skipped (sidechain-scoped). Full detector logic + integration points + tuning rationale → dispatch-deep skill.

## Host mode MUST be interactive — `claude -p` is FORBIDDEN there

Host runtime exists SOLELY for an interactive TUI. `claude -p` exits after one turn → defeats the purpose; if both modes used `-p`, host mode would have no reason to exist.

**Mechanism.** `src/agent/claude-invocation.ts#buildClaudeInvocation` produces `firstMessage = <!-- danxbot-dispatch:<jobId> --> @<abs-path-to-prompt.md>[ Tracking: <title>]`. Docker: `-p firstMessage` in argv. Host: positional arg after `--` inside `src/terminal.ts#buildDispatchScript` (`script -q -f` wraps for log capture). `@<path>` = claude's native file-attachment (small files inline, large files fall back to a Read-tool call since `--dangerously-skip-permissions` is set). NEVER reintroduce a meta-instruction (`Read <path> and execute…`); Phase 6 of workspace-dispatch epic retired that.

Code locations: `src/terminal.ts` (primary enforcement), `src/agent/launcher.ts` (headless vs interactive routing on `openTerminal`), `src/agent/claude-invocation.ts` (shared builder), `config.isHost` (true → interactive required).

Mechanical pre-edit check for `src/terminal.ts` / any WT-launching bash:
1. Invokes `claude -p`? → violation.
2. Claude exits after one turn? → violation.
3. User gets a typeable TUI? → required.

## Forbidden Patterns

| Forbidden | Why |
|---|---|
| `claude -p` in host mode | See "Host mode MUST be interactive". |
| `--output-format stream-json` anywhere | Vestigial. Replaced by SessionLogWatcher. |
| Two claude processes per dispatch | Two sessions, two JSONL, orphaned TUI, misreported usage. `openTerminal` branch REPLACES headless spawn, not supplements. |
| Parsing stdout for semantic content | Watcher already emits every tool call / text block / usage. |
| Parsing terminal log for anything other than ✻ indicator | JSONL = semantic; terminal log = stall input only. |
| Custom log files alongside JSONL | `writeJobLogs` deleted in Phase 2. `logs/<jobId>/{prompt.md,agents.json}` for debug artifacts only. |
| Legacy single-process mode | Removed. Only worker + dashboard modes. |
| Bypassing `isFeatureEnabled` in `handleLaunch` | `/api/launch` MUST 503 when `dispatchApi` is disabled (first line of handler try block). Skipping breaks the Agents tab contract. |
| `mcp__trello__*` from a dev session to inspect cards | Local YAML at `<repo>/.danxbot/issues/{open,closed}/*.yml` is the single source of truth. Trello = one-way mirror. Read YAML directly. |
| Trello in the agent's critical path (synchronous `tracker.createCard` in `danx_issue_create`, sync tracker writes in agent-facing YAML mutations, surfacing Trello errors in agent output, Trello creds in dispatched-agent env) | Trello = background infra. `danx_issue_create` writes YAML and returns immediately. Agent YAML edits → `Edit`/`Write` (DX-157) → chokidar mirrors to DB. Worker poll loop + `auto-sync.ts` push to Trello async with `.trello-retry/` queue. Trello errors surface ONLY in the dashboard. DX-203 retired the MCP server's tracker concept; `@thehammer/danx-issue-mcp` reads only `DANX_REPO_ROOT`. |
| Reintroducing an agent-facing save MCP tool / HTTP route | DX-157 retired this. Round-trip would double-mirror to DB and leak tracker errors into agent output. |
| `allowed-tools.txt` / `--allowed-tools` / per-tool allowlist | Retired (`src/workspace/resolve.ts` header). `--dangerously-skip-permissions` bypasses `--allowed-tools` so the flag was never an enforceable gate. Workspace `.mcp.json` + `--strict-mcp-config` IS the agent's MCP surface. Stale `allowed-tools.txt` throws `WorkspaceLegacyFileError` at resolve time. |
| Calling `runPicker` / `tryMultiAgentDispatch` outside the per-repo single-flight mutex (`firePickerWithMutex` / `runWithPickerMutex` in `src/dispatch/scheduler.ts`) | DX-305. Three concurrency sources fire pickers for one repo; without the mutex, two macrotasks pick the same agent + card → double-spawn. Use `firePickerWithMutex(repoName)` for fire-and-forget pokes; `runWithPickerMutex(repoName, fn)` when caller needs the `MultiAgentPickResult`. |

## Critical failure flag — poller halt

`<repo>/.danxbot/CRITICAL_FAILURE` halts the poller for a broken-env condition (MCP not loading, Bash unavailable, Claude auth missing). Written by the worker on `danxbot_complete({status:"critical_failure", ...})` or by the post-dispatch check (card still in ToDo after a run). Poller reads at the top of every tick, refuses to dispatch while present. Dashboard shows red banner; operator clears via the dashboard button or `rm`. Slack + `/api/launch` are unaffected.

Contract + invariants:
- `src/critical-failure.ts` header — format, ownership, invariants.
- `danxbot:halt-flag` plugin skill — operator-facing half; dispatched agents load it to decide when to signal `critical_failure` vs `failed`.
- In-situ comments: `src/worker/dispatch.ts` (handleStop), `src/poller/index.ts` (halt gate + `checkCardProgressedOrHalt`), `src/worker/health.ts` (halted status precedence), `src/worker/critical-failure-route.ts` (idempotent clear).

Re-read those headers before editing — the feature exists because prod burned ~$1K in a day on 40 re-dispatches against a stuck card.

## Dispatch API disabled state

Operator flips `overrides.dispatchApi.enabled = false` on Agents tab → `POST /api/launch` returns `503 {"error":"Dispatch API is disabled for repo <name>"}` before parsing body or any spawn bookkeeping. Dashboard proxy forwards status + body verbatim. Re-enable requires no worker restart.

## Runtime Modes At A Glance

- **Worker mode** (`DANXBOT_REPO_NAME` set): one process per repo. Starts dispatch API (`/api/launch`, `/api/cancel`, `/api/stop`, `/api/status`, `/api/jobs`), Slack listener (if configured), poller (only if `DANX_TRELLO_ENABLED=true`). Worker port from `<repo>/.danxbot/.env` (dev) or `process.env.DANXBOT_WORKER_PORT` from compose (prod). `GET /api/jobs` returns every job in `activeJobs` (running + recently-finished within TTL); consumer = `src/__tests__/system/run-system-tests.sh` isolation helper. Not exposed via dashboard proxy — local-worker only.
- **Dashboard mode** (`DANXBOT_REPO_NAME` unset): shared process. Migrations, HTTP server, SSE, analytics. No poller, no Slack, no claude spawning.

Only worker mode spawns claude.

## Spawn Flow

1. Trigger: HTTP `/api/launch`, poller pick-up (`<repo>/.danxbot/issues/open/` with `status: ToDo`, `blocked: null`, `list_kind != "action_items"`), or Slack route. Poller does NOT read Trello for dispatch decisions — YAML is source of truth.
2. Handler builds `DispatchInput` → `dispatch()` (`src/dispatch/core.ts`). Poller adds `onComplete` for card-progress bookkeeping; HTTP handlers shape body into the same `DispatchInput`. Same resolver, same settings file, same `spawnAgent`. **No per-dispatch tool allowlist** — workspace `.mcp.json` + `--strict-mcp-config` IS the MCP surface.
3. `dispatch()` → `resolveWorkspace()` (`src/workspace/resolve.ts`) → merge danxbot infra MCP server → write per-dispatch settings.json to fresh temp dir → `spawnAgent()`.
4. `spawnAgent` generates `jobId` → `buildClaudeInvocation()` writes `prompt.md` to fresh temp dir, builds `firstMessage` with dispatch tag + `@<abs-path>` attachment. Fork:
   - Docker: `spawn("claude", args)` with `-p firstMessage`, stdout ignored (stderr piped for failure summaries only).
   - Host: `buildDispatchScript()` writes `run-agent.sh` (writes claude's PID to a file, then exec's `script -q -f -c "claude <flags> -- <firstMessage>"`). `spawnInTerminal()` launches via `wt.exe`. Launcher polls the PID file for tracked PID.
5. `SessionLogWatcher` polls `~/.claude/projects/` for JSONL containing the dispatch tag; attaches.
6. Observers wire to watcher: summary, stall, Laravel (only when `statusUrl` + `apiToken` both present), heartbeat.
7. Agent runs. Every JSONL entry → subscribers.
8. `danxbot_complete` → stop handler kills tracked process. Cleanup: per-dispatch MCP settings dir removed FIRST, then `input.onComplete?.(job)` (poller's card-progress check). Final status PUT.

### Poller specifics

Poller shares `dispatch()` with `/api/launch` since Phase 4. `src/poller/index.ts` never imports `spawnAgent` and never writes its own `settings.json` — reintroducing either unwinds Phase 4.

- Poller-triggered agents always get `mcp__danxbot__danxbot_complete` (infra-injected); inactivity-timeout-as-completion-signal retired in favor of the MCP callback. Inactivity timeout remains as safety net.
- `onComplete` hook = `handleAgentCompletion` (card-progress check, stuck-card recovery, consecutive-failure backoff). Ordering: MCP settings cleanup runs BEFORE `onComplete` so post-completion checks never see a half-disposed dispatch.
- Poller's MCP surface: `src/poller/inject/workspaces/issue-worker/.mcp.json` — adding/removing a Trello tool is a one-line edit, no callsite changes.
- Empty-ToDo branch ordering: `_poll` calls `checkAndSpawnTriage` BEFORE `checkAndSpawnIdeator`. When `autoTriage` is enabled AND any Review/Needs Help/Blocked card has `triage.expires_at <= now` (or empty), dispatch `/danx-triage-card <PREFIX>-N` for ONE eligible card and return (single-dispatch invariant). Triage preempts ideator. Per-status decision tree (Review 24h / Needs Help 3h / Blocked 1h, ICE-sorted) → `danxbot:danxbot` skill "Trello Poller".

## Key Files

| File | Role |
|---|---|
| `src/agent/launcher.ts` | `spawnAgent()`, `cancelJob()`, `job.stop()`, heartbeat, inactivity timer, runtime fork |
| `src/agent/session-log-watcher.ts` | The one monitoring mechanism |
| `src/agent/stall-detector.ts` | Stall detection + nudge/kill/resume |
| `src/agent/api-error-detector.ts` | DX-246 synthetic JSONL detector |
| `src/agent/attach-monitoring-stack.ts` | Wires all observers onto the shared watcher; carries `handleApiErrorRecover` + `MAX_RECOVERS` |
| `src/agent/terminal-output-watcher.ts` | ✻ indicator (stall input only) |
| `src/agent/laravel-forwarder.ts` | Batched event POSTs |
| `src/terminal.ts` | `buildDispatchScript()`, `spawnInTerminal()`, PID file emission |
| `src/mcp/danxbot-server.ts` | `danxbot_complete` MCP tool + advertise filter + DX-242 fallback chain |
| `src/worker/dispatch.ts` | HTTP handlers for `/api/launch`, `/api/stop`, `/api/cancel`, `/api/status`, `/api/resume` |
| `src/worker/server.ts` | Routing layer |
| `src/worker/replay-stop-queue.ts` | DX-242 boot replay |
