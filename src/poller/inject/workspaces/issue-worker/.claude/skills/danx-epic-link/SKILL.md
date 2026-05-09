---
name: danx-epic-link
description: Wire two-way parent_id ↔ children[] linkage between an Epic card and its phase cards already on the tracker. Triggered the FIRST time an agent picks up an Epic whose `children[]` is empty. Never creates new cards — only links existing ones.
---

# Danx Epic Link

You are running because the orchestrator picked up an Epic-typed card whose
local YAML's `children: []` is empty. That means one of two things happened:

1. **A human created phase cards directly on the tracker UI** without going
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

Blocked / Waiting On: This skill uses terminology borrowed from the old
schema. When linking, you edit the `parent_id` and `children[]` fields only;
you do NOT set `waiting_on` on phase cards unless they're already split and
you're stamping serial ordering in Step 3.5 (which uses `waiting_on`, not
the old `blocked` field). The field has been renamed from `blocked` (the
old dep-chain field) to `waiting_on`.

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
leave `children: []` on the epic and exit. There is no in-card phase
checklist (ISS-81 retired that field). The orchestrator continues with
normal Step 4 implementation directly on the epic itself; epics
without phase children are implemented as a single card.

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
4. The chokidar watcher catches the `Edit` and mirrors the change to
   the DB; the poller's per-tick mirror pushes to the tracker. There is
   no save verb to call — the watcher is the canonical write path.

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
3. The watcher mirrors the epic edit to the DB; the poller's per-tick
   mirror pushes to the tracker.

---

## Step 3.5 — Stamp `waiting_on` on phase 2..N for serial ordering

Phase cards picked up by the poller dispatch in tracker-list-top order, NOT
phase order. To force serial dispatch (Phase 1 → Phase 2 → ... → Phase N),
stamp `waiting_on.by` on every phase except the first:

For each phase YAML at index `i >= 1` in the ordered `children[]`:

1. `Read <repo>/.danxbot/issues/open/<phase-id>.yml`.
2. Edit: set `waiting_on: {reason: "Waits for <prev-phase-id> (<prev-phase-title>) to complete.", timestamp: "<current ISO>", by: ["<children[i-1]>"]}`.
3. The watcher mirrors the change automatically.

Phase 1 (`children[0]`) stays `waiting_on: null` — it dispatches first. The
poller auto-clears `waiting_on` and releases phase N+1 once phase N reaches
Done / Cancelled.

**Skip this step ONLY when phases are genuinely independent** (different
domains, no shared state, can ship in any order). Default = sequential.
If you skip, explain in a comment on the epic.

### `waiting_on.by[]` is the IMMEDIATE blocker only — never list transitive blockers

Phase 3 lists `["children[1]"]` (Phase 2). It does NOT list Phase 1, even
though Phase 1 must ship before Phase 2 can ship. The chain Phase 3 → Phase
2 → Phase 1 is computed automatically by the poller + dashboard from each
card's direct blocker; restating the upstream chain in `by[]` is redundant
data that drifts the moment the chain is reorganized.

Same rule applies outside epics: when card A is waiting on card B which is
waiting on card C, A's `waiting_on.by[]` is `["B"]` only — NOT `["B", "C"]`.

---

## Step 4 — Return control to the orchestrator

You are a sub-skill. The orchestrator (`danx-next`) called you to set
up the linkage and now expects you to return so it can continue the
normal workflow.

Do NOT call `danxbot_complete` from this skill — the orchestrator owns
that signal. Do NOT move the epic to Done — the epic stays In Progress
until all phase cards reach Done.

After your last `Edit`, simply stop. The orchestrator's flow will see
`children[]` non-empty on its next read and skip Step 3 (Epic Split)
entirely, then jump to the first incomplete phase card and pick
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
epic), abort and let the orchestrator move the epic to Blocked.
Append a comment to the epic's YAML describing the ambiguity:

```
## Epic linkage — ambiguous

`danx-epic-link` could not unambiguously identify this epic's phase
cards. Candidates examined: <list of ids + titles + reasoning>.
Human review needed to set `parent_id` on the right children + the
matching `children[]` on this epic.
```

Then save and signal Blocked via the normal `danx-next` Step 10
flow.
