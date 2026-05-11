# Agent Dispatch Architecture

How danxbot launches a Claude Code agent for a Trello card, Slack message, or HTTP dispatch. This file is the canonical reference. `CLAUDE.md` is the overview; this doc is the spec.

## Workspace isolation — the cwd contract

Every dispatched agent (poller, HTTP `/api/launch`, `/api/resume`, Slack) runs with `cwd = <repo>/.danxbot/workspaces/<name>/`. Each plural workspace is a fully self-contained directory containing:

- `.mcp.json` — per-workspace MCP config; combined with `--strict-mcp-config` ensures claude only sees the resolved workspace's MCP servers (merged with the danxbot infrastructure server by `dispatch()` at spawn time)
- `CLAUDE.md` — workspace-scoped marker doc
- `workspace.yml` — workspace manifest (resolved by `src/workspace/resolve.ts`)
- `.claude/settings.json` — workspace-specific settings
- `.claude/skills/` + `.claude/rules/` — static skills and rules shipped from `src/poller/inject/workspaces/<name>/.claude/` (mirrored verbatim every tick by `injectDanxWorkspaces`)
- `.claude/rules/danx-repo-config.md`, `danx-repo-overview.md`, `danx-repo-workflow.md`, `danx-tools.md` — per-repo rendered files written into every plural workspace by `renderPerRepoFilesIntoWorkspaces` in `src/poller/index.ts`. Rendered fresh from `RepoContext` every tick; duplicated across every workspace dir so cwd-relative skill references like `Read .claude/rules/danx-repo-config.md` resolve LOCALLY without claude walking ancestor `.claude/` dirs. (`danx-trello-config.md` was retired in Phase 5 once skills moved to a YAML-first / `danx_issue_create` MCP flow — workspace skills no longer reference Trello list IDs directly.)
- `.claude/tools/` — repo-specific helper scripts copied from `<repo>/.danxbot/config/tools/`

The **repo-root `.claude/`** is strictly developer territory. Danxbot never reads there and actively scrubs any `danx-*` artifacts that land in `<repo>/.claude/{rules,skills,tools}/` on every poll tick (`scrubRepoRootDanxArtifacts`). The legacy singular `<repo>/.danxbot/workspace/` directory the retired `generateWorkspace` helper produced is also scrubbed every tick (`scrubLegacySingularWorkspace`). A test in `src/poller/index.test.ts` asserts zero writes outside `<repo>/.danxbot/workspaces/` — reintroducing any repo-root or singular-workspace write breaks the isolation boundary and fails CI.

`DANXBOT_WORKER_PORT` lives in `<repo>/.danxbot/.env` (local dev) or `process.env` (production compose injection). `src/repo-context.ts#readWorkerPort` enforces this chain; it no longer reads `<repo>/.claude/settings.local.json`.

See the agent-isolation epic (Trello `7ha2CSpc`) for the full 5-phase design.

## External Entry — Dashboard → Worker Proxy

Workers bind only on `danxbot-net` and are not reachable from the public internet. Caddy reverse-proxies `localhost:<dashboard_port>` on port 443, so every external request hits the dashboard first. To give external dispatchers (e.g. the Laravel GPT-Manager app) a way to launch agents, the dashboard exposes an auth-gated proxy that forwards to the matching worker container.

| Route | Method | Notes |
|-------|--------|-------|
| `/api/launch` | POST | Body `{repo, workspace, task, api_token, overlay?, ...}` — forwarded verbatim to `http://danxbot-worker-<repo>:<workerPort>/api/launch`. Legacy fields (`allow_tools`/`agents`/`schema_*`) 400 with `Legacy dispatch body shape rejected` since P5 (commit `9baf431`) |
| `/api/resume` | POST | Body `{repo, job_id, task, api_token, ...}` — resumes the Claude session from a prior dispatch. See "Resume" below |
| `/api/status/:jobId?repo=<name>` | GET | Forwards to the named worker's status endpoint |
| `/api/cancel/:jobId?repo=<name>` | POST | Forwards to the named worker's cancel endpoint |
| `/api/stop/:jobId?repo=<name>` | POST | Forwards to the named worker's stop endpoint (external stop, not the MCP callback — the in-agent `danxbot_complete` tool still targets `localhost:<workerPort>` inside the worker) |

