# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14 (session 6)

---

## Feature Inventory

<!-- Status: Complete | Upgradeable | Incomplete | Removeable | Changeable -->
<!-- For non-Complete items, include ICE score: Impact (1-10) x Confidence (1-10) x Ease (1-10) -->

| Feature | Status | ICE | Notes |
|---------|--------|-----|-------|
| Slack Socket Mode listener | Complete | — | Receives messages, handles threads |
| Haiku router (triage) | Complete | — | Error fallback with user-friendly message |
| Claude Code SDK agent | Complete | — | Deep exploration via `query()` |
| Real-time streaming | Complete | — | Heartbeat updates during agent runs |
| Heartbeat manager | Complete | — | Throttled Slack updates, comprehensive unit tests |
| Dashboard + SSE | Complete | — | Events table, analytics, search/filter, light/dark theme |
| Markdown-to-Slack formatter | Complete | — | Full markdown support including tables |
| Thread state persistence | Complete | — | JSON files on disk, 7-day cleanup |
| Session resumption | Complete | — | Resumes agent sessions for thread follow-ups |
| Message splitting | Complete | — | Splits long responses into multiple Slack messages |
| Agent log writing | Complete | — | Persists agent conversation logs to disk |
| Validation tests | Complete | — | Real Claude API tests with $2 budget |
| Domain docs (all 8) | Complete | — | Campaigns, billing, suppliers, ads, users, SSP, school data, buyers |
| User feedback via Slack reactions | Complete | — | Tracks thumbs up/down on bot responses |
| Dashboard event persistence | Complete | — | Debounced disk writes with atomic rename |
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
| Graceful shutdown | Incomplete | 504 | No signal handlers in index.ts; card in Review |
| Thread context window limit | Incomplete | 336 | Unbounded thread history; card in Review |
| Error notifications to ops channel | Incomplete | 336 | Errors only visible to requesting user; card in Review |
| Config validation on startup | Incomplete | 360 | Numeric config not validated for NaN/negative; card in Review |
| Structured JSON logging | Incomplete | 270 | All logging is bare console.log; card in Review |
| Index.ts unit tests | Incomplete | 224 | Entrypoint has zero test coverage; card in Review |
| Daily cost tracking + alerts | Incomplete | 245 | No persistent cost tracking; card in Review |
| Agent retry on transient failure | Incomplete | 210 | No auto-retry on crash; card in Review |
| Dashboard data export | Incomplete | 192 | No CSV/JSON export; card in Review |

---

## Desired Features

<!-- ICE = Impact x Confidence x Ease (each 1-10) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Graceful shutdown handler | Carded | 504 | Signal handlers, clean up in-flight agents on restart |
| Config validation on startup | Carded | 360 | Validate parsed numeric config values on boot |
| Error notifications to ops channel | Carded | 336 | Post agent errors to Trello ToDo as bug cards |
| Thread context window limit | Carded | 336 | Cap thread messages sent to router/agent |
| Structured JSON logging | Carded | 270 | Replace console.log with structured JSON logger |
| Daily cost tracking + alerts | Carded | 245 | Track daily spend, alert on threshold |
| Index.ts startup tests | Carded | 224 | Test entrypoint startup order and error handling |
| Agent retry on error | Carded | 210 | Auto-retry once on transient agent failures |
| Dashboard data export | Carded | 192 | Export events as CSV/JSON for offline analysis |
| Response caching | Valuable | 140 | Cache common platform queries (deps met: all domain docs done) |
| Event archiving beyond 500 | Valuable | 175 | Persist older events to archive file when cap is reached |
| Multi-channel support | Exploratory | 168 | Support beyond single Slack channel |
| Agent response quality scoring | Exploratory | 72 | Auto-evaluate response quality via LLM judge |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14 (session 6): Major progress since session 5. The autonomous agent team completed 9 more cards since last session, emptying the ToDo and In Progress lists entirely.

Newly completed since session 5:
- Domain docs: School Data + Buyers (all 8 domains now done)
- Slack user display names in dashboard
- Dashboard search/filter controls
- Health check endpoint
- Per-user rate limiting (was In Progress)
- Poller module unit tests
- Listener tests (comprehensive coverage)

Codebase stats: 17 test files, 248 tests (up from 224 in session 5), all passing.

Board state: Review has 9 cards (5 from session 5 + 4 new). ToDo is empty. In Progress is empty. Done has 21 cards.

Created 4 new Trello cards in Review:
1. Validate config values on startup (ICE 360, Maintenance)
2. Add structured JSON logging (ICE 270, Maintenance)
3. Add unit tests for index.ts startup flow (ICE 224, Maintenance)
4. Add dashboard data export CSV/JSON (ICE 192, Valuable)

Mix: 1 Valuable + 3 Maintenance. Review now has 9 cards total. Next priorities after current queue: event archiving (ICE 175), response caching (ICE 140, deps now met).

Key observations:
- github.webhookSecret config exists but remains unused
- Router error fallback sets needsAgent:true, which may waste agent budget on router failures
- Response caching dependency (domain docs) is now fully satisfied
- index.ts is the only production file with zero test coverage
