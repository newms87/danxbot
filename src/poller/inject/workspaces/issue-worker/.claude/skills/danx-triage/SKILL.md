---
name: danx-triage
description: Audit local issue YAMLs against code + git history. Classify into six terminal states, ICE-score keepers, detect dependencies, group epics, and print a report.
argument-hint: <optional free-form scope prompt>
---

# Danx Triage

You audit local issue YAMLs at `<repo>/.danxbot/issues/open/`. For each card you classify state, ICE-score keepers, detect dependencies, group epics, edit the YAML's `triaged` field (and `status` for terminal cases), and call `danx_issue_save`. The worker pushes status moves and labels to the tracker.

You read, edit, and save YAMLs. You do NOT make tracker calls.

Config references: `.claude/rules/danx-repo-config.md` (repo commands).

---

## Scope

Default scope: every `<repo>/.danxbot/issues/open/*.yml` whose `triaged.timestamp` is empty AND whose file mtime is ≥24h old.

| Invocation | Scope |
|---|---|
| `/danx-triage` | All open YAMLs, skip already-triaged, skip <24h |
| `/danx-triage <prompt>` | Interpret the free-form prompt and adjust scope |

**Scope override keywords:**

- `re-triage` / `force` / `all` / `refresh` → include cards whose `triaged.timestamp` is non-empty
- `include new` / `all ages` → ignore the 24h age floor
- Status filter (`todo`, `in progress`, `review`, etc.) → restrict to YAMLs with that `status`
- `only <type>` → filter by `type` field (`Bug` / `Feature` / `Epic`)
- `older than N days` → tighten age floor

When ambiguous, pick the more conservative scope and state it in the report.

**Epic grouping is scope-transparent.** If a phase YAML (parent_id non-null) is in scope but its parent epic is not, include the parent automatically.

---

## YAML Fields You Edit

| Field | When |
|---|---|
| `triaged.timestamp` | Set to current ISO time on every triage (e.g. `2026-05-03T14:32:00Z`). Worker derives the Triaged label from `timestamp !== ""`. |
| `triaged.status` | One of `Keep` \| `Partial` \| `Complete` \| `Obsolete` \| `Duplicate` \| `Ambiguous`. |
| `triaged.explain` | Human-readable 1-2 sentences explaining the decision. Include ICE if applicable. |
| `status` | Move terminal cases: `Complete` → `Done`, `Obsolete`/`Duplicate` → `Cancelled`, `Ambiguous` → `Needs Help`. Keep/Partial cases: leave unchanged. |
| `description` | Append `Depends on: <id> — <reason>` line for inferred deps. Preserve existing content. |
| `comments[]` | Append a triage summary comment (no `id`). |

Append new comments without an `id` field — the worker handles tracker push semantics.

---

## Step 1 — Resolve Scope and Print Plan

1. Read `.claude/rules/danx-repo-config.md` for the repo name + test commands.
2. Glob `<repo>/.danxbot/issues/open/*.yml`.
3. Apply the scope filter.
4. Print:
   ```
   Scope (resolved): <count> cards | filters: <filters> | skip-triaged=<bool> | age-floor=<value>
   ```

---

## Step 2 — Per-Card Audit (parallel subagents)

Dispatch one subagent per card via `Agent` with `subagent_type: "general-purpose"`. Send all in one message — true parallel.

The orchestrator does NOT read full card YAML, run git, or read code. It only:

1. Builds the per-card subagent prompt from the YAML's filename + a stub.
2. Dispatches subagents in parallel.
3. Collects each subagent's structured return value.

### Batching for cost

Cap concurrency at **3 subagents per batch**. >3 cards → dispatch in waves of 3, awaiting each wave before the next. Within a wave, all dispatches in one message.

### Subagent contract

Each subagent prompt (substitute `<...>`):

