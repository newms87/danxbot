# Agent Dispatch Architecture

How danxbot launches a Claude Code agent for a Trello card, Slack message, or HTTP dispatch. This file is the canonical reference. `CLAUDE.md` is the overview; this doc is the spec.

## Workspace isolation — the cwd contract

Every dispatched agent (poller, HTTP `/api/launch`, `/api/resume`, Slack) runs with `cwd = <repo>/.danxbot/workspace/`. The workspace is a fully generated directory (`src/workspace/generate.ts`) containing:

- `.mcp.json` — empty stub; combined with `--strict-mcp-config` it ensures the per-dispatch `.mcp.json` written by `dispatch()` is the ONLY MCP config claude reads
- `CLAUDE.md` — workspace marker
- `.claude/settings.json` — `{"env": {"DANXBOT_WORKER_PORT": "<port>"}}`, used by MCP child processes
- `.claude/rules/` + `.claude/skills/` + `.claude/tools/` + `.claude/agents/` — populated by `src/poller/index.ts#syncRepoFiles` on every poll tick (idempotent writes of every `danx-*` artifact from `.danxbot/config/` + `src/poller/inject/`)

The **repo-root `.claude/`** is strictly developer territory. Danxbot never reads OR writes there. A test in `src/poller/index.test.ts` asserts zero writes outside `<repo>/.danxbot/workspace/.claude/` — reintroducing any repo-root write breaks the isolation boundary and fails CI.

`DANXBOT_WORKER_PORT` lives in `<repo>/.danxbot/.env` (local dev) or `process.env` (production compose injection). `src/repo-context.ts#readWorkerPort` enforces this chain; it no longer reads `<repo>/.claude/settings.local.json`.

See the agent-isolation epic (Trello `7ha2CSpc`) for the full 5-phase design.

## External Entry — Dashboard → Worker Proxy

Workers bind only on `danxbot-net` and are not reachable from the public internet. Caddy reverse-proxies `localhost:<dashboard_port>` on port 443, so every external request hits the dashboard first. To give external dispatchers (e.g. the Laravel GPT-Manager app) a way to launch agents, the dashboard exposes an auth-gated proxy that forwards to the matching worker container.

| Route | Method | Notes |
|-------|--------|-------|
| `/api/launch` | POST | Body `{repo, task, api_token, ...}` — forwarded verbatim to `http://danxbot-worker-<repo>:<workerPort>/api/launch` |
| `/api/resume` | POST | Body `{repo, job_id, task, api_token, ...}` — resumes the Claude session from a prior dispatch. See "Resume" below |
| `/api/status/:jobId?repo=<name>` | GET | Forwards to the named worker's status endpoint |
| `/api/cancel/:jobId?repo=<name>` | POST | Forwards to the named worker's cancel endpoint |
| `/api/stop/:jobId?repo=<name>` | POST | Forwards to the named worker's stop endpoint (external stop, not the MCP callback — the in-agent `danxbot_complete` tool still targets `localhost:<workerPort>` inside the worker) |

Every external proxy call requires `Authorization: Bearer $DANXBOT_DISPATCH_TOKEN`. The token is generated per-target at deploy time by `deploy/secrets.ts::getOrCreateDispatchToken`, persisted under `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`, and materialized into the dashboard container's `/danxbot/.env`. `checkAuth` in `src/dashboard/dispatch-proxy.ts` is timing-safe and returns `401` for bad/missing tokens, `500` when the dashboard itself has no token configured.

Worker hostname resolution: `workerHost(name)` returns `danxbot-worker-<name>` — the `container_name` set in each repo's compose file. Both the dashboard and workers live on the `danxbot-net` bridge so the hostname resolves via Docker DNS. The dashboard reads `workerPort` from the `REPO_WORKER_PORTS` env var (also SSM-materialized, synthesized per-target from the deployment YML).

### Playwright proxy — binary-safe sibling of the worker proxy