Every external proxy call requires `Authorization: Bearer $DANXBOT_DISPATCH_TOKEN`. The token is generated per-target at deploy time by `deploy/secrets.ts::getOrCreateDispatchToken`, persisted under `/<ssm_prefix>/shared/DANXBOT_DISPATCH_TOKEN`, and materialized into the dashboard container's `/danxbot/.env`. `checkAuth` in `src/dashboard/dispatch-proxy.ts` is timing-safe and returns `401` for bad/missing tokens, `500` when the dashboard itself has no token configured.

Worker hostname resolution: `workerHost(name)` returns `danxbot-worker-<name>` — the `container_name` set in each repo's compose file. Both the dashboard and workers live on the `danxbot-net` bridge so the hostname resolves via Docker DNS. The dashboard reads `workerPort` from the active deploy target's per-repo `worker_port:` field in `deploy/targets/<DANXBOT_TARGET>.yml` via `src/target.ts#loadTarget` (Phase B retired the legacy `REPO_WORKER_PORTS` env var).

### Playwright proxy — binary-safe

`/api/playwright/<tail>` forwards every method to the Playwright container at `${DANXBOT_PLAYWRIGHT_URL}<tail>`. Same bearer auth. Implemented in `src/dashboard/playwright-proxy.ts`. **Do NOT reuse `proxyToWorker`** — corrupts PNG bytes. Full contract (binary-safety, error mapping, timeout) → invoke `danxbot:dispatch-deep` skill before editing.

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

## Resume — `POST /api/resume`

Spawns a fresh dispatch that inherits a prior job's Claude session via `claude --resume <sessionId>`. New dispatchId + new dispatch tag (watcher disambiguation in shared JSONL). Caller passes parent `job_id`, NOT the Claude session UUID — worker resolves via the dispatch tag stored in the parent's JSONL. Errors: 400 (missing fields), 404 (parent session file not found), 503 (dispatch API disabled).

Full worker flow + invariants + "do not" list → invoke `danxbot:dispatch-deep` skill before editing `/api/resume` route or `resolveParentSessionId`.

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

### Fallback chain (DX-242)

`danxbot_complete` is resilient to a worker outage between spawn and signal. When the POST to `DANXBOT_STOP_URL` fails (worker crashed, OOM-killed, host reboot), the MCP server falls through:

1. **HTTP** — POST to `DANXBOT_STOP_URL`. Always tried first; fast path when the worker is alive.
2. **Direct DB UPDATE** — when `DANXBOT_DB_*` + `DANXBOT_DISPATCH_ID` env vars are set, the MCP server opens a one-shot `pg.Pool` and `UPDATE`s the `dispatches` row to terminal status, summary, `completed_at`, `pid_terminated_at`. Idempotent (`WHERE "status" NOT IN (TERMINAL_STATUSES)`).
3. **Filesystem queue** — when `DANX_REPO_ROOT` env is set, the MCP server atomically writes `<repoRoot>/.danxbot/dispatch-stops/<dispatchId>.json` (tempfile + rename) carrying the agent-facing `CompleteStatus` (NOT collapsed) so the boot replay can route `critical_failure` correctly.

The chain succeeds if ANY path lands; the agent sees a single success message naming which path fired ("recorded via DB fallback" / "queued for boot replay"). When EVERY path fails (no fallback context configured AND HTTP unreachable), the MCP server fails loud with the original primary error embedded.

