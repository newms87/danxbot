# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-03-15 (session 9)

---

## Feature Inventory

<!-- Status: Complete | Upgradeable | Incomplete | Removeable | Changeable -->
<!-- ICE format: Total (IxCxE) — e.g. 336 (8x7x6) -->

| Feature | Status | ICE | Notes |
|---------|--------|-----|-------|
| Slack Socket Mode listener | Complete | — | Receives messages, handles threads |
| Haiku router (triage) | Complete | — | Error fallback returns needsAgent:false |
| Claude Code SDK agent | Complete | — | Deep exploration via `query()` |
| Real-time streaming | Complete | — | Heartbeat updates during agent runs |
| Heartbeat manager | Complete | — | Throttled Slack updates, orchestrator-generated messages |
| Dashboard + SSE | Complete | — | Events table, analytics, search/filter, light/dark theme |
| Markdown-to-Slack formatter | Complete | — | Full markdown support including tables |
| Thread state persistence | Complete | — | DB-backed, 7-day cleanup |
| Session resumption | Complete | — | Resumes agent sessions for thread follow-ups |
| Message splitting | Complete | — | Splits long responses into multiple Slack messages |
| Agent log writing | Complete | — | Persists agent conversation logs to disk |
| Validation tests | Complete | — | Real Claude API tests with $2 budget |
| Domain docs (all 8) | Complete | — | Campaigns, billing, suppliers, ads, users, SSP, school data, buyers |
| User feedback via Slack reactions | Complete | — | Tracks thumbs up/down on bot responses |
| Dashboard event persistence | Complete | — | DB-backed via events table |
| System prompt | Complete | — | Domain routing instructions for agent |
| Test fixtures/helpers | Complete | — | Shared mocks and factories |
| Router + parse-json-response tests | Complete | — | Full test coverage |
| Dashboard server + helpers tests | Complete | — | Full test coverage |
| Per-user rate limiting | Complete | — | In-memory cooldown per user |
| Poller (Trello automation) | Complete | — | Polls ToDo list, spawns /start-team |
| Poller tests (all modules) | Complete | — | Full test coverage |
| Slack user display names | Complete | — | User cache resolves IDs to names |
| Dashboard search/filter | Complete | — | Text + status filter controls |
| Health check endpoint | Complete | — | Checks Slack + DB connectivity |
| Listener tests | Complete | — | Full test coverage |
| Graceful shutdown | Complete | — | Signal handlers, placeholder cleanup, pool close |
| Thread context window limit | Complete | — | Trims to MAX_THREAD_MESSAGES |
| Error notifications to ops | Complete | — | Posts error cards to Trello |
| Config validation on startup | Complete | — | Validates numeric config |
| Structured JSON logging | Complete | — | createLogger() with JSON output |
| Index.ts unit tests | Complete | — | Entrypoint startup tested |
| Agent retry on transient failure | Complete | — | maxRetries with escalation |
| Dashboard data export | Complete | — | CSV and JSON via /api/events/export |
| 5-level complexity routing | Complete | — | very_low through very_high profiles |
| Feature discovery (router) | Complete | — | Suggests features to uncertain users |
| DB persistence (events, threads, users) | Complete | — | 3-phase migration, full schema |
| Fast system prompt | Complete | — | Lightweight prompt for very_low/low |
| Router error fallback | Complete | — | Returns needsAgent:false on failure |
| Health check DB connectivity | Complete | — | Pings DB with 2s timeout |
| DB events TTL/cleanup | Complete | — | cleanupOldEvents() every 6h, configurable max age |
| DB connect timeout | Complete | — | connectTimeoutMs config |
| SQL execution in responses | Complete | — | sql:execute blocks auto-run and format as tables |
| CSV attachments for SQL results | Complete | — | Uploads CSV files to Slack threads |
| Agent log parser | Complete | — | Structured parsing for dashboard timeline |
| Pricing module | Complete | — | Per-model cost calculation |
| Perf stats | Complete | — | Tool call breakdown, timing stats |
| Dashboard timeline (LLM conversation) | Complete | — | Router, assistant, tool, heartbeat cards |
| Dashboard cost breakdown | Complete | — | Per-turn and total cost display |
| Schema verification workflow | Complete | — | describe-tables.sh + model-relationships.md |
| Feature request via agent | Complete | — | Agent creates Trello cards for user requests |
| Listener response handling | Changeable | 441 (7x9x7) | ~80 lines duplicated between very_low fast path and full agent path |
| SQL query safety check | Upgradeable | 384 (6x8x8) | Only allows SELECT; blocks safe DESCRIBE/SHOW queries |
| Agent log disk files | Incomplete | 360 (5x9x8) | No cleanup — logs grow indefinitely on disk |
| github.webhookSecret config | Removeable | 300 (3x10x10) | Dead code in config.ts and fixtures, never used |
| Daily cost tracking + alerts | Incomplete | 245 (7x7x5) | Card in Review; no persistent cost tracking yet |
| Router misroutes data queries | Changeable | 378 (7x9x6) | Routes "make me a csv" as very_low/no-agent when it needs agent |

---

## Desired Features

<!-- ICE format: Total (IxCxE) — e.g. 336 (8x7x6) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Listener response handler DRY refactor | Carded | 441 (7x9x7) | Carded session 9 |
| DESCRIBE/SHOW query support | Carded | 384 (6x8x8) | Carded session 9 |
| Router data query accuracy | Carded | 378 (7x9x6) | Carded session 8 |
| Agent log file cleanup | Carded | 360 (5x9x8) | Carded session 9 |
| Low complexity fast path | Carded | 336 (7x8x6) | Carded session 8 |
| Remove unused github config | Carded | 300 (3x10x10) | Carded session 8 |
| Feedback prompt in responses | Carded | 252 (6x7x6) | Carded session 8 |
| Daily cost tracking + alerts | Carded | 245 (7x7x5) | Carded session 7 |
| Dashboard per-user analytics | Carded | 210 (7x6x5) | Carded session 9 |
| Response caching | Valuable | 140 (7x5x4) | Cache common platform queries to reduce agent cost |
| Multi-channel support | Exploratory | 168 (7x6x4) | Support beyond single Slack channel |
| Agent response quality scoring | Exploratory | 72 (9x4x2) | Auto-evaluate quality via LLM judge |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-03-15 (session 9): No new code changes since session 8. DB stats unchanged (22 events, 18 complete, 4 error, 1 user). Review list had 6 cards from sessions 7-8. Created 4 new cards to bring Review to 10.

Board state: Review now has 10 cards. ToDo empty. In Progress empty.

Key findings this session:
1. Listener.ts has ~80 lines of duplicated response handling between very_low fast path and full agent path (DRY violation)
2. sql-executor.ts blocks DESCRIBE/SHOW queries that are safe read-only operations
3. Agent log files written to /flytebot/logs/ have no TTL/cleanup mechanism (events and threads have cleanup but logs don't)
4. Still only 1 active user — adoption hasn't grown since last session

Created 4 new cards in Review:
1. [Listener] Extract shared response handler to reduce duplication (ICE 441) — Maintenance
2. [SQL] Support DESCRIBE and SHOW queries in sql-executor (ICE 384) — Valuable
3. [Logs] Add agent log file cleanup to prevent disk growth (ICE 360) — Maintenance
4. [Dashboard] Add per-user analytics to API and UI (ICE 210) — Valuable

Mix: 2 Valuable + 2 Maintenance. Prioritized by ICE score. Review now at 10 cards (poller threshold).