`/api/playwright/<tail>` forwards every method to the Playwright container on `danxbot-net` at `${DANXBOT_PLAYWRIGHT_URL}<tail>` (default `http://playwright:3000`). Same `DANXBOT_DISPATCH_TOKEN` bearer auth as the worker-proxy routes — external callers hit the same dashboard, so the same 401/500 semantics apply. Implemented in `src/dashboard/playwright-proxy.ts`; route registration lives in the dispatch-proxy band in `src/dashboard/server.ts`, BEFORE the blanket `/api/*` user-auth gate.

**CRITICAL: do not reuse `proxyToWorker` here.** That helper hardcodes the outbound request Content-Type to `application/json` and calls `.toString("utf-8")` on the upstream body — both corrupt PNG screenshot bytes. `handlePlaywrightProxy` preserves request Content-Type, request body bytes, response Content-Type, response status, and response body bytes verbatim as `Buffer`s. If you add another binary upstream in the future, extend the Playwright forwarder pattern, not the JSON-only worker one.

Error mapping:
- `401` — bad/missing bearer
- `500` — dashboard has no `DANXBOT_DISPATCH_TOKEN` configured
- `502` — Playwright upstream unreachable / connect error
- `504` — upstream exceeded the per-request timeout (default `PLAYWRIGHT_DEFAULT_TIMEOUT_MS` = 30s; configurable via `PlaywrightProxyDeps.timeoutMs`)

### Unknown paths and methods always 404

The dashboard router is a strict allowlist. Any request outside the explicit route table — any method to any unknown path — returns `{"error":"Not found"}` with `404`. There is no SPA fallback: only a `GET` to a known SPA route (`/` today) serves `index.html`. This avoids the previous regression where `POST /api/launch` returned the SPA's HTML with `200`, silently passing smoke tests.

## The Single Fork Principle

Every dispatch spawns EXACTLY ONE claude process. Runtime mode is auto-detected from `/.dockerenv` (inside a container → docker; on host → host) and determines only HOW that one process is spawned — it does not change what the process does, what it reports, or how it's monitored. Runtime is never set via env var; the filesystem is the source of truth.

| Concern | Docker runtime | Host runtime |
|---------|----------------|--------------|
| How claude is spawned | `spawn("claude", ["-p", taggedPrompt, ...])` — headless, no TTY | Bash script + `wt.exe` opens a Windows Terminal tab, inside which `script -q -f` wraps an interactive `claude "Read $PROMPT_FILE and execute..."` |
| What the user sees | Nothing (headless) | A live Claude Code TUI in the Windows Terminal tab |
| Where the prompt goes | `-p` flag on the command line | `prompt.txt` file read by the first user message (positional arg) |
| Monitoring | SessionLogWatcher → JSONL | SessionLogWatcher → JSONL (identical) |
| StallDetector | Yes | Yes (identical) |
| LaravelForwarder | Yes | Yes (identical) |
| Heartbeat | Yes | Yes (identical) |
| Usage tokens | Extracted from watcher | Extracted from watcher (identical) |
| Completion signal | `danxbot_complete` MCP → `/api/stop/:jobId` | `danxbot_complete` MCP → `/api/stop/:jobId` (identical) |
| Cancellation | SIGTERM `job.process` | SIGTERM tracked PID (claude inside terminal) |

ONE fork, ONE process, ONE JSONL, ONE watcher. If you find yourself adding a second spawn, second observer, or duplicate monitoring path — STOP. That is the thing this doc exists to prevent.

## Resume

`POST /api/resume` spawns a fresh dispatch that inherits a prior job's Claude session via `claude --resume <sessionId>`. Claude loads the previous session's history and appends new turns to the SAME JSONL file. The new dispatch gets its OWN fresh dispatchId and its OWN dispatch tag — so `SessionLogWatcher` can still disambiguate this spawn's slice of the shared JSONL.

