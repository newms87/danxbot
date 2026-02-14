# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14 (session 7)

---

## Feature Inventory

<!-- Status: Complete | Upgradeable | Incomplete | Removeable | Changeable -->
<!-- ICE format: Total (IxCxE) — e.g. 336 (8×7×6) -->

| Feature | Status | ICE | Notes |
|---------|--------|-----|-------|
| Slack Socket Mode listener | Complete | — | Receives messages, handles threads |
| Haiku router (triage) | Complete | — | Error fallback with user-friendly message |
| Claude Code SDK agent | Complete | — | Deep exploration via `query()` |
| Real-time streaming | Complete | — | Heartbeat updates during agent runs |
| Heartbeat manager | Complete | — | Throttled Slack updates, comprehensive unit tests |
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
| Per-user rate limiting | Complete | — | In-memory cooldown per user, integrated in listener |
| Poller (Trello automation) | Complete | — | Polls ToDo list, spawns /start-team, signal handlers |
| Poller tests (all modules) | Complete | — | trello-client, config, index all tested |
| Slack user display names | Complete | — | User cache resolves IDs to names for dashboard |
| Dashboard search/filter | Complete | — | Text + status filter controls |
| Health check endpoint | Complete | — | GET /health returns status, uptime, memory, event count |
| Listener tests | Complete | — | Filters, happy paths, threads, errors, rate limiting, feedback |
| Graceful shutdown | Complete | — | Signal handlers, in-flight placeholder updates, DB pool close |
| Thread context window limit | Complete | — | Trims thread messages to MAX_THREAD_MESSAGES |
| Error notifications to ops | Complete | — | Posts error cards to Trello ToDo |
| Config validation on startup | Complete | — | Validates numeric config for NaN/negative |
| Structured JSON logging | Complete | — | createLogger() emits JSON with timestamp, level, component |
| Index.ts unit tests | Complete | — | Entrypoint startup order tested |
| Agent retry on transient failure | Complete | — | maxRetries config, retry loop with escalation |
| Dashboard data export | Complete | — | CSV and JSON export via /api/events/export |
| 5-level complexity routing | Complete | — | very_low through very_high with model/budget profiles |
| Feature discovery (router) | Complete | — | Router suggests features for uncertain users |
| DB persistence (events, threads, users) | Complete | — | 3-phase migration, full schema |
| Fast system prompt | Complete | — | Lightweight prompt for very_low/low complexity |
| Router error fallback | Changeable | 504 (7×9×8) | Returns needsAgent:true + very_high on router failure, wasting up to $2 |
| Health check | Upgradeable | 280 (7×8×5) | Missing DB connectivity check; only checks Slack |
| github.webhookSecret config | Removeable | — | Exists in config but unused anywhere |
| Daily cost tracking + alerts | Incomplete | 245 (7×7×5) | Card in Review; no persistent cost tracking yet |

---

## Desired Features

<!-- ICE format: Total (IxCxE) — e.g. 336 (8×7×6) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Daily cost tracking + alerts | Carded | 245 (7×7×5) | Track daily spend, alert on threshold (already in Review) |
| Fix router error fallback | Valuable | 504 (7×9×8) | Stop triggering very_high agent on router failure |
| DB events TTL/cleanup | Maintenance | 360 (6×8×8) | Events table grows unbounded; add periodic cleanup |
| Health check DB connectivity | Maintenance | 280 (7×8×5) | /health should verify DB pool is alive |
| Remove unused github config | Maintenance | 270 (9×10×3) | github.webhookSecret is dead code; 9x10=90, 90x3=270 |
| Response caching | Valuable | 140 (7×5×4) | Cache common platform queries |
| Event archiving beyond 500 | Valuable | 175 (7×5×5) | Persist older events to archive when cap is reached |
| Multi-channel support | Exploratory | 168 (7×6×4) | Support beyond single Slack channel |
| Agent response quality scoring | Exploratory | 72 (9×4×2) | Auto-evaluate response quality via LLM judge |
| Dashboard per-user analytics | Valuable | 210 (7×6×5) | Show top users, per-user cost, usage patterns |
| DB query timeout | Maintenance | 288 (8×8×5) | No query timeout on connection pool; could hang |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14 (session 7): Major progress since session 6. The autonomous team completed nearly all remaining cards.

Newly completed since session 6:
- Persistent Storage phases 1-3 (migration infra, events DB, threads/users DB)
- Feature discovery in router (suggests features to uncertain users)
- Multiple bug fixes (feedback not updating, wrong Slack icons, multiple poller spawns)
- Labels for Trello cards
- Error notification card cleanup

Board state: Review has 1 card (daily cost tracking). ToDo is empty. In Progress is empty. Done has 33 cards. Needs Help and Cancelled are empty.

Codebase stats: 32 test files, 478 tests, all passing. Up from 248 tests in session 6.

New files since session 6:
- src/db/connection.ts, threads-db.ts, users-db.ts, migrate.ts + migrations/
- src/dashboard/events-db.ts, export.ts
- src/errors/trello-notifier.ts
- src/shutdown.ts
- src/agent/features.ts, fast-system-prompt.md, heartbeat.ts
- src/agent/router.ts (extracted from agent.ts)

Discovered issues:
1. Router error fallback sets needsAgent:true + very_high complexity, wasting $2 on router failures (Bug)
2. Events table in DB has no TTL/cleanup -- grows unbounded
3. Health check doesn't verify DB connectivity
4. github.webhookSecret exists in config.ts but is used nowhere
5. DB connection pool has no query timeout

Created 4 new Trello cards in Review:
1. Fix router error fallback to not trigger agent on failure (ICE 504, Bug)
2. Add periodic cleanup for events DB table (ICE 360, Maintenance)
3. Add DB query timeout to connection pool (ICE 288, Maintenance)
4. Add DB connectivity check to health endpoint (ICE 280, Feature)

Mix: 1 Bug + 2 Maintenance + 1 Feature (Valuable). Next priorities: remove unused github config (ICE 270), daily cost tracking (already carded, ICE 245), per-user dashboard analytics (ICE 210).
