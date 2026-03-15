# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-03-15 (session 8)

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
| Router error fallback | Complete | — | Returns needsAgent:false on failure (was Bug, fixed) |
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
| github.webhookSecret config | Removeable | 270 (9x10x3) | Dead code in config.ts and fixtures, never used |
| Daily cost tracking + alerts | Incomplete | 245 (7x7x5) | Card in Review; no persistent cost tracking yet |
| Router misroutes data queries | Changeable | 378 (7x9x6) | Routes "make me a csv" as very_low/no-agent when it needs agent |

---

## Desired Features

<!-- ICE format: Total (IxCxE) — e.g. 336 (8x7x6) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Daily cost tracking + alerts | Carded | 245 (7x7x5) | Already in Review |
| Router data query accuracy | Carded | 378 (7x9x6) | Carded session 8 |
| Low complexity fast path | Carded | 336 (7x8x6) | Carded session 8 |
| Remove unused github config | Carded | 300 (3x10x10) | Carded session 8 |
| Feedback prompt in responses | Carded | 252 (6x7x6) | Carded session 8 |
| Dashboard per-user analytics | Valuable | 210 (7x6x5) | Show top users, per-user cost, usage patterns |
| Response caching | Valuable | 140 (7x5x4) | Cache common platform queries |
| Multi-channel support | Exploratory | 168 (7x6x4) | Support beyond single Slack channel |
| Agent response quality scoring | Exploratory | 72 (9x4x2) | Auto-evaluate quality via LLM judge |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-03-15 (session 8): Massive codebase growth since session 7. The autonomous team completed ~15+ cards.

Completed since session 7:
- Router error fallback fixed (returns needsAgent:false)
- Health check DB connectivity added
- DB events cleanup added
- DB connect timeout added
- SQL execution in agent responses (sql:execute blocks)
- CSV file attachments for SQL query results
- Agent log parser and dashboard timeline
- Pricing module with per-model costs
- Perf stats for tool breakdown
- Dashboard LLM conversation view (router, assistant, tool, heartbeat cards)
- Schema verification workflow (describe-tables.sh, model-relationships.md)
- Feature request creation via agent
- Platform integration (sibling containers, external repo workflow)

Board state: Review has 2 cards (daily cost tracking, platform creative transcoding). ToDo empty. In Progress empty.

DB stats: 22 events (18 complete, 4 error). 1 user (newms87). Complexity: 10 very_low, 8 low. Avg cost $0.08 for low. Total spend ~$0.63.

Error patterns: 2 credit balance errors, 1 JSON parse error (agent returned raw CSV), 1 effort param not supported.

Key findings:
1. Router misroutes data queries ("make me a csv") as very_low/no-agent when they need the agent
2. github.webhookSecret still dead code
3. Very low feedback rate (1/22) - users may not notice reaction prompts
4. Low complexity goes through full heartbeat path unnecessarily
5. Only 1 active user so far - still early adoption phase

Created 4 new cards in Review:
1. [Router] Improve data query routing accuracy (ICE 378)
2. [Agent] Add low complexity fast path (ICE 336)
3. [Config] Remove unused github.webhookSecret (ICE 270)
4. [Agent] Add feedback prompt to responses (ICE 252)

Mix: 2 Valuable + 2 Maintenance. Prioritized by ICE score.
