# Danxbot Feature Notes

Persistent memory for the Ideator agent. Scope: `danxbot` (Danxbot codebase only).

## Feature Inventory

### Core Architecture

| Feature | Status | Notes |
|---------|--------|-------|
| Multi-repo worker/dashboard split | Complete | Worker per repo (poller + Slack + dispatch API), shared dashboard container |
| Repo context loading (REPOS env + per-repo .danxbot/.env) | Complete | loadRepoContext() parses config.yml + trello.yml + .env secrets |
| Dashboard/worker mode detection | Complete | DANXBOT_REPO_NAME determines mode; legacy host mode for backwards compat |
| Startup entrypoint (src/index.ts) | Complete | Branches cleanly into startDashboardMode / startWorkerMode / startLegacyMode |
| Config validation on startup | Complete | validateConfig() checks all numeric bounds; validateRepoConfig() checks files + env vars |
| POLLER_ENABLED flag | Complete | config.pollerEnabled; start() returns early with log message when false |

### Agent Pipeline

| Feature | Status | Notes |
|---------|--------|-------|
| Router (Haiku triage, ~300ms) | Complete | Direct Anthropic API, JSON response, complexity scoring, error recovery |
| Complexity profiles (5 tiers) | Complete | very_low/low/medium/high/very_high → model + maxTurns + budget + system prompt |
| Claude Code SDK agent | Complete | query() with stream support, session resume, per-complexity profiles |
| Heartbeat manager | Complete | Live Slack status updates via Haiku during agent run; multi-turn narrative |
| Agent retry logic | Complete | Configurable retries (AGENT_MAX_RETRIES), session clearing on stale session errors |
| Agent timeout race | Complete | Wall-clock timeout via Promise.race, graceful placeholder update on timeout |
| Agent log writing | Complete | Per-session JSON log to logsDir; always written even on crash |
| SQL executor | Complete | sql:execute blocks extracted, validated (SELECT-only), executed, formatted as table + CSV upload |
| Stream text callbacks | Complete | Partial text deltas forwarded to heartbeat for live preview |
| Feature list for router + agent | Complete | Shared FEATURE_LIST / FEATURE_EXAMPLES in features.ts |
| Headless agent spawning | Complete | spawnHeadlessAgent() for Docker poller mode; inactivity timer + completion callback |
| Dispatch agent launching (launchAgent) | Complete | Schema MCP server, heartbeat, status PUT, max runtime cap |
| Process utilities (process-utils.ts) | Complete | Extracted shared: buildCleanEnv, attachStreamParser, setupProcessHandlers, createInactivityTimer |
| Tool input summarizer | Complete | tool-summary.ts gives human-readable one-liner for each tool call type |
| Log parser | Complete | Converts raw AgentLogEntry[] to structured ParsedLogEntry[] for dashboard timeline |

| Feature | Status | Notes |
|---------|--------|-------|
| Agent log rotation | Incomplete | No cleanup of ./logs/ directory — files accumulate indefinitely. Carded: https://trello.com/c/670o7RTR |

### Slack Integration

| Feature | Status | Notes |
|---------|--------|-------|
| Per-repo Slack listener (Socket Mode) | Complete | Independent ListenerState per repo; one @slack/bolt App per repo |
| Message handling + thread tracking | Complete | getOrCreateThread, addMessageToThread, isBotParticipant guard for thread replies |
| Feedback reactions (thumbsup/thumbsdown) | Complete | reaction_added event handler, skin-tone modifier stripping, dashboard feedback tracking |
| Message queue (per-thread) | Complete | Sequential per-thread processing; queued messages drain after agent finishes |
| Placeholder messages + updates | Complete | "Researching…" → final response update; "Quick lookup…" for very_low path |
| Slack mrkdwn formatter | Complete | markdownToSlackMrkdwn converts MD → Slack format; splitMessage for long responses |
| CSV upload via filesUploadV2 | Complete | SQL query results uploaded as CSV attachments to Slack thread |
| Error reactions + error attachment posting | Complete | swapReaction, postErrorAttachment with colored attachment blocks |
| User cache (display name resolution) | Complete | resolveUserName with in-memory cache to avoid repeated auth.users.info calls |
| Graceful shutdown with in-flight cleanup | Complete | inFlightPlaceholders tracked, cleanup on SIGTERM |

| Feature | Status | Notes |
|---------|--------|-------|
| Per-user rate limiting | Incomplete | No throttle on message rate per user — a fast user can flood the queue. Carded: https://trello.com/c/ZArDwOLG |
| listener.ts very_low/full path duplication | Changeable | ~60-80 lines of identical response finalization logic in both paths (SQL, format, post, upload, react). Carded: https://trello.com/c/[69df29f886f7be49aaf74c63] |