**Caller contract:** body shape is `{repo, job_id, task, api_token, ...}` where `job_id` is the PARENT dispatch id the caller got back from `/api/launch`. Callers never see or pass the Claude session UUID — the worker resolves it internally by scanning `~/.claude/projects/<cwd>/` for the parent's dispatch tag. Works across worker restarts because the tag lives in the JSONL file, not in `activeJobs` memory.

Response shape: `{job_id: <new dispatch id>, parent_job_id, status: "launched"}`. Subsequent `/api/status`, `/api/cancel`, `/api/stop` calls use the NEW `job_id`.

**Errors:**
- `400` — missing `job_id`, `task`, or `api_token`
- `404` — parent session file not found in the repo's `~/.claude/projects/` dir (stale parent, different repo, never existed)
- `503` — dispatch API disabled for this repo (same gate as `/api/launch`)

**Worker flow:**

1. Validate body → `isFeatureEnabled(repo, "dispatchApi")` → 503 if off
2. `resolveParentSessionId(repoName, parentJobId)` scans the repo's session dir for the parent's dispatch tag via `findSessionFileByDispatchId`; returns the basename of the JSONL (= Claude session UUID) or null
3. If null → `404`, no spawn
4. New dispatchId, fresh MCP settings, fresh dispatch tag, `--resume <sessionId>` added to claude flags via `buildClaudeInvocation`
5. `dispatch()` (in `src/dispatch/core.ts`) — the SAME shared helper as `/api/launch`. Stall recovery, heartbeat, activeJobs registration, TTL eviction all identical
6. Dispatch row carries `parent_job_id` so the chain is queryable
7. Response: `{job_id, parent_job_id, status: "launched"}`

**Invariants preserved:**

- Single fork — resume is its own dispatch; there is still exactly one claude process per dispatchId
- JSONL-only monitoring — the resume child's entries land in the same JSONL but are found by its fresh dispatch tag
- `danxbot_complete` — same MCP tool, same `/api/stop/:jobId` callback
- Host/docker parity — `--resume` flows through `buildClaudeInvocation`, which both runtime paths share

**Do not:**
- Return the Claude session UUID to callers — it's an internal detail. Callers resume by the dispatch `job_id`.
- Write a second mapping table (jobId → sessionId) — the dispatch tag already provides a deterministic, disk-durable mapping.
- Skip the fresh dispatch tag on resume — that breaks watcher disambiguation inside the shared JSONL.

## SessionLogWatcher Is The Only Monitoring Mechanism

Claude Code writes a native JSONL session log to `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` for every invocation (headless, SDK, or interactive TUI). This file is the canonical, runtime-agnostic source of truth for everything a dispatched agent does: assistant messages, tool calls, tool results, usage, completion.

`SessionLogWatcher` (`src/agent/session-log-watcher.ts`) polls that file and emits entries. It is faster than stdout parsing via `--output-format stream-json` (benchmarked — do not add stdout parsing back). It works identically in docker and host modes.

All downstream observers subscribe to the watcher, never to stdout, never to a second spawn:

- **StallDetector** (`src/agent/stall-detector.ts`) — nudges and kills stuck agents. Reads watcher entries + terminal-output-watcher's ✻ thinking indicator.
- **LaravelForwarder** (`src/agent/laravel-forwarder.ts`) — batches watcher entries and POSTs them to `statusUrl`.
- **Heartbeat** (`src/agent/launcher.ts`) — periodic PUTs to `statusUrl` using watcher activity as liveness.
- **Summary extraction** — last assistant text block captured in the watcher subscriber at spawn time.
- **Usage totals** — pulled from the `usage` field on assistant entries.

The dispatch tag (`<!-- danxbot-dispatch:<jobId> -->`) is prepended to every prompt so the watcher can disambiguate among concurrent sessions. Never skip the tag.

The only legitimate second observer is `TerminalOutputWatcher` (`src/agent/terminal-output-watcher.ts`), and its ONLY job is to detect the `✻` thinking indicator in the terminal log captured by `script -q -f`. That is a stall-detection input, not a semantic event stream.