The fallback context is auto-injected by `dispatch()` from `repo.localPath` (queue dir), `dispatchId` (queue key), and `config.db` (the same `DANXBOT_DB_*` block the worker reads). `mcp/danxbot-server.ts#mapCompleteToTerminalStatus` is the SINGLE source of truth for the `CompleteStatus → DispatchStatus` collapse — `worker/dispatch.ts#handleStopFromDb`, `worker/replay-stop-queue.ts`, and the MCP server's DB-fallback branch all import it.

Boot replay (`src/worker/replay-stop-queue.ts`, wired into `startWorkerMode` BEFORE `reconcileOrphanedDispatches`):
- Scans `<repo>/.danxbot/dispatch-stops/`.
- For each entry: `getDispatchById` → skip-if-terminal → `autoSyncTrackedIssue` → `updateDispatch` → `unlinkSync`.
- `critical_failure` branch: `writeFlag(<repo>/.danxbot/CRITICAL_FAILURE)` + row failed (auto-sync skipped).
- Per-entry failures recorded as `stop-replay`-source system errors; the file STAYS on disk for the next boot to retry. Malformed JSON / shape errors discard the file (a permanently-broken file would otherwise loop every boot).

### Worker-side flow

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

### Per-dispatch callback URLs (auto-injected by `dispatch()`)

`dispatch()` in `src/dispatch/core.ts` auto-injects every dispatchId-derived URL into the per-dispatch overlay so callers don't pre-compute them. Five URLs total today, all of shape `http://localhost:<worker_port>/api/<route>/<dispatchId>`:

- `DANXBOT_STOP_URL` → `/api/stop/<id>` (`danxbot_complete` callback)
- `DANXBOT_SLACK_REPLY_URL` → `/api/slack/reply/<id>` (Slack-only, `danxbot_slack_reply`)
- `DANXBOT_SLACK_UPDATE_URL` → `/api/slack/update/<id>` (Slack-only, `danxbot_slack_post_update`)
- `DANXBOT_ISSUE_CREATE_URL` → `/api/issue-create/<id>` (`danx_issue_create`)
- `DANXBOT_RESTART_WORKER_URL` → `/api/restart/<id>` (`danxbot_restart_worker`)
- `DANXBOT_DISPATCH_ID` + `DANX_REPO_ROOT` + `DANXBOT_DB_*` (DX-242 fallback context, no URL — see "Fallback chain" above)

DX-157 retired the parallel agent-facing save URL — agents `Edit` / `Write` the YAML at `<repo>/.danxbot/issues/{open,closed}/<id>.yml` directly, the chokidar watcher in the worker (`src/db/issues-mirror.ts`) mirrors every change to Postgres on the file event, and the post-completion auto-sync (`src/worker/auto-sync.ts`) handles the immediate tracker push when `danxbot_complete` fires. The poller's per-tick mirror is the eventual consistency safety net for tracker pushes that miss the auto-sync window.

`buildActiveTools` in `src/mcp/danxbot-server.ts` is the SOLE filter that hides each MCP tool when its URL is absent from `DanxbotToolUrls`. The danxbot MCP server also fail-loud-throws inside `callTool` when the URL is missing — defense in depth so a regression in the advertise filter can't silently misroute a tool call. Adding a new tool that follows this pattern: extend `DanxbotToolUrls`, extend `McpFactoryOptions` (`src/agent/mcp-types.ts`), inject in `mcp-registry.ts`, auto-inject in `dispatch/core.ts` overlay, register the tool def + dispatcher case + advertise-filter case in `danxbot-server.ts`, register the worker-side route in `src/worker/server.ts`, write the handler.

Agents always have `danxbot_complete` available — even when the dispatch did not pass MCP config for any other reason. The launcher always injects it.

## Pre-dispatch file staging — `staged_files`

