# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14 (session 5)

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
| Dashboard + SSE | Complete | — | Events table, analytics, light/dark theme |
| Markdown-to-Slack formatter | Complete | — | Full markdown support including tables |
| Thread state persistence | Complete | — | JSON files on disk, 7-day cleanup |
| Session resumption | Complete | — | Resumes agent sessions for thread follow-ups |
| Message splitting | Complete | — | Splits long responses into multiple Slack messages |
| Agent log writing | Complete | — | Persists agent conversation logs to disk |
| Validation tests | Complete | — | Real Claude API tests with $2 budget |
| Domain docs: campaigns | Complete | — | First domain doc |
| Domain docs: billing | Complete | — | Invoice, payment, billing profile |
| Domain docs: suppliers | Complete | — | Suppliers, publications, ad zones |
| Domain docs: ads/creatives | Complete | — | Ad assets, approval workflows |
| Domain docs: users/auth | Complete | — | User management, roles, permissions |
| Domain docs: SSP | Complete | — | Programmatic ad serving |
| User feedback via Slack reactions | Complete | — | Tracks thumbs up/down on bot responses |
| Dashboard event persistence | Complete | — | Debounced disk writes with atomic rename |
| System prompt | Complete | — | Domain routing instructions for agent |
| Test fixtures/helpers | Complete | — | Shared mocks and factories |
| Router + parse-json-response tests | Complete | — | Full test coverage |
| Dashboard server + helpers tests | Complete | — | Full test coverage |
| Per-user rate limiting | Complete | — | In-memory cooldown per user, integrated in listener |
| Poller (Trello automation) | Complete | — | Polls ToDo list, spawns /start-team, signal handlers |
| Poller trello-client tests | Complete | — | API call and error handling tested |
| Poller config tests | Complete | — | Config parsing tested |
| Domain docs: school data + buyers | Incomplete | 336 | Last 2 of 8 domains; card in ToDo |
| Slack user display names | Upgradeable | 336 | Dashboard shows raw user IDs; card in ToDo |
| Dashboard search/filter | Incomplete | 336 | No way to filter events table; card in ToDo |
| Graceful shutdown | Incomplete | 504 | No signal handlers in index.ts; card in ToDo |
| Thread context window limit | Incomplete | 336 | Unbounded thread history; card in ToDo |
| Health check endpoint | Incomplete | 240 | No /health route; card in ToDo |
| Error notifications to ops channel | Incomplete | 336 | Errors only visible to requesting user; card in Review |
| Poller index.ts tests | Incomplete | 315 | Poll loop/spawn/shutdown untested; card in Review |
| Daily cost tracking + alerts | Incomplete | 245 | No persistent cost tracking; card in Review |
| Agent retry on transient failure | Incomplete | 210 | No auto-retry on crash; card in Review |

---

## Desired Features

<!-- ICE = Impact x Confidence x Ease (each 1-10) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Graceful shutdown handler | Carded | 504 | Signal handlers, clean up in-flight agents on restart |
| Domain docs: School Data + Buyers | Carded | 336 | Last 2 domain knowledge gaps |
| Dashboard search/filter | Carded | 336 | Filter events by text, status |
| Slack user display names | Carded | 336 | Resolve user IDs to display names in dashboard |
| Thread context window limit | Carded | 336 | Cap thread messages sent to router/agent |
| Error notifications to ops channel | Carded | 336 | Post agent errors to a configurable ops channel |
| Poller index.ts tests | Carded | 315 | Poll loop, spawn, shutdown logic untested |
| Per-user rate limiting | Carded | 280 | Implemented; In Progress on board |
| Daily cost tracking + alerts | Carded | 245 | Track daily spend, alert on threshold |
| Health check endpoint | Carded | 240 | GET /health for uptime monitoring |
| Agent retry on error | Carded | 210 | Auto-retry once on transient agent failures |
| Dashboard data export | Valuable | 192 | Export events as CSV/JSON for offline analysis (6*8*4) |
| Response caching | Dependent | 280 | Cache common platform queries; needs domain docs first |
| Multi-channel support | Exploratory | 168 | Support beyond Slack (Teams, web chat) |
| Agent response quality scoring | Exploratory | 72 | Auto-evaluate response quality via LLM judge |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14 (session 5): Significant progress since session 4. The autonomous agent team has been active -- 12 cards in Done, 6 in ToDo, 1 In Progress (rate limiting, partially implemented).

Codebase changes since session 4:
- Rate limiter module added (`src/slack/rate-limiter.ts`) and integrated into listener
- Poller module added (`src/poller/`) -- polls Trello ToDo, spawns `/start-team`
- Router + parse-json-response tests completed (Done)
- Dashboard server + helpers tests completed (Done)
- Test count: 14 files, 224 tests (up from ~151 in session 4)
- `github.webhookSecret` config exists but unused -- potential future feature

Board state: Review was empty (0 cards). ToDo has 6 cards. In Progress has 1 (rate limiting). Done has 12.

Created 4 new Trello cards in Review:
1. Send agent error notifications to ops channel (ICE 336, Valuable)
2. Add unit tests for poller module (ICE 315, Maintenance)
3. Add daily cost tracking with threshold alerts (ICE 245, Valuable)
4. Add automatic agent retry on transient failures (ICE 210, Valuable)

Mix: 3 Valuable + 1 Maintenance. Review list now has 4 cards. Next priorities after current queue: dashboard data export (ICE 192), response caching (Dependent, ICE 280 -- needs domain docs done first).