### Poller

| Feature | Status | Notes |
|---------|--------|-------|
| Per-repo poller state | Complete | Map<string, RepoPollerState> with independent lock files (.poller-running-<name>) |
| ToDo card processing | Complete | fetchTodoCards → spawnClaude (team or ideator) |
| Needs Help re-triage | Complete | checkNeedsHelp checks latest comment; moves user-responded cards to ToDo top |
| Ideator auto-spawn | Complete | Spawns ideator when Review < REVIEW_MIN_CARDS and ToDo is empty |
| Lock file mechanism | Complete | File-based lock prevents concurrent team spawns; stale lock cleanup on startup |
| Repo file sync (syncRepoFiles) | Complete | Injects danx-* skills, rules, tools, docs into target repo on every poll cycle |
| Trello config rule generation | Complete | writeTrelloConfigRule() generates danx-trello-config.md from TrelloConfig |
| Repo config validation | Complete | validateRepoConfig() checks .danxbot/config/, required fields, claude-auth/ |
| Host mode (Windows Terminal tab) | Complete | spawnInTerminal opens wt.exe tab with run-team.sh / run-ideator.sh |
| Docker mode (headless agent) | Complete | spawnHeadlessAgent() with SCRIPT_PROMPTS mapping |
| Lock watch interval | Complete | setInterval(5000) polls for lock file removal to detect team completion |
| POLLER_ENABLED guard | Complete | start() checks config.pollerEnabled before polling; logs and returns when disabled |

### Trello Client + Error Notifier

| Feature | Status | Notes |
|---------|--------|-------|
| Trello REST client (poller) | Complete | fetchTodoCards, fetchNeedsHelpCards, fetchReviewCards, moveCardToList, fetchLatestComment |
| isUserResponse detection | Complete | Checks for DANXBOT_COMMENT_MARKER absence to detect human replies |
| Error auto-cards (trello-notifier.ts) | Incomplete | notifyError defaults to todoListId — error cards get picked up by agents. Should default to reviewListId. Carded: https://trello.com/c/TluqNyiI |

### Dashboard

| Feature | Status | Notes |
|---------|--------|-------|
| Event tracking + SSE broadcast | Complete | createEvent / updateEvent / broadcast to all SSE clients |
| DB persistence (events-db.ts) | Complete | Persist events to MySQL; load on startup; delete old events cleanup |
| Analytics summary | Complete | getAnalytics() with repo filter: totals, avg times, costs, feedback rates |
| CSV + JSON export | Complete | /api/events/export with format=csv/json |
| SSE stream endpoint | Complete | /api/stream with SSE protocol; client/close cleanup |
| Perf stats computation | Complete | computePerfStats() from agentLog: tool counts, API time, wall time |
| Full parsed log | Complete | buildFullParsedLog() merges router + heartbeat + agent log into timeline |
| Health endpoint | Complete | /health with DB + Slack connectivity checks |
| Vue 3 SPA (dashboard/) | Complete | Vite + Tailwind CSS 4; components: MessagesTable, DetailPanel, AnalyticsCards, etc. |
| Repo filter support | Complete | ?repo= on /api/events and /api/analytics; repo selector in frontend |

| Feature | Status | Notes |
|---------|--------|-------|
| SSE stream repo filtering | Incomplete | /api/stream broadcasts all events to all clients regardless of repo. Carded: https://trello.com/c/[69df24dc32dfa2044ef76c04] |
| Event pagination | Incomplete | /api/events returns all 500 events in one payload; no offset/limit support. Carded: https://trello.com/c/lFW8Hclr |

### Worker HTTP Server

| Feature | Status | Notes |
|---------|--------|-------|
| Worker HTTP server (server.ts) | Complete | POST /api/launch, GET /api/status/:id, POST /api/cancel/:id, GET /health |
| Schema MCP agent dispatch | Complete | launchAgent with MCP settings temp dir, heartbeat, status PUT, max runtime |
| Worker /health endpoint | Upgradeable | Reports Slack + DB connectivity but not poller state (enabled, teamRunning, lastPollAt). Carded: https://trello.com/c/[69df29baef8a77eb7ec58d54] |
| activeJobs map | Incomplete | No max size cap; cleanup interval is 60min — jobs accumulate for up to 1 hour. Carded: https://trello.com/c/McdkRqeX |

| Feature | Status | Notes |
|---------|--------|-------|
| Worker server unit tests | Incomplete | server.ts has zero test coverage despite being a critical entry point. Carded: https://trello.com/c/[69df24845335a140e70b701d] |

### Database