```
You are a Triage subagent for ONE issue YAML. Audit it and return a compact JSON result.

YAML path: <absolute path to .danxbot/issues/open/<filename>.yml>
Repo: <repoName>

Run steps 2a–2g exactly as defined in danx-triage SKILL.md (read full YAML, find evidence, classify, ICE-score keepers, detect deps, edit triaged.{timestamp,status,explain}, edit status for terminal cases, append triage comment, call danx_issue_save).

Return ONLY this JSON object on your final message:

{
  "id": "<id>",
  "name": "<title>",
  "state": "Keep|Partial|Complete|Obsolete|Duplicate|Ambiguous",
  "saved": <bool>,
  "ice": { "total": <int|null>, "I": <int|null>, "C": <int|null>, "E": <int|null> },
  "deps": { "explicit": ["<id>", ...], "inferred": ["<id>", ...] },
  "epic": { "isParent": <bool>, "parentId": "<id>|null", "phaseNumber": <int|null> },
  "evidence": { "git": ["<sha>", ...], "code": ["<file:line>", ...] },
  "error": "<string|null>"
}

`saved: true` only when `danx_issue_save` returned `{saved: true}`. If anything fails (YAML parse error, save validation failure, internal error), return `state: "Ambiguous"`, `saved: false`, and `error: "<message>"` — do NOT throw. Do NOT call `danx_issue_save` on a YAML you couldn't parse.
```

### Subagent steps (run inside the subagent)

#### 2a. Read Full YAML

`Read <path>` — capture every field. Never work from filename alone.

#### 2b. Find Evidence (git log first, code fallback)

1. Derive 3-5 keyword variants from `title` + AC subjects (proper nouns, feature names, file bases).
2. `git log --oneline -500 --since="<file mtime - 30d>"`. Grep subjects for keywords.
3. Any subject sounds relevant → `git show <sha>`. Read the diff. Decide whether it implements part or all of `ac[]`.
4. Zero relevant subjects → skip git. Open files named in description's "Key files" section. Judge whether described behavior is present.

Don't run `git log -S` pickaxes. Don't diff unrelated commits.

#### 2c. Classify into One of Six States

| State | When |
|---|---|
| **Keep** | Still relevant, no meaningful progress |
| **Partial** | Some `ac[]` items satisfied; others outstanding |
| **Complete** | All `ac[]` satisfied; behavior live in code |
| **Obsolete** | Superseded by a different approach, or no longer desired |
| **Duplicate** | Another card covers the same work |
| **Ambiguous** | Evidence inconclusive; can't decide |

#### 2d. ICE Score (Keep + Partial only)

Each 1-10, product max 1000.

- **Impact** — How many users benefit and how much?
- **Confidence** — How likely is the stated approach to work?
- **Ease** — How fast can it land?

`ICE = Impact × Confidence × Ease`. Each component MUST have a one-sentence justification — no bare numbers.

Skip ICE for Complete / Obsolete / Duplicate / Ambiguous.

#### 2e. Detect Dependencies

Scan `description`, `ac[]`, `comments[]` for:

- Phrases: `depends on`, `blocked by`, `after card`, `requires`, `needs`
- Mentions of another issue's `id` (e.g. `ISS-42`)
- Same-file / same-symbol overlap with another card

For inferred deps (no explicit signal but deduced): append to `description`:

```
Depends on: <id> — <reason>
```

Preserve the rest of `description` verbatim.

**Cycle handling:** A depends on B, B depends on A → drop the lower-confidence edge (prefer explicit > inferred, newer > older). Note the dropped edge in both cards' triage comment.

#### 2f. Edit the YAML

1. Set `triaged.timestamp` to current ISO time (`<YYYY-MM-DDTHH:MM:SSZ>`).
2. Set `triaged.status` to the classification.
3. Set `triaged.explain` to 1-2 sentences explaining the decision (include ICE breakdown if scored).
4. **Terminal moves** — edit `status` field:
   | Classification | New `status` |
   |---|---|
   | `Keep` / `Partial` | unchanged |
   | `Complete` | `Done` |
   | `Obsolete` / `Duplicate` | `Cancelled` |
   | `Ambiguous` | `Needs Help` |
