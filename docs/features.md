# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14 (session 3)

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

---

## Desired Features

<!-- ICE = Impact x Confidence x Ease (each 1-10) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Router + parse-json-response tests | Carded | 432 | Critical path, zero coverage, high risk |
| Dashboard server + helpers tests | Carded | 360 | HTTP server and helpers, zero coverage |
| Domain docs: School Data + Buyers | Carded | 336 | Last 2 domain knowledge gaps |
| Dashboard search/filter | Carded | 336 | Filter events by text, status |
| Slack user display names | Carded | 336 | Resolve user IDs to display names in dashboard |
| Cost tracking alerts | Valuable | 252 | Notify when agent cost exceeds threshold |
| Response caching | Dependent | 280 | Cache common platform queries; needs domain docs first |
| Multi-channel support | Exploratory | 168 | Support beyond Slack (Teams, web chat) |
| Agent retry on error | Valuable | 210 | Auto-retry once on transient agent failures (7*5*6) |
| Dashboard data export | Valuable | 192 | Export events as CSV/JSON for offline analysis (6*8*4) |
| Health check endpoint | Maintenance | 240 | GET /health for uptime monitoring (6*8*5) |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14 (session 3): All 4 cards from session 2 have been implemented and merged (domain docs for Suppliers, Ads/Creatives, Users/Auth+SSP, and event persistence to disk). All 151 tests pass across 8 test files. Trello Review/ToDo/In Progress lists were all empty.

Codebase assessment: 26 TypeScript files in src/. 8 test files covering agent.ts, listener.ts, formatter.ts, heartbeat-manager.ts, threads.ts, events.ts, events-persistence.ts. Untested modules: router.ts, parse-json-response.ts, server.ts, helpers.ts. Domain docs: 6 of 8 complete (missing school-data and buyers). Dashboard has no search/filter. User column shows raw Slack IDs.

Created 5 new Trello cards in Review:
1. Domain docs: School Data + Buyers (ICE 336, Valuable)
2. Router + parse-json-response tests (ICE 432, Maintenance)
3. Dashboard server + helpers tests (ICE 360, Maintenance)
4. Slack user display names (ICE 336, Valuable)
5. Dashboard search/filter (ICE 336, Valuable)

Mix: 3 Valuable + 2 Maintenance. Next priorities after these: cost tracking alerts (ICE 252), health check endpoint (ICE 240), agent retry on error (ICE 210).
