---
name: ideate
description: Launch the ideator agent to explore the connected repo, build knowledge, and generate feature cards.
---

# Ideate

Launch the ideator agent for feature discovery and card generation. Use `mode: "bypassPermissions"`.

## Scope

The ideator defaults to **target repo only**. Pass an optional argument to change scope:

| Invocation | Scope | What it explores |
|------------|-------|------------------|
| `/ideate` | `repo` | Connected repo only (default) |
| `/ideate danxbot` | `danxbot` | Danxbot only |
| `/ideate all` | `all` | Both Danxbot and connected repo |

## Steps

1. Determine scope from arguments (default: `repo`)
2. Launch the ideator subagent via Task tool with `mode: "bypassPermissions"`. Include in the prompt: `"Scope: <scope>"` where `<scope>` is `repo`, `danxbot`, or `all`
3. The ideator will:
   - Read `docs/features.md` (its persistent feature notes)
   - Explore only the codebases within scope
   - Update the Feature Inventory with current status of in-scope features
   - ICE score every non-Complete feature
   - Brainstorm and prioritize new feature ideas
   - Check Review, ToDo, and In Progress lists for duplicates
   - Generate 3-5 prioritized cards in the Review list
   - Save all discoveries back to `docs/features.md`
4. Report what the ideator produced:
   - Features discovered or recategorized
   - ICE scores and top priorities
   - Trello cards created (with titles)
   - Knowledge docs updated (if any)
5. **Self-terminate if ephemeral:** Run `./scripts/self-terminate.sh $PPID` via Bash. The script checks `DANXBOT_EPHEMERAL` and handles lock file removal and process termination atomically. Never assume you know the session type — always run the script.