5. Append a triage comment to `comments[]`. Logical shape:
   - `author: "danxbot-triage"`
   - `timestamp: <current ISO>`
   - `text:` a multi-line markdown body with these sections:
     - `## Triage — <YYYY-MM-DD>`
     - `**State:** <state>`
     - `**ICE:** <total> (<I>×<C>×<E>)` followed by one bullet per component with the one-sentence justification (omit the entire ICE block for non-scored states)
     - `**Evidence:**` — bullet list: `Git: <shas or 'no relevant commits'>`, `Code: <file:line references or 'as described'>`
     - `**Dependencies:**` — bullet list: `Depends on: <id> — <reason>`, `Blocks: <id>`, or a single `None` line
     - `**Decision:** <1-2 sentences>`
   - No `id` field on the new comment — worker stamps it on push.

#### 2g. Save

`danx_issue_save({id: "<id>"})`. Check the response — `{saved: false}` means the YAML failed validation; report the error in the JSON return value.

For terminal moves (Done / Cancelled), the worker moves the file `open/` → `closed/` as part of save.

---

## Step 3 — Resolve Epic Groups (orchestrator)

Replace each `(epic parent, phase 1, phase 2, ...)` tuple in the Keep/Partial set with a single virtual group node:

- Group ICE = max(ICE across members)
- Phase order inside group: parent first, then phases sorted by `Phase N:` parsed from `title`
- Phases are NEVER individually re-sorted

**Epic identification:**
- Parent: `type === "Epic"`
- Phase: `parent_id` matches the epic's `id` AND title starts with `<Epic Title> > Phase N:`

---

## Step 4 — Topological Sort + ICE Sort (orchestrator, in-memory)

Per the Keep/Partial set:

1. Build dependency graph from `description` "Depends on:" lines + epic groupings.
2. Assign layers (no incoming edges → layer 0; deps in layers ≤k → layer k+1).
3. Within each layer: sort by ICE desc. Ties: epic groups before single cards, then alphabetical.
4. Cycle remaining → drop weakest-confidence edge. Record drop in both cards' triage comments before reorder.
5. Final order = concatenation of layers, layer 0 first.

This is REPORT order. The current YAML model carries no list-position field, so the orchestrator does NOT issue any reorder writes — the report is the priority signal.

---

## Step 5 — Print the Triage Report

Last output before completion. Self-contained.

```markdown
## Triage Report — <ISO timestamp>

Scope (resolved): <human-readable interpretation>
Cards examined: N | Triaged: X | Skipped (already triaged): Y | Skipped (<24h): Z | Errors: E

| # | Card | Status → New | State | ICE | Deps | Epic | Notes |
|---|------|--------------|-------|-----|------|------|-------|
| 1 | [Feature] Widget foo | ToDo → ToDo | Keep | 480 (8×6×10) | — | — | — |
| 2 | [Bug] Fix baz | Review → Done | Complete | — | — | — | Implemented by a1b2c3d |
| 3 | Auth epic | Review → Review | Keep | 630 | depends on #1 | Parent | 3 phases below |
| 3a | Auth > Phase 1 | Review → Review | Keep | 540 | (epic) | Phase 1 | — |

### Cycles Resolved
- A ↔ B: dropped A→B (inferred, lower confidence)

### Errors
- <card title>: <error message>
```

Rows in priority order. Phase children indent under parent (`3a`, `3b`, …). Omit empty Cycles / Errors sections.

---

## Robustness Rules

### Idempotence

A YAML with `triaged.timestamp` non-empty is skipped in default scope. Re-triage scopes ignore the field.

### Failure Isolation

Single-card failure (parse error, missing file, save rejection) does NOT abort the run. Record in the report's `Errors` count + section. Continue.

### Never Touch Out-of-Scope YAMLs

Only YAMLs in resolved scope (plus epic parents pulled in for grouping) may be read or edited. Never triage a card outside the set even if you notice a problem with it — note in the report's notes column.

---

## Step 6 — Signal Completion

Call `danxbot_complete({status: "completed", summary: "Triaged N cards — top X promoted"})`.

If the environment is broken (MCP missing, Bash failing, auth rejected), use `status: "critical_failure"` per `.claude/rules/danx-halt-flag.md`. For card-specific blockers (a single YAML fails to parse), continue triaging the rest and surface in the Errors section.
