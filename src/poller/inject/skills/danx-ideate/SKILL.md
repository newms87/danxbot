---
name: danx-ideate
description: Launch the ideator agent to explore the repo, build knowledge, and generate feature cards.
---

# Danx Ideate

Launch the ideator agent for feature discovery and card generation. Use `mode: "bypassPermissions"`.

## Scope

The ideator defaults to exploring the current repo only.

| Invocation | Scope |
|------------|-------|
| `/danx-ideate` | Current repo only (default) |

## Steps

1. Launch the ideator subagent via Task tool with `mode: "bypassPermissions"`
2. The ideator will:
   - Read `docs/features.md` (its persistent feature notes)
   - Explore the codebase
   - Update the Feature Inventory with current status of features
   - ICE score every non-Complete feature
   - Brainstorm and prioritize new feature ideas
   - Check Review, ToDo, and In Progress lists for duplicates
   - Generate 3-5 prioritized cards in the Review list
   - Save all discoveries back to `docs/features.md`
3. Report what the ideator produced:
   - Features discovered or recategorized
   - ICE scores and top priorities
   - Trello cards created (with titles)
   - Knowledge docs updated (if any)
4. **Signal completion (MANDATORY):** Call the `danxbot_complete` MCP tool with `status: "completed"` and a one-line `summary` of what the ideator produced (e.g. "Generated 4 cards in Review, refreshed features.md"). The worker uses this signal to finalize the dispatch row and SIGTERM the Claude process. Do not exit without calling it.