## Completion Signaling

Agents signal completion with the `danxbot_complete` MCP tool. The tool is defined in `src/mcp/danxbot-server.ts` and is injected into every dispatched agent via `--mcp-config` pointing at a per-dispatch `settings.json` that sets `DANXBOT_STOP_URL`.

Flow:

1. Agent calls `danxbot_complete({status: "completed"|"failed", summary: "..."})`
2. MCP server POSTs `{status, summary}` to `DANXBOT_STOP_URL` (shape: `http://localhost:<worker_port>/api/stop/<dispatchId>`)
3. Worker's stop handler (`src/worker/dispatch.ts`) looks up the job and calls `job.stop(status, summary)`
4. `job.stop`:
   - Sets `job.status` and `job.summary` BEFORE killing (prevents exit handler racing it back to "running")
   - Registers close listener BEFORE sending signal (avoids missing a fast exit)
   - Sends SIGTERM to the tracked process
   - Waits 5s; SIGKILL if still alive
   - Runs `job._cleanup` (watcher.stop, forwarder.flush, heartbeat stop, inactivity timer clear, settings-dir rm)
   - PUTs final status to `statusUrl` if configured
5. In host mode, killing claude causes the bash script to exit, which closes the Windows Terminal tab.

Agents always have `danxbot_complete` available — even when the dispatch did not pass MCP config for any other reason. The launcher always injects it.

## JSONL File Layout — Parents and Sub-Agents

Empirically verified against real Claude Code captures:

- Parent session: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- Sub-agent sessions: `~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/agent-<hash>.jsonl` alongside a sidecar `agent-<hash>.meta.json` with `{agentType, description}`.

The **parent→child linkage is by `description` text** — the parent's `tool_use.input.description` matches the sub-agent meta's `description`. It is NOT by UUID or by the sub-agent's `agentId`. Keep that in mind when writing anything that walks sub-agents (e.g. `src/dashboard/jsonl-reader.ts`).

The tool name for sub-agent invocations is **`Agent`**, not `Task`, in current Claude Code. Readers should accept both to handle older captures.

Sub-agent JSONL entries carry `isSidechain: true` and an `agentId` field that matches the filename hash. They do NOT reference the parent by session UUID — the filesystem layout is the only structural link.

## Stall Recovery

When `StallDetector` determines an agent is stuck (no watcher activity + no ✻ indicator for threshold), it nudges up to `DEFAULT_MAX_NUDGES` times. If still stuck, it kills + resumes with a nudge prompt. After the max is exhausted, the job is marked failed. Stall recovery works identically in both runtime modes because it reads the watcher, not the process.

## Forbidden Patterns

These are regressions the team has already fixed. Do not reintroduce any of them.

| Forbidden | Why |
|-----------|-----|
| `claude -p` in host mode | Defeats interactivity, which is the entire reason host mode exists. See `host-mode-interactive.md`. |
| `--output-format stream-json` anywhere | Vestigial. Replaced by SessionLogWatcher. Stdout-based monitoring is slower and adds a second parser. |
| Two claude processes per dispatch | Creates two sessions, two JSONL files, orphaned TUI, misreported usage. The `openTerminal` branch must REPLACE the headless spawn, not supplement it. |
| Parsing stdout for semantic content | Watcher already emits every tool call, text block, and usage field. Stdout parsing is redundant. |
| Parsing the terminal log for anything other than the ✻ indicator | The log is for stall detection only. JSONL is for semantic events. |
| Custom log files written alongside the JSONL | `writeJobLogs` was deleted in Phase 2. Claude Code writes JSONL natively — do not write parallel logs for monitoring. `logs/<jobId>/` for debug artifacts (prompt.md, agents.json) is OK. |
| Legacy single-process mode | Removed. Only worker and dashboard modes exist. |
| Bypassing `isFeatureEnabled` in `handleLaunch` | `/api/launch` must 503 when `dispatchApi` is disabled in `.danxbot/settings.json` — the very first line inside the handler's try block. Skipping the check lets disabled repos still dispatch, which the Agents tab advertises as impossible. See `.claude/rules/settings-file.md`. |

