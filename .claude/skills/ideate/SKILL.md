---
name: ideate
description: Launch the ideator agent to explore the platform, build knowledge, and generate feature cards.
---

# Ideate

Launch the ideator agent for knowledge building and feature generation.

## Steps

1. Launch the ideator agent
2. The ideator will:
   - Explore the Flytedesk platform codebase and database
   - Identify knowledge gaps in the running Flytebot Chat agent
   - Update `src/agent/system-prompt.md` with domain routing instructions
   - Create or update `docs/domains/*.md` reference docs
   - Update `.claude/rules/platform-overview.md` for the dev team
   - Generate 3-5 feature improvement cards in the Review list (ID: `698fc5bdfa44ac685050fa35`)
3. Report what the ideator created:
   - Knowledge docs updated
   - Feature cards generated (with titles)
   - Domains covered
