# Flytebot Chat — Feature Notes

This file is the Ideator agent's persistent memory. It tracks all features, their status, and prioritized ideas for improvement.

Last updated: 2026-02-14

---

## Feature Inventory

<!-- Status: Complete | Upgradeable | Incomplete | Removeable | Changeable -->
<!-- For non-Complete items, include ICE score: Impact (1-10) x Confidence (1-10) x Ease (1-10) -->

| Feature | Status | ICE | Notes |
|---------|--------|-----|-------|
| Slack Socket Mode listener | Complete | — | Receives messages, handles threads |
| Haiku router (triage) | Upgradeable | 336 | Silent failure — returns empty string on error, user gets no feedback |
| Claude Code SDK agent | Complete | — | Deep exploration via `query()` |
| Real-time streaming | Complete | — | Heartbeat updates during agent runs |
| Heartbeat manager | Complete | — | Throttled Slack updates, but zero test coverage |
| Dashboard + SSE | Complete | — | Events table, analytics, light/dark theme |
| Markdown-to-Slack formatter | Upgradeable | 252 | No markdown table support — tables render as raw text |
| Thread state persistence | Complete | — | JSON files on disk |
| Session resumption | Complete | — | Resumes agent sessions for thread follow-ups |
| Message splitting | Complete | — | Splits long responses into multiple Slack messages |
| Agent log writing | Complete | — | Persists agent conversation logs to disk |
| Validation tests | Complete | — | Real Claude API tests with $2 budget |
| Domain reference docs | Incomplete | 504 | System prompt references 8 domains but `docs/domains/` is empty |
| System prompt | Complete | — | Domain routing instructions for agent |
| Test fixtures/helpers | Complete | — | Shared mocks and factories |

---

## Desired Features

<!-- ICE = Impact x Confidence x Ease (each 1-10) -->
<!-- Type: Carded | Valuable | Maintenance | Dependent | Exploratory -->
<!-- Carded = already a Trello card, Valuable = direct end-user value -->
<!-- Maintenance = cleanup/refactor/QoL/QoS, Dependent = needs other features first -->
<!-- Exploratory = unsure value, needs requirement gathering with end users -->
<!-- Priority: keep a mix of Maintenance + Valuable in the queue -->
<!-- When queue is empty, check Exploratory + Dependent for promotion -->

| Feature Idea | Type | ICE | Description |
|--------------|------|-----|-------------|
| Domain reference docs (campaigns + billing) | Carded | 504 | Biggest gap, agent re-explores from scratch every time |
| Router error fallback | Carded | 336 | Show user-friendly message instead of silent failure |
| User feedback via Slack reactions | Carded | 280 | Track thumbs up/down on bot responses for quality metrics |
| Formatter table support | Carded | 252 | Markdown tables render as raw text in Slack |
| HeartbeatManager unit tests | Carded | 180 | 198-line class with zero test coverage |
| Dashboard search/filter | Valuable | — | Filter events table by user, status, date range |
| Response caching | Dependent | — | Cache common platform queries; needs domain docs first |
| Cost alerts | Valuable | — | Notify when agent cost exceeds threshold |

---

## Last Session

<!-- Overwritten each session — only the most recent notes live here -->

2026-02-14: First full exploration. Read all 20 files (15 src + 5 test). Discovered 15 features total — 11 Complete, 2 Upgradeable, 1 Incomplete. Biggest gap: domain docs are completely empty despite system prompt referencing them. Created 5 Trello cards in Review. Ideator was blocked from writing this file (permission issue with subagent Write/Edit tools).