## Critical failure flag — poller halt

A per-repo `<repo>/.danxbot/CRITICAL_FAILURE` file halts the poller when
the environment is broken (MCP not loading, Bash unavailable, Claude auth
missing). Written by the worker — either when the agent signals
`danxbot_complete({status:"critical_failure", summary})` or when the
worker's post-dispatch check sees the tracked card still in ToDo after a
run. Poller reads it at the top of every tick and refuses to dispatch
while present. Dashboard shows a red banner; operator clears via the
dashboard button or `rm`. Slack + `/api/launch` are unaffected by design.

Contract, invariants, and rationale live in code:

- `src/critical-failure.ts` header — format, ownership, invariants to
  preserve when editing the read/write paths.
- `src/poller/inject/rules/danx-halt-flag.md` — the rule that ships into
  EVERY connected repo so dispatched agents know when to signal
  `critical_failure` vs `failed`. This is the operator-facing half of the
  contract and is the entry point most agents need.
- In-situ comments in `src/worker/dispatch.ts` (handleStop branch),
  `src/poller/index.ts` (halt gate + `checkCardProgressedOrHalt`),
  `src/worker/health.ts` (halted status precedence), and
  `src/worker/critical-failure-route.ts` (idempotent clear) document the
  specific decisions at each call site.

When modifying any of those files, re-read the headers and preserve the
invariants. The feature exists because production burned ~$1K in a day on
40 re-dispatches against a single stuck card; silently re-enabling the
poller on a broken box is the exact failure mode we're paid to prevent.

## Dispatch API disabled state

When an operator flips `overrides.dispatchApi.enabled = false` on the
Agents tab, `POST /api/launch` returns `503 {"error": "Dispatch API is
disabled for repo <name>"}` without parsing the body or running any
spawn bookkeeping. The dashboard proxy in `dispatch-proxy.ts` forwards
the status and body verbatim, so external callers (gpt-manager, smoke
tests, curl) see exactly the same shape as an in-worker request. The
check runs on every request — toggling back to enabled requires no
worker restart.

## Runtime Modes At A Glance

