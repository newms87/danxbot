---
name: ideate
description: Launch the ideator agent to explore the platform, build knowledge, and generate feature cards.
---

# Ideate

Launch the ideator agent for feature discovery and card generation. Use `mode: "bypassPermissions"`.

## Steps

1. Launch the ideator subagent via Task tool with `mode: "bypassPermissions"`
2. The ideator will:
   - Read `docs/features.md` (its persistent feature notes)
   - Explore the Flytebot and Flytedesk platform codebases
   - Update the Feature Inventory with current status of all features
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
