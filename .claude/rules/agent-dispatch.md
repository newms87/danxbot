# Agent Dispatch Architecture

How danxbot launches a Claude Code agent for a Trello card, Slack message, or HTTP dispatch. This file is the canonical reference. `CLAUDE.md` is the overview; this doc is the spec.

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

## Critical failure flag — poller halt contract

Environment-level blockers (MCP server failing to load, Bash unavailable,
Claude auth missing) cannot be rescued by a card-specific failure path.
The agent has no way to mark "this card isn't the problem — the box is."
Without a tripwire, the poller keeps picking the same card up, spawning
a broken session, observing failure, and re-dispatching. Production saw
40 such dispatches against a single card in ~6 hours, burning ~350M
cache tokens / ~$1K.

The **critical-failure flag** (`<repo>/.danxbot/CRITICAL_FAILURE`) is the
tripwire. Worker is the sole writer. Poller reads it on every tick and
refuses to run while present. Operator clears it.

### Write paths

- **Agent-signaled** (preferred when MCP works). The agent calls
  `danxbot_complete({status:"critical_failure", summary})` where
  `summary` describes the specific env issue. Worker's `handleStop`
  writes the flag with `source: "agent"` and finalizes the job as
  `"failed"` (`AgentJob.stop` only knows completed/failed; the halt
  signal lives in the flag file, not the job status). Summary is
  REQUIRED non-empty here — operators read the flag to decide what to
  fix.
- **Post-dispatch "card didn't move" check** (worker-signaled backup
  for total-tools-broken case). Poller tracks the dispatched cardId
  before `spawnAgent`. In the spawn's `onComplete` callback — for
  `trigger: "trello"` only — the worker fetches the card's current
  list. If it's still in `trello.todoListId`, the dispatch made zero
  progress; worker writes the flag with
  `source: "post-dispatch-check"`. Runs on BOTH success and failure
  paths: an agent reporting "completed" that didn't move the card is
  lying, still an env signal.

### Read path

- **Poller halt gate** sits at the top of every `poll()` tick, right
  after the `trelloPoller` feature toggle. `readFlag` non-null → log
  reason once per tick (the tick interval itself provides the
  once-per-tick throttle; no in-memory throttle needed) and return.
  Also clears `consecutiveFailures` + `backoffUntil` inside the halt
  branch so operator-clearing the flag resumes polling on the very
  next tick — no stale "In backoff" noise.

### Fail-closed on read

`readFlag` returns a **synthetic `unparseable` payload** when the file
exists but can't be parsed (corrupt JSON, invalid shape, non-object
top-level, missing required fields). NEVER `null` on a present-but-bad
file. A corrupt flag must keep the poller halted; silently re-enabling
on garbage input would reintroduce the bug the feature exists to
prevent.

### Worker observability

- `GET /health` adds a third status value — `halted` — that takes
  precedence over `degraded`/`ok`. The `criticalFailure` field carries
  the parsed payload (or null). HTTP **stays 200** in halted state so
  Docker health checks don't restart-loop the container; only
  `degraded` returns 503.
- `DELETE /api/poller/critical-failure` clears the flag. Idempotent:
  200 `{cleared:true}` if the file existed, 200 `{cleared:false}` if
  already absent. No in-worker auth — workers sit on `danxbot-net`
  only, and the dashboard auth gate in front of the proxy is the
  operator check.

### Dashboard surface

- `/api/agents[/:repo]` snapshots gain
  `criticalFailure: CriticalFailurePayload | null`, read via
  `readFlag` in `buildSnapshot`.
- `DELETE /api/agents/:repo/critical-failure` auth-gates on the
  per-user bearer (same contract as PATCH toggles — NOT the dispatch
  token) and forwards to the worker's DELETE endpoint. The
  `CriticalFailureBanner.vue` component renders inside each
  `RepoCard.vue` when `agent.criticalFailure !== null`.

### Clearing the flag — two paths

- **Dashboard button** (`Clear flag` in the per-repo banner) — the
  operator UI. After DELETE success the composable re-fetches the
  repo's snapshot and the banner unmounts because `criticalFailure`
  flips to null.
- **`rm <repo>/.danxbot/CRITICAL_FAILURE`** on the worker container /
  repo bind mount. The poller resumes on its next tick automatically —
  no worker restart required. Same idempotent semantics.

### Deliberate non-features

- **No auto-mitigation on trip.** The worker does NOT auto-label the
  stuck card "Needs Help" or post a Trello comment when the flag is
  written. The operator decides what to do with the card after reading
  the flag.
- **No automatic retry counter.** The post-dispatch check catches a
  zero-progress dispatch on the first run — no "3 strikes" logic.
- **No effect on Slack or /api/launch.** Halt is poller-only by design.
  Slack's router (Haiku, not the local claude CLI) can still respond.
  `/api/launch` keeps accepting work so an operator can test-dispatch a
  diagnostic agent against the same env if they want.

### Invariants to preserve when editing

1. Worker is the sole writer. Dashboard NEVER writes the flag — it
   only reads via snapshot and deletes via the worker's DELETE proxy.
2. Halt gate runs BEFORE backoff check in `poll()`. Halt resets
   backoff state; backoff should never suppress halt.
3. Post-dispatch check must compare against `ctx.trello.todoListId`
   specifically. A card moved to In Progress / Needs Help / Done /
   Cancelled / Review is NOT a halt signal — only "still in ToDo" is.
4. `fetchCard` must throw on missing `idList`. A malformed API
   response that returns `undefined` for `idList` would silently
   suppress the halt (`undefined !== todoListId` evaluates truthy).
5. `readFlag` never returns `null` on a present-but-bad file. Fail
   closed.

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

- **Worker mode** (`DANXBOT_REPO_NAME` set): one process per repo. Starts dispatch API (`/api/launch`, `/api/cancel`, `/api/stop`, `/api/status`), Slack listener (if configured), and poller (only if `DANX_TRELLO_ENABLED=true` in the repo's `.danxbot/.env`). Worker port is sourced from the repo's `.claude/settings.local.json` `env.DANXBOT_WORKER_PORT`. Spawned via `make launch-worker REPO=<name>` (docker) or `make launch-worker-host REPO=<name>` (host).
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