- **Worker mode** (`DANXBOT_REPO_NAME` set): one process per repo. Starts dispatch API (`/api/launch`, `/api/cancel`, `/api/stop`, `/api/status`, `/api/jobs`), Slack listener (if configured), and poller (only if `DANX_TRELLO_ENABLED=true` in the repo's `.danxbot/.env`). Worker port is sourced from `DANXBOT_WORKER_PORT` in `<repo>/.danxbot/.env` (local dev) or `process.env.DANXBOT_WORKER_PORT` injected by compose from `.danxbot/deployments/<target>.yml` (production). Spawned via `make launch-worker REPO=<name>` (docker) or `make launch-worker-host REPO=<name>` (host).

  **`GET /api/jobs`** returns `{jobs: getJobStatus[]}` — every job currently in `activeJobs`, both running and recently-finished within the TTL grace window. Primary consumer is the system-test isolation helper in `src/__tests__/system/run-system-tests.sh` (cancels in-flight dispatches before injecting its fixture card so `teamRunning` is free for the test). Not currently exposed via the dashboard proxy — local-worker only.
- **Dashboard mode** (`DANXBOT_REPO_NAME` unset): one shared process. Runs migrations, dashboard HTTP server, SSE stream, analytics. No poller, no Slack, no claude spawning.

Dashboard mode never dispatches agents. Only worker mode spawns claude.

## Spawn Flow End-To-End

1. Trigger fires: HTTP `POST /api/launch`, Trello poller finds a card, or Slack listener routes a message.
2. Handler constructs a `DispatchInput` and calls `dispatch()` in `src/dispatch/core.ts`. The poller's input carries the hardcoded `POLLER_ALLOW_TOOLS` allowlist (built-ins + `mcp__trello__*`) plus an `onComplete` hook for card-progress bookkeeping. HTTP handlers shape the request body into the same `DispatchInput`. Both paths hit the same resolver, the same settings file, the same `spawnAgent`.
3. `dispatch()` resolves `{mcpServers, allowedTools}` via `resolveDispatchTools`, writes the per-dispatch MCP settings.json to a fresh temp dir, then calls `spawnAgent()` in `src/agent/launcher.ts`.
4. `spawnAgent` generates a `jobId`, writes the prompt to disk, prepends the dispatch tag, and forks:
   - Docker: `spawn("claude", args)` with `-p taggedPrompt`, stdout `"ignore"` (stderr `"pipe"` for failure summaries — not for monitoring).
   - Host: `buildDispatchScript()` writes `run-agent.sh` which writes claude's PID to a file, then exec's `script -q -f -c "claude <positional-file-ref>"`. `spawnInTerminal()` launches that script via `wt.exe`. Launcher polls the PID file briefly to obtain the tracked PID.
5. SessionLogWatcher starts polling `~/.claude/projects/` for a JSONL containing the dispatch tag. Attaches when found.
6. Observers wire to the watcher: summary capture, stall detection, Laravel forwarding (only when both `statusUrl` + `apiToken` are present), heartbeat.
7. Agent runs. Every assistant entry, tool call, tool result, and usage update lands in the JSONL and is emitted to subscribers.
8. Agent calls `danxbot_complete`. Stop handler kills the tracked process. Cleanup runs — the per-dispatch MCP settings dir is removed FIRST, then `input.onComplete?.(job)` fires (poller's card-progress check runs here). Final status PUT.

This is the design. Any code touching dispatch must preserve this shape.

### Poller path specifics

The poller shares `dispatch()` with `/api/launch` as of Phase 4. Implications:

- `src/poller/index.ts` never imports `spawnAgent` and never writes its own `settings.json`. If you find yourself adding either back, you are unwinding Phase 4.
- Poller-triggered agents get `mcp__danxbot__danxbot_complete` automatically (infrastructure), so the poller retired inactivity-timeout-as-completion-signal in favor of the MCP callback. Inactivity timeout remains as a safety net.
- The poller's `onComplete` callback is the hook for `handleAgentCompletion` — card-progress check, stuck-card recovery, consecutive-failure backoff. Ordering contract: MCP settings cleanup runs BEFORE the caller's onComplete so post-completion checks never observe a half-disposed dispatch.
- The hardcoded allowlist lives at `src/poller/constants.ts#POLLER_ALLOW_TOOLS`. Change it only when the `/danx-next` or `/danx-ideate` skill surface changes.

## Key Files

| File | Role |
|------|------|
| `src/agent/launcher.ts` | `spawnAgent()`, `cancelJob()`, `job.stop()`, heartbeat, inactivity timer, runtime fork |
| `src/agent/session-log-watcher.ts` | The one monitoring mechanism |
| `src/agent/stall-detector.ts` | Stall detection + nudge/kill/resume |
| `src/agent/terminal-output-watcher.ts` | ✻ indicator detection (stall input only) |
| `src/agent/laravel-forwarder.ts` | Batched event POSTs |
| `src/terminal.ts` | `buildDispatchScript()`, `spawnInTerminal()`, PID file emission |
| `src/mcp/danxbot-server.ts` | `danxbot_complete` MCP tool |
| `src/worker/dispatch.ts` | HTTP handlers for `/api/launch`, `/api/stop`, `/api/cancel`, `/api/status` |
| `src/worker/server.ts` | Routing layer for the above |

## When In Doubt

If you're about to change anything in `launcher.ts`, `terminal.ts`, `session-log-watcher.ts`, `stall-detector.ts`, or `danxbot-server.ts`, re-read this file first. The team has already paid for the design; don't drift from it.