`/api/launch` accepts optional `staged_files: [{path, content}]`. Written to disk BEFORE `spawnAgent` so the agent sees a populated workspace on first turn. Replaces the older "agent fetches its state via MCP" pattern. Workspace's `workspace.yml` declares `staging-paths:` allowlist (with `${KEY}` placeholder substitution from the dispatch overlay); workspace without `staging-paths` rejects non-empty `staged_files` with 400. Cleanup on terminal state removes ONLY the paths this dispatch wrote.

Full validation pipeline (placeholder substitution, allowlist check, path-traversal defenses, atomic rollback), error mapping, cleanup contract, and "why inline-in-launch" rationale → invoke `danxbot:dispatch-deep` skill before editing `src/dispatch/staged-files.ts` or any caller.

## Usage accumulation MUST dedupe by `message.id`

Multi-block assistant turns write ONE JSONL entry per content block but stamp the IDENTICAL `message.usage` on every entry — all sharing the same `message.id`. Any consumer that sums `usage` across JSONL entries MUST dedupe by `messageId` or it counts 2-5× the real cost. Bit production once (commit `d11b63d`). Existing dedupers: `src/agent/launcher.ts` `job.usage` accumulator (`seenUsageMessageIds`), `src/dashboard/jsonl-reader.ts` `parseJsonlContent`. New usage consumers (LaravelForwarder, metrics emitter) MUST follow.

Full empirical evidence + producer list + defensive missing-messageId handling → invoke `danxbot:dispatch-deep` skill.

## JSONL File Layout — Parents and Sub-Agents

Empirically verified against real Claude Code captures:

- Parent session: `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`
- Sub-agent sessions: `~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/agent-<hash>.jsonl` alongside a sidecar `agent-<hash>.meta.json` with `{agentType, description}`.

The **parent→child linkage is by `description` text** — the parent's `tool_use.input.description` matches the sub-agent meta's `description`. It is NOT by UUID or by the sub-agent's `agentId`. Keep that in mind when writing anything that walks sub-agents (e.g. `src/dashboard/jsonl-reader.ts`).

The tool name for sub-agent invocations is **`Agent`**, not `Task`, in current Claude Code. Readers should accept both to handle older captures.

Sub-agent JSONL entries carry `isSidechain: true` and an `agentId` field that matches the filename hash. They do NOT reference the parent by session UUID — the filesystem layout is the only structural link.

## Stall Recovery

When `StallDetector` determines an agent is stuck (no watcher activity + no ✻ indicator for threshold), it nudges up to `DEFAULT_MAX_NUDGES` times. If still stuck, it kills + resumes with a nudge prompt. After max exhausted, job marked failed. Stall recovery works identically in both runtime modes (reads watcher, not process).

**Silent dispatch failures (timeout with no JSONL ever appearing) are usually broken claude-auth, NOT a stalled agent.** Three known auth misconfigurations all surface as `Agent timed out after N seconds of inactivity` with no watcher attach: read-only `.claude.json` / `.claude/` bind, expired OAuth token, mismatched UID on bind source. Diagnostic recipe + full root-cause table → invoke `danxbot:dispatch-deep` skill BEFORE chasing StallDetector logic on a "silent failure" report.

## Claude API stream-idle auto-recover (DX-246)

Distinct from Stall Recovery. Stall recovery handles "agent stopped writing JSONL" (could be claude thinking too long, sub-agent stuck, etc.). API stream-idle recover handles a specific failure mode: the Anthropic stream times out mid-turn and Claude Code writes a **synthetic JSONL pair** signaling the model lost its connection. The agent itself is still alive but produced no real turn — the only way forward is to kill the session and POST `/api/resume` so claude reconnects via `claude --resume <sessionUuid>`.

### Synthetic JSONL signature

Claude Code writes BOTH a synthetic assistant entry AND a `turn_duration` system entry when the API stream times out (observed 2026-05-10 — DX-235). The detector matches on the assistant entry via either of two surface forms (defense-in-depth — Claude Code has emitted both in the wild):

