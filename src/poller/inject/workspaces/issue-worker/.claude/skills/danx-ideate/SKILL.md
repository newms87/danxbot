---
name: danx-ideate
description: Launch the ideator agent to explore the repo, build knowledge, and generate feature cards.
---

# Danx Ideate

Launch the ideator agent to brainstorm features and generate draft cards. Use `mode: "bypassPermissions"`.

## Scope

Current repo only.

| Invocation | Scope |
|------------|-------|
| `/danx-ideate` | Current repo |

## Steps

1. Launch the ideator subagent via `Task` with `mode: "bypassPermissions"`.
2. The ideator:
   - Reads `docs/features.md` (its persistent feature notes).
   - Explores the codebase.
   - Updates the Feature Inventory with current status of features.
   - ICE-scores every non-Complete feature.
   - Brainstorms + prioritizes new feature ideas.
   - Checks `<repo>/.danxbot/issues/open/*.yml` for duplicates (search by title / keywords).
   - Generates 3-5 prioritized feature drafts.
   - For each draft, writes a YAML at `<repo>/.danxbot/issues/open/<filename>.yml` with:
     - `id: ""` (worker assigns the next `ISS-N` — drafts with non-empty `id` are REJECTED)
     - `parent_id: null`
     - `dispatch_id: null`
     - `status: "Review"`
     - `type: "Feature"` (or `"Bug"` for bug drafts)
     - `title`, `description` populated
     - `triaged: {timestamp: "", status: "", explain: ""}`
     - `ac: [{check_item_id: "", title: "...", checked: false}, ...]`
     - `phases: []` (or seeded with `check_item_id: ""`)
     - `comments: []`
     - `retro: {good: "", bad: "", action_items: [], commits: []}`
     - `schema_version: 2`
     - `tracker: "memory"` (or whichever tracker the repo uses — leave the value the parent YAML carries)
   - Calls `danx_issue_create({filename: "<filename>"})` for each draft. The worker validates, allocates the next `ISS-N`, stamps it back into the YAML, and renames the file to `<id>.yml`. Captures the returned `id`.
   - Saves discoveries back to `docs/features.md`.

3. Report what the ideator produced:
   - Features discovered or recategorized.
   - ICE scores and top priorities.
   - Cards created (with titles + assigned `id`s).
   - Knowledge docs updated (if any).

4. **Signal completion (MANDATORY):** `danxbot_complete({status: "completed", summary: "..."})`. Worker finalizes the dispatch row + SIGTERMs the Claude process. Never exit without it.

## Filename convention

Drafts use a kebab-case slug derived from the title, e.g. `add-jsonl-tail-helper.yml`. Keep filenames stable across the create call — the worker renames the file to `<id>.yml` after `danx_issue_create` succeeds. Until then, the filename is the only handle.

## Drafts that fail validation

If `danx_issue_create` returns `{created: false, errors: [...]}`, the YAML failed schema validation. Read the errors, fix the draft YAML, and retry. Do NOT delete the draft file unless you intend to abandon the idea — the file is the durable record until an `id` is assigned.