| Feature | Status | Notes |
|---------|--------|-------|
| Migration runner | Complete | runMigrations() auto-creates DB + migrations table; applies pending migrations; normalizes .ts/.js names |
| 8 migrations applied | Complete | events, threads, users, usage tracking, heartbeat snapshots, repo_name column |
| Thread DB (threads-db.ts) | Complete | Load/save/delete thread state; isBotInThread check |
| Events DB (events-db.ts) | Complete | Persist/update/load/delete events; UPSERT pattern |
| Users DB (users-db.ts) | Complete | Cache Slack user display names; upsert pattern |
| Connection pool | Complete | mysql2/promise pool with configurable connect timeout; platform pool for SQL executor |

### Infrastructure

| Feature | Status | Notes |
|---------|--------|-------|
| Logger (createLogger) | Complete | Prefixed logger with log level filtering |
| Shutdown handlers | Complete | initShutdownHandlers handles SIGTERM/SIGINT; cleans up Slack placeholders, intervals |
| Thread cleanup | Complete | Deletes threads older than 7 days; 1-hour interval |
| Event cleanup | Complete | Deletes events older than EVENTS_MAX_AGE_DAYS; 6-hour interval |
| Error pattern detection | Complete | isOperationalError() detects billing/credit/auth errors for different handling |
| env-file parser | Complete | parseEnvFile reads per-repo .danxbot/.env files for secrets |
| terminal.ts | Complete | spawnInTerminal (wt.exe) and buildDispatchScript for host mode |

### Known Bugs

| Feature | Status | Notes |
|---------|--------|-------|
| POLLER_ENABLED test regression | Incomplete | Two start() tests fail because mockConfig in poller/index.test.ts doesn't include pollerEnabled. Carded: https://trello.com/c/[69df29a292d99d588652a666] |

## Desired Features

| Type | ICE | Feature |
|------|-----|---------|
| Carded | 600 (6×10×10) | Fix POLLER_ENABLED test regression — add pollerEnabled: true to mockConfig (https://trello.com/c/69df29a292d99d588652a666) |
| Carded | 567 (7×9×9) | Route notifyError default to reviewListId (https://trello.com/c/TluqNyiI) |
| Carded | 336 (6×8×7) | Add agent log rotation + size cap (https://trello.com/c/670o7RTR) |
| Carded | 320 (5×8×8) | Expose poller state in worker /health endpoint (https://trello.com/c/69df29baef8a77eb7ec58d54) |
| Carded | 270 (3×9×10) | Add REVIEW_MIN_CARDS to validateConfig numeric rules (https://trello.com/c/69df29d7c7fdf7db077dbda9) |
| Carded | 245 (5×7×7) | Per-user Slack rate limiting (https://trello.com/c/ZArDwOLG) |
| Carded | 243 (3×9×9) | Cap activeJobs map size + reduce cleanup interval (https://trello.com/c/McdkRqeX) |
| Carded | 224 (4×8×7) | Dashboard /api/events pagination (https://trello.com/c/lFW8Hclr) |
| Carded | 160 (5×8×4) | Extract shared response finalization from listener.ts very_low/full paths (https://trello.com/c/69df29f886f7be49aaf74c63) |
| Maintenance | 196 (4×7×7) | notifyError duplicate check: also scan review + in-progress lists to avoid repeat cards for same error |
| Maintenance | 150 (5×6×5) | Worker port collision: validate/document per-worker DANXBOT_WORKER_PORT uniqueness requirement; default ports differ per repo |
| Maintenance | 144 (4×6×6) | Reduce launcher.ts (489 lines) — split dispatch-specific launchAgent from shared headless logic more cleanly |
| Exploratory | 90 (3×5×6) | Proactive codebase change summaries — daily digest of recent commits sent to Slack |
| Exploratory | 84 (2×7×6) | syncRepoFiles change detection — hash/mtime check to skip unchanged files on poll cycles |

## Session Log

**Date:** 2026-04-15 (session 2)
**Scope:** danxbot (src/ only)
**Summary:** Explored changes since last session. Only 2 files changed: src/config.ts and src/poller/index.ts (POLLER_ENABLED flag added). This introduced a regression: mockConfig in poller/index.test.ts doesn't include pollerEnabled, causing 2 start() tests to fail (pollerEnabled is undefined → falsy → start() returns early). All 7 previously-carded Review cards are still in Review and unchanged. Created 4 new cards: (1) bug fix for POLLER_ENABLED test regression (ICE 600), (2) expose poller state in /health endpoint (ICE 320), (3) REVIEW_MIN_CARDS validation in validateConfig (ICE 270), (4) listener.ts shared response finalization refactor (ICE 160, previously in scratchpad as Maintenance). Also identified notifyError duplicate check gap (ICE 196) and worker port collision issue (ICE 150) — both left in scratchpad as Maintenance.