```jsonc
// Surface form 1 — explicit flag
{
  "type": "assistant",
  "message": {
    "model": "<synthetic>",
    "stop_reason": "stop_sequence",
    "content": [{"type": "text",
                 "text": "API Error: Stream idle timeout - partial response received"}]
  },
  "isApiErrorMessage": true,
  "error": "unknown"
}

// Surface form 2 — content-pattern match
{
  "type": "assistant",
  "message": {
    "model": "<synthetic>",
    "content": [{"type": "text", "text": "API error: <anything>"}]
  }
}

// Both surfaces are usually followed by:
{"type": "system", "subtype": "turn_duration", "durationMs": 1457211}
```

Detection logic — `src/agent/api-error-detector.ts#matchesSynthetic`:

1. `raw.isApiErrorMessage === true`, OR
2. `raw.message.model === "<synthetic>"` AND content text matches `/API Error/i`.

### Detector behavior

`ApiErrorDetector` subscribes to the same `SessionLogWatcher` every other observer reads (one fork, one watcher — see "Single Fork Principle"). On match it:

- **Arms a 5s confirmation timer** instead of firing immediately. If a real assistant entry (`model !== "<synthetic>"`) arrives during the window, the API recovered on its own — pending recover is cancelled. This catches transient API stutter that resolves without operator intervention.
- **Idempotency by recover epoch.** The detector remembers the `recoverCount` value at which it fired. Further synthetic entries in the same epoch are no-ops. When the recover handler bumps `recoverCount`, the next synthetic re-arms for the new epoch.
- **Sub-agent (sidechain) entries are skipped.** A sub-agent's API error stays scoped to the sub-agent; never triggers a recover on the parent dispatch.

### Recover contract

`attach-monitoring-stack.ts#handleApiErrorRecover` runs after the 5s window confirms. Sequence:

1. **Skip if non-running.** Detector might fire after stall / cancel / inactivity already terminated the job.
2. **Increment counter** — `job.recoverCount + 1`, persisted to the dispatch row via `tracker.recordRecoverCount`.
3. **Branch on cap:**
   - **count > `MAX_RECOVERS` (= 3):** write `<repo>/.danxbot/CRITICAL_FAILURE` via `writeFlag`, call `job.stop("api_error_failed", ...)`. Poller halts on next tick. Operator clears the flag to resume polling.
   - **count ≤ `MAX_RECOVERS`:** call `job.stop("api_error_recover", ...)` which collapses the dispatch row to `status: "recovered"`, then `POST /api/resume` so a fresh dispatch picks up `--resume <sessionUuid>` with `parent_recover_id` pointing back at this row.

`/api/resume` failures (network, HTTP non-2xx) are logged but do NOT escalate to `CRITICAL_FAILURE` — a transient resume error is recoverable on the next poller tick; persisting a halt for it would defeat the feature.

The dispatch row's status enum carries `"recovered"` as a terminal state (separate from `"failed"`). The chain is queryable via `parent_recover_id` — the dashboard's Recovers column surfaces `recover_count` on each row + a chain indicator next to the dispatch ID when `parent_recover_id` is non-null.

### Integration points (re-read before editing)

- `src/agent/api-error-detector.ts` — pure detector, no recover logic.
- `src/agent/attach-monitoring-stack.ts` — wires `ApiErrorDetector` onto the shared watcher; carries `handleApiErrorRecover` + `MAX_RECOVERS` constant.
- `src/agent/agent-types.ts#SpawnAgentOptions.recoverContext` — `{originalTask, workspace, workerPort, repoLocalPath}` — required for the recover-ok branch to fire `/api/resume`; missing context fails-loud to `api_error_failed` so the dispatch row doesn't leak in `recovered` state with no resume-child.
- `src/dispatch/core.ts` — auto-injects `recoverContext` from `RepoContext.localPath` + `workerPort` so callers don't have to remember.
- `src/worker/dispatch.ts#handleResume` — threads `recover_count` + `parent_recover_id` from the POST body onto the new dispatch row.
- `src/dashboard/dispatches.ts` — surfaces `recoverCount` + `parentRecoverId` on the `Dispatch` row type; `dispatches-routes.ts` validates `?status=recovered` in the list filter.
- `dashboard/src/components/DispatchList.vue` — Recovers column badge + parent linkage indicator (↳ glyph) next to the dispatch ID.
- `src/__tests__/integration/api-error-recover.test.ts` — end-to-end pin: synthetic JSONL → detector → recover handler → `/api/resume` POST + chain stamping + cap-exhausted CRITICAL_FAILURE.

