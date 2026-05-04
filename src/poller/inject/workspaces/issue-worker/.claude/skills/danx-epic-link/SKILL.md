---
name: danx-epic-link
description: Wire two-way parent_id ↔ children[] linkage between an Epic card and its phase cards already on the tracker. Triggered the FIRST time an agent picks up an Epic whose `children[]` is empty. Never creates new cards — only links existing ones.
---

# Danx Epic Link

You are running because the orchestrator picked up an Epic-typed card whose
local YAML's `children: []` is empty. That means one of two things happened:

1. **A human created phase cards directly on the Trello UI** without going
   through `danx_issue_create`. The phase YAMLs were bulk-synced into local
   `issues/open/` by the poller on a previous tick, but no `parent_id` was
   set on them and no `children[]` was set on the epic.
2. **A previous agent split the epic via `danx_issue_create`** but a code
   regression skipped the linkage step. (You should not be hit if that
   path ran cleanly — `danx_issue_create` writes `parent_id` itself.)

**Your one job**: identify which open issue YAMLs are this epic's phase
cards, set `parent_id` on each, and set `children[]` on the epic. Then
return control to the orchestrator. **Do NOT create any new cards. Do NOT
edit any phase card content beyond `parent_id`.**

If `children[]` is already non-empty when this skill is invoked, exit
immediately — the epic is already linked.

---

## Step 1 — Identify candidate phase cards

1. The orchestrator's dispatch prompt has the epic's YAML path. Read it.
2. List `<repo>/.danxbot/issues/open/*.yml`.
3. For each open issue (excluding the epic itself), read the YAML and
   extract `id`, `parent_id`, `title`, `type`.
4. Build a candidate set:
   - `parent_id == null` (already-linked phase cards aren't candidates).
   - Title pattern, content, or domain looks like a phase of THIS epic.
     Use your judgment from the titles + descriptions. Common shapes:
     - `<Epic-related-prefix> > Phase N: <Description>`
     - `<Epic title prefix>: Phase N`
     - Description references the epic by id or by name.
5. List the matched candidates back to yourself with their ids and titles.

If zero candidates match, the epic genuinely has no phase children —
write `children: []` to the epic (already empty, but make the intent
explicit in a comment) and exit. The epic's phases live as in-card
checklist items rather than separate cards. The orchestrator continues
with normal Step 4 implementation on the epic itself.

If one or more candidates match, proceed to Step 2.

---

## Step 2 — Confirm phase ordering

Phase cards typically have a `Phase N:` numeric marker in the title.
Sort the candidates by:

1. **If ANY candidate has a `Phase N:` marker**, sort the WHOLE candidate
   set by the numeric `N` extracted from `Phase N:` (regex:
   `/Phase\s+(\d+)\s*:/i`). Candidates without the marker sort last,
   alphabetically among themselves. This avoids the alpha-only
   `Phase 10` < `Phase 2` ordering bug.
2. **If NO candidate has a `Phase N:` marker**, fall back to title
   alphabetic ordering across the whole set.

The order you produce becomes the epic's `children[]` array order,
which determines the natural "next phase" the orchestrator picks up
after this skill returns. Order matters.

---

## Step 3 — Wire the linkage

For each candidate phase YAML, in the order from Step 2:

1. `Read <repo>/.danxbot/issues/open/<phase-id>.yml`
2. `Edit` the YAML: set `parent_id: "<epic-id>"`. Touch nothing else
   (don't change `status`, `description`, `ac[]`, etc.).
3. Append a comment to `comments[]` (no `id` field):
   - `author: "danxbot"`
   - `timestamp: <current ISO>`
   - `text:` `Linked to parent epic <epic-id> by danx-epic-link skill.`
4. `danx_issue_save({id: "<phase-id>"})`. The worker pushes the changes
   to the tracker.

After all phase YAMLs are saved, edit the epic's YAML:

1. Set `children: ["<phase-1-id>", "<phase-2-id>", ...]` in the order
   from Step 2.
2. Append a comment to `comments[]` (no `id` field):
   - `author: "danxbot"`
   - `timestamp: <current ISO>`
   - `text:` a multi-line markdown body:
     ```
     ## Epic linkage

     `danx-epic-link` wired the two-way parent_id ↔ children[] linkage
     for this epic's phase cards (created directly on the tracker UI
     without going through `danx_issue_create`).

     **Children:**

     - <phase-1-id>: <phase-1-title>
     - <phase-2-id>: <phase-2-title>
     - ...
     ```
3. `danx_issue_save({id: "<epic-id>"})`.

---

## Step 4 — Return control to the orchestrator

You are a sub-skill. The orchestrator (`danx-next`) called you to set
up the linkage and now expects you to return so it can continue the
normal workflow.

Do NOT call `danxbot_complete` from this skill — the orchestrator owns
that signal. Do NOT move the epic to Done — the epic stays In Progress
until all phase cards reach Done.

After your last `danx_issue_save`, simply stop. The orchestrator's flow
will see `children[]` non-empty on its next read and skip Step 3 (Epic
Split) entirely, then jump to the first incomplete phase card and pick
that up via the normal pipeline.

---

## Forbidden moves

- **Do NOT call `danx_issue_create`.** Phase cards already exist on the
  tracker. Creating new ones would duplicate them.
- **Do NOT edit phase card descriptions, titles, or AC items.** Only
  `parent_id` and an audit comment.
- **Do NOT move any phase card across statuses.** They stay in `ToDo`
  until the orchestrator picks the first one up.
- **Do NOT delete YAMLs that don't match.** Cards in `open/` that
  aren't this epic's phases are unrelated work — leave them alone.
- **Do NOT recurse into nested epics.** If a candidate is itself an
  Epic with its own children, link it as a phase of THIS epic
  (`parent_id` to outer epic, `children[]` preserved on the inner
  epic). The orchestrator handles nested epics on a future pickup.

---

## When in doubt

If the candidate set is ambiguous (e.g. two cards could be Phase 1 of
different epics, or a candidate's title doesn't clearly belong to this
epic), abort and let the orchestrator move the epic to Needs Help.
Append a comment to the epic's YAML describing the ambiguity:

```
## Epic linkage — ambiguous

`danx-epic-link` could not unambiguously identify this epic's phase
cards. Candidates examined: <list of ids + titles + reasoning>.
Human review needed to set `parent_id` on the right children + the
matching `children[]` on this epic.
```

Then save and signal Needs Help via the normal `danx-next` Step 10
flow.
