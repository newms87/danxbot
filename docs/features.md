# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14 (session 4)

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
| Domain docs: school data + buyers | Incomplete | 336 | Last 2 of 8 domains referenced in system prompt |
| Router + parse-json-response tests | Incomplete | 432 | Critical path modules with zero test coverage |
| Dashboard server + helpers tests | Incomplete | 360 | HTTP server and Slack helpers with zero test coverage |
| Slack user display names | Upgradeable | 336 | Dashboard shows raw user IDs instead of names |
| Dashboard search/filter | Incomplete | 336 | No way to filter events table |
| Graceful shutdown | Incomplete | 504 | No signal handlers; stuck placeholders on restart |
| Thread context window limit | Incomplete | 336 | Unbounded thread history sent to router/agent |
| Health check endpoint | Incomplete | 240 | No /health route for monitoring |
| Per-user rate limiting | Incomplete | 280 | No flood protection; each message spawns agent run |

---

## Desired Features

<!-- ICE = Impact x Confidence x Ease (each 1-10) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Graceful shutdown handler | Carded | 504 | Signal handlers, clean up in-flight agents on restart |
| Router + parse-json-response tests | Carded | 432 | Critical path, zero coverage, high risk |
| Dashboard server + helpers tests | Carded | 360 | HTTP server and helpers, zero coverage |
| Domain docs: School Data + Buyers | Carded | 336 | Last 2 domain knowledge gaps |
| Dashboard search/filter | Carded | 336 | Filter events by text, status |
| Slack user display names | Carded | 336 | Resolve user IDs to display names in dashboard |
| Thread context window limit | Carded | 336 | Cap thread messages sent to router/agent |
| Per-user rate limiting | Carded | 280 | Prevent cost runaway from rapid messages |
| Cost tracking alerts | Valuable | 252 | Notify when agent cost exceeds threshold |
| Health check endpoint | Carded | 240 | GET /health for uptime monitoring |
| Agent retry on error | Valuable | 210 | Auto-retry once on transient agent failures (7*5*6) |
| Dashboard data export | Valuable | 192 | Export events as CSV/JSON for offline analysis (6*8*4) |
| Response caching | Dependent | 280 | Cache common platform queries; needs domain docs first |
| Multi-channel support | Exploratory | 168 | Support beyond Slack (Teams, web chat) |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14 (session 4): No cards were moved to ToDo or completed since session 3. The Review list had 6 existing cards (5 from session 3 + 1 manually-added "Trello Webhooks" card). ToDo and In Progress are empty.

Codebase assessment: 27 TypeScript files in src/ (same as session 3 + the b30f7a5 commit fixing non-root container user). 8 test files. Domain docs: still 6 of 8 (missing school-data, buyers). No new feature implementations since session 3.

Key discoveries this session:
- `src/index.ts` has no signal handlers (SIGTERM/SIGINT) -- stuck Slack placeholders on restart
- `thread.messages` grows unbounded -- risk of token overflow on long conversations
- No rate limiting in listener.ts -- each message spawns a full agent run
- Dashboard time format uses locale-dependent `toLocaleTimeString()` with no date

Created 4 new Trello cards in Review:
1. Graceful shutdown with in-flight agent cleanup (ICE 504, Maintenance)
2. Limit thread context window (ICE 336, Valuable)
3. Health check endpoint (ICE 240, Maintenance)
4. Per-user rate limiting (ICE 280, Valuable)

Mix: 2 Valuable + 2 Maintenance. Review list now has 10 cards total. Next priorities after current queue: cost tracking alerts (ICE 252), agent retry on error (ICE 210), dashboard data export (ICE 192).