### Tuning

`MAX_RECOVERS = 3` is hardcoded in `attach-monitoring-stack.ts`. Changing it requires updating the unit + integration tests that pin `MAX_RECOVERS` to 3. Don't change without a strong operational reason — 3 attempts × ~5s window each is enough to ride out the API stutter the feature was built for; more attempts would let a sustained outage burn tokens before falling through to operator intervention.

## Host mode MUST be interactive — `claude -p` is FORBIDDEN there

Host runtime exists SOLELY to launch an interactive Claude Code TUI the user can read + type into. `claude -p` is the non-interactive print/headless mode → exits after one turn → defeats the entire purpose of host mode. If both modes use `-p`, host mode has no reason to exist.

Docker runtime is the headless path; `-p` acceptable there (no TTY, no user). Host runtime: interactive TUI required.

**Mechanism — how the prompt gets in without `-p`:**

`src/agent/claude-invocation.ts#buildClaudeInvocation` produces `firstMessage = <!-- danxbot-dispatch:<jobId> --> @<abs-path-to-prompt.md>[ Tracking: <title>]`. Docker headless: appends `-p "<firstMessage>"` to argv. Host interactive: passes `firstMessage` as a **positional argument** (preceded by `--`) inside `src/terminal.ts#buildDispatchScript`, which `script -q -f` wraps for log capture. The `@<path>` is claude's native file-attachment syntax → small files inline, large files fall back to a Read-tool call (allowed because `--dangerously-skip-permissions` is set). NEVER reintroduce a meta-instruction (`Read <path> and execute…`); Phase 6 of the workspace-dispatch epic retired that.

**Code locations (re-read before editing):**
- `src/terminal.ts` — `buildDispatchScript()` (primary enforcement site)
- `src/agent/launcher.ts` — routes headless vs interactive on `openTerminal`
- `src/agent/claude-invocation.ts` — shared invocation builder
- `config.isHost` — `true` → interactive required

**Mechanical check before every edit to `src/terminal.ts` or any bash script that launches claude in a Windows Terminal tab:**
1. Does the script invoke `claude -p`? → **violation, stop**
2. Does claude exit immediately after one turn? → **violation, stop**
3. Does the user get a live TUI they can type into? → **required**

If you cannot answer yes to #3 the change is wrong.

## Forbidden Patterns

These are regressions the team has already fixed. Do not reintroduce any of them.

| Forbidden | Why |
|-----------|-----|
| `claude -p` in host mode | See "Host mode MUST be interactive" section above. |
| `--output-format stream-json` anywhere | Vestigial. Replaced by SessionLogWatcher. Stdout-based monitoring is slower and adds a second parser. |
| Two claude processes per dispatch | Creates two sessions, two JSONL files, orphaned TUI, misreported usage. The `openTerminal` branch must REPLACE the headless spawn, not supplement it. |
| Parsing stdout for semantic content | Watcher already emits every tool call, text block, and usage field. Stdout parsing is redundant. |
| Parsing the terminal log for anything other than the ✻ indicator | The log is for stall detection only. JSONL is for semantic events. |
| Custom log files written alongside the JSONL | `writeJobLogs` was deleted in Phase 2. Claude Code writes JSONL natively — do not write parallel logs for monitoring. `logs/<jobId>/` for debug artifacts (prompt.md, agents.json) is OK. |
| Legacy single-process mode | Removed. Only worker and dashboard modes exist. |
| Bypassing `isFeatureEnabled` in `handleLaunch` | `/api/launch` must 503 when `dispatchApi` is disabled in `.danxbot/settings.json` — the very first line inside the handler's try block. Skipping the check lets disabled repos still dispatch, which the Agents tab advertises as impossible. See `.claude/rules/settings-file.md`. |
| Calling `mcp__trello__*` from a dev session to inspect card state | Local YAML at `<repo>/.danxbot/issues/{open,closed}/*.yml` is the single source of truth. Trello is a one-way mirror. Read the YAML directly (Glob/Read) — never round-trip through Trello MCP for status, comments, ACs, or list membership. The MCP path is for the danxbot worker to write outbound mirror updates, not for human-driven inspection. |
| Putting Trello in the agent's critical path — synchronous `tracker.createCard` inside `danx_issue_create`, synchronous tracker writes inside any agent-facing YAML mutation, surfacing Trello errors in agent output, requiring Trello creds in the dispatched-agent env | Trello is **background infrastructure**, not part of the agent flow. `danx_issue_create` writes YAML and returns immediately; agent-driven YAML edits go through `Edit` / `Write` (DX-157) and the chokidar watcher mirrors them to the DB. The worker's poll loop mirrors YAML → Trello asynchronously (`orphan-push.ts` + `.trello-retry/` queue), with the post-completion auto-sync providing the immediate-push fast path. Trello errors surface ONLY in the dashboard. DX-203 retired the MCP server's tracker concept entirely (`@thehammer/danx-issue-mcp` reads only `DANX_REPO_ROOT`); the boundary is enforced structurally — there is no tracker code path in the MCP server to revert to. See CLAUDE.md "Trello Is Background Infrastructure — Never In The Agent's Critical Path" for the full rule. |
| Reintroducing an agent-facing save MCP tool / HTTP route to mutate a YAML through a worker round-trip | DX-157 retired this path. Agents edit the YAML in place via `Edit` / `Write`; the chokidar watcher mirrors to Postgres on the file event and the per-tick / auto-sync pipeline pushes to the tracker. Reintroducing a save tool would put the worker back in the synchronous write path, double-mirror to the DB, and bring back the failure mode where a runtime `recordError` from a tracker hiccup leaks into the agent's response. |
| Reintroducing an `allowed-tools.txt` / `--allowed-tools` flag / per-tool allowlist | The allow-tools concept was retired entirely (see `src/workspace/resolve.ts` header). claude's `--allowed-tools` is bypassed by `--dangerously-skip-permissions` (which every dispatched agent runs with), so the flag was never an enforceable gate for MCP tools. The workspace's `.mcp.json` (with `--strict-mcp-config`) is the agent's MCP surface; built-ins are all available by default. A stale `allowed-tools.txt` in any workspace dir throws `WorkspaceLegacyFileError` at resolve time. |

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

- **Worker mode** (`DANXBOT_REPO_NAME` set): one process per repo. Starts dispatch API (`/api/launch`, `/api/cancel`, `/api/stop`, `/api/status`, `/api/jobs`), Slack listener (if configured), and poller (only if `DANX_TRELLO_ENABLED=true` in the repo's `.danxbot/.env`). Worker port is sourced from `DANXBOT_WORKER_PORT` in `<repo>/.danxbot/.env` (local dev) or `process.env.DANXBOT_WORKER_PORT` injected by compose from `deploy/targets/<target>.yml` (production). Spawned via `make launch-worker REPO=<name>` (docker) or `make launch-worker-host REPO=<name>` (host).

  **`GET /api/jobs`** returns `{jobs: getJobStatus[]}` — every job currently in `activeJobs`, both running and recently-finished within the TTL grace window. Primary consumer is the system-test isolation helper in `src/__tests__/system/run-system-tests.sh` (cancels in-flight dispatches before injecting its fixture card so `teamRunning` is free for the test). Not currently exposed via the dashboard proxy — local-worker only.
- **Dashboard mode** (`DANXBOT_REPO_NAME` unset): one shared process. Runs migrations, dashboard HTTP server, SSE stream, analytics. No poller, no Slack, no claude spawning.

Dashboard mode never dispatches agents. Only worker mode spawns claude.

## Spawn Flow End-To-End

1. Trigger fires: HTTP `POST /api/launch`, the per-repo poller picks up a local YAML in `<repo>/.danxbot/issues/open/` (status: ToDo, blocked: null, list_kind != "action_items"), or Slack listener routes a message. The poller does NOT read the Trello tracker to decide what to dispatch — Trello is a one-way mirror of YAML state plus a narrow inbound channel for new cards + human comments. See `~/.claude/rules/issues.md` "Source of Truth" for the full sync contract.
2. Handler constructs a `DispatchInput` and calls `dispatch()` in `src/dispatch/core.ts`. The poller adds an `onComplete` hook for card-progress bookkeeping; HTTP handlers shape the request body into the same `DispatchInput`. Both paths hit the same resolver, the same settings file, the same `spawnAgent`. There is no per-dispatch tool allowlist at any layer — the workspace's `.mcp.json` (with `--strict-mcp-config`) IS the agent's MCP surface; built-ins are all available by default.
3. `dispatch()` calls `resolveWorkspace()` (`src/workspace/resolve.ts`) for the named workspace, merges the danxbot infrastructure MCP server into the workspace's `mcpServers`, writes the per-dispatch MCP settings.json to a fresh temp dir, then calls `spawnAgent()` in `src/agent/launcher.ts`.
4. `spawnAgent` generates a `jobId`, calls `buildClaudeInvocation()` (`src/agent/claude-invocation.ts`) which writes the full prompt body verbatim to `prompt.md` in a fresh temp dir and builds a `firstMessage` of the form `<!-- danxbot-dispatch:<jobId> --> @<abs-path-to-prompt.md>[ Tracking: <title>]`. The `@<path>` is Claude Code's native file-attachment syntax (small files inline into the first user turn; large files fall back to a Read-tool call because `--dangerously-skip-permissions` is set). No meta-instruction, no `Read <path> and execute…` — Phase 6 of the workspace-dispatch epic (Trello WWYKnQhc) retired that. Then forks:
   - Docker: `spawn("claude", args)` with `-p firstMessage`, stdout `"ignore"` (stderr `"pipe"` for failure summaries — not for monitoring).
   - Host: `buildDispatchScript()` writes `run-agent.sh` which writes claude's PID to a file, then exec's `script -q -f -c "claude <flags> -- <firstMessage>"`. `spawnInTerminal()` launches that script via `wt.exe`. Launcher polls the PID file briefly to obtain the tracked PID.
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
- The poller's MCP surface lives in `src/poller/inject/workspaces/issue-worker/.mcp.json`. Adding or removing a Trello tool is a one-line edit to that file — no callsite changes anywhere.
- Empty-ToDo branch ordering: `_poll` calls `checkAndSpawnTriage` BEFORE `checkAndSpawnIdeator`. When `autoTriage` is enabled AND any Review / Needs Help / Blocked card has `triage.expires_at <= now` (or empty), the poller dispatches `/danx-triage-card <PREFIX>-N` via `TRIAGE_CARD_PROMPT` for ONE eligible card and returns — single-dispatch invariant. Triage spawn preempts the ideator on the same tick; ideator only runs when triage finds nothing eligible (or `autoTriage` is off). The full per-status decision tree (Review 24h / Needs Help 3h / Blocked 1h cadence + ICE-sorted dispatch) lives in the `Trello Poller` section of `claude-plugins/danxbot/skills/danxbot/SKILL.md`.

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

