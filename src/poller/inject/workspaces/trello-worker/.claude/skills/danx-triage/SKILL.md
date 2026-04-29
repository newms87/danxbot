---
name: danx-triage
description: Audit Trello cards against code + git history. Classify into six terminal states, ICE-score kept cards, detect dependencies, group epics, reorder lists by priority, and print a report table.
argument-hint: <optional free-form scope prompt>
---

# Danx Triage

You are the triage agent. You audit Trello cards against the current codebase and git log, classify each card, score the keepers, resolve dependencies + epic groupings, reorder the lists by priority, and print a report table before self-terminating.

Config references: `.claude/rules/danx-trello-config.md` (Trello IDs), `.claude/rules/danx-repo-config.md` (repo commands). Never hardcode IDs.

Spec: `docs/superpowers/specs/2026-04-21-triage-skill-design.md`.

---

## Scope

| Invocation | Scope |
|---|---|
| `/danx-triage` | Review + Action Items lists, skip `Triaged` cards, skip cards <24h old |
| `/danx-triage <prompt>` | Agent interprets the free-form prompt and sets scope accordingly |

**Scope override keywords** — any of these in the prompt flip the matching default:

- `re-triage`, `force`, `all`, `refresh` → include already-`Triaged` cards
- `include new`, `all ages` → ignore the 24h age floor
- Explicit list names (`todo`, `in progress`, `done`, `cancelled`) → restrict to those
- `only <label>` → filter to cards carrying that label
- `older than N days` → further age restriction

When the prompt is ambiguous, pick the more conservative scope and state it in the report.

**Epic grouping is scope-transparent.** If a phase child is in scope but its epic parent lives in a different list, include the parent automatically so the group is processed atomically.

---

## Step 1 — Resolve Scope and Print Plan

1. Read `.claude/rules/danx-trello-config.md` for board ID and list IDs.
2. Read `.claude/rules/danx-repo-config.md` for the repo name.
3. Interpret the invocation prompt (or apply defaults).
4. Print the resolved scope to the session so the user can see your interpretation before any writes begin. Format:
   ```
   Scope (resolved): <lists> | <filters> | skip-triaged=<bool> | age-floor=<value>
   ```

---

## Step 2 — Ensure the `Triaged` Label Exists

1. Read `triaged` label ID from `.claude/rules/danx-trello-config.md`. If present, use it.
2. If missing, call `mcp__trello__get_board_labels` to check the board. If a label named `Triaged` exists, cache its ID locally for this run and write it back to `<repo>/.danxbot/config/trello.yml` under `labels.triaged`.
3. If still missing, call `mcp__trello__create_label(boardId, name="Triaged", color="sky")`. Cache the returned ID and write it to `trello.yml`.

**`trello.yml` update format** — add (or update) the `labels.triaged: <id>` line. Preserve all other keys.

---

## Step 3 — Fetch Cards in Scope

1. For each list in scope, call `mcp__trello__get_cards_by_list_id`.
2. For each fetched card, capture: `id`, `name`, `idLabels`, `idList`, `idShort`, `shortUrl`, `shortLink`, `desc`, `dateLastActivity`, `due`, and Trello's `dateCreated` (first 8 chars of `id` are hex timestamp — convert to a Date).
3. Filter out:
   - Cards carrying the `Triaged` label, unless the scope includes re-triage.
   - Cards with `dateCreated` within the last 24h, unless the scope disables the age floor.
4. For any phase child in the remaining set, if its epic parent is not already in scope, fetch the parent via `mcp__trello__get_card` and include it in the triage set as well (so the group is atomic). Mark the parent as "pulled-in for grouping" in the report.

---

## Step 4 — Per-Card Audit (parallel subagents)

**Dispatch one subagent per card via the `Agent` tool with `subagent_type: "general-purpose"`. Send all subagent calls in a single message so they run in parallel — this is the entire point of the parallel design and is what keeps the orchestrator's context small and the run fast.**

The orchestrator does NOT read full card context, run git, or read code. It only:

1. Builds the per-card subagent prompt from the card stub fetched in Step 3.
2. Dispatches all subagents in parallel.
3. Collects each subagent's structured return value.
4. Hands the aggregated results to Step 5+.

### Batching for rate limits

Cap concurrency at **3 subagents per batch**. If the in-scope set exceeds 3, dispatch in waves of 3, awaiting each wave before starting the next. Within a wave, all dispatches go in one message (true parallel). Trello's ~300 req / 10s budget is never the bottleneck — subagent token cost and orchestrator output channel are. Three keeps each wave's aggregated tool-result payload bounded and lets the operator inspect early waves before committing to the rest.

### Subagent contract

Each subagent gets this prompt (substitute `<...>` placeholders):

```
You are a Triage subagent for ONE Trello card. Audit it and return a compact JSON result.

Card:
  id: <cardId>
  shortLink: <shortLink>
  shortUrl: <shortUrl>
  name: <name>
  idList: <idList>
  idLabels: <idLabels-array>
  dateCreated: <iso>

Repo: <repoName>
Triaged label ID: <triagedLabelId>
Needs Help label ID: <needsHelpLabelId>

Run steps 4a–4h exactly as defined in the danx-triage SKILL.md (read full card context, find evidence, classify, ICE-score keepers, detect deps, post the triage comment with the `<!-- danxbot-triage -->` marker, apply the Triaged label — and Needs Help if Ambiguous — and MOVE the card to its terminal list when state is Complete/Obsolete/Duplicate/Ambiguous).

The orchestrator passes you the target list IDs for terminal moves:
  Done list ID: <doneListId>
  Cancelled list ID: <cancelledListId>
  Needs Help list ID: <needsHelpListId>

Do NOT reorder Keep/Partial cards (the orchestrator owns the topo + ICE sort across the full set — your card stays in its source list, position untouched). Return ONLY this JSON object on your final message, nothing else:

{
  "cardId": "<id>",
  "shortLink": "<shortLink>",
  "shortUrl": "<shortUrl>",
  "name": "<name>",
  "idList": "<idList>",
  "state": "Keep|Partial|Complete|Obsolete|Duplicate|Ambiguous",
  "ice": { "total": <int|null>, "I": <int|null>, "C": <int|null>, "E": <int|null> },
  "deps": { "explicit": ["<shortLink>", ...], "inferred": ["<shortLink>", ...] },
  "epic": { "isParent": <bool>, "parentShortLink": "<shortLink>|null", "phaseNumber": <int|null> },
  "evidence": { "git": ["<sha>", ...], "code": ["<file:line>", ...] },
  "error": "<string|null>"
}

If anything fails for THIS card, return the JSON with state="Ambiguous" and error="<message>" — do NOT throw. The orchestrator counts errors from this field.
```

### Subagent must do (steps run inside the subagent, not the orchestrator)

### 4a. Read Full Card Context

- `mcp__trello__get_card(cardId)` — full card, if not already fetched
- `mcp__trello__get_card_comments(cardId)` — ALL comments
- `mcp__trello__get_acceptance_criteria(cardId)` — AC items (each has `id`, `name`, `state`)
- Other checklists via `mcp__trello__get_checklist_items` if the card references Implementation Phases or Progress

Never work from title alone. Re-read every card in full.

### 4b. Find Evidence (git log first, code fallback)

1. Derive 3-5 keyword variants from card title + AC subjects (proper nouns, feature names, file bases).
2. Run `git log --oneline -500 --since="<card.dateCreated>"` (whichever limit yields fewer). Grep the commit subjects for your keywords.
3. **If any commit subject sounds relevant** → `git show <sha>` for each candidate. Read the diff. Decide whether it implements part or all of the card's AC.
4. **If zero commit subjects sound relevant** → skip git. Open the files named in the card's "Key files" section (or obvious matches inferred from the description). Read the current code. Judge whether the described behavior is present.

Do NOT run `git log -S` pickaxe searches. Do NOT diff unrelated commits. Keep evidence gathering cheap.

### 4c. Classify into One of Six States

| State | When |
|---|---|
| **Keep** | Still relevant, no meaningful progress in git or code |
| **Partial** | Some AC items satisfied; others outstanding |
| **Complete** | All AC items satisfied; behavior is live in code |
| **Obsolete** | Intentionally superseded by a different approach, or no longer desired |
| **Duplicate** | Another card (in any list) covers the same work |
| **Ambiguous** | Evidence inconclusive; card too vague; can't decide |

### 4d. ICE Score (Keep and Partial only)

Same rubric as the ideator agent. Each 1-10, product is max 1000.

- **Impact (1-10)** — How many users benefit and how much?
- **Confidence (1-10)** — How likely is the stated approach to work?
- **Ease (1-10)** — How fast can this land?

**ICE = Impact × Confidence × Ease.** Each component MUST have a one-sentence justification — no bare numbers.

Skip ICE for Complete / Obsolete / Duplicate / Ambiguous.

### 4e. Detect Dependencies

Scan description, AC items, and all comments for:

- Literal phrases: `depends on`, `blocked by`, `after card`, `requires`, `needs`
- Trello card URLs or `shortLink` references
- Obvious same-file/same-symbol overlap with another card

For inferred dependencies (no explicit signal but the agent deduced it), append this line to the card description via `mcp__trello__update_card_details`:

```
Depends on: <shortUrl> — <reason>
```

Preserve all other description content — fetch the existing description, append, write it back.

**Cycle handling:** If A depends on B and B depends on A, drop the lower-confidence edge (prefer explicit over inferred, prefer newer over older). Note the dropped edge in both cards' Triage comments.

### 4f. Post Triage Comment

Via `mcp__trello__add_comment(cardId, text=...)`:

```
## Triage — <YYYY-MM-DD>

**State:** <Keep | Partial | Complete | Obsolete | Duplicate | Ambiguous>

**ICE:** <total> (<I>×<C>×<E>)
- Impact (<I>): <one sentence>
- Confidence (<C>): <one sentence>
- Ease (<E>): <one sentence>

(omit the ICE block for non-scored states)

**Evidence:**
- Git: <shas comma-separated, or "no relevant commits in last 500">
- Code: <file:line references, or "as described in card">

**Dependencies:**
- Depends on: <shortUrl> — <reason>
- Blocks: <shortUrl>
- (or "None")

**Decision:** <1-2 sentences explaining the state>

<!-- danxbot-triage -->
```

The `<!-- danxbot-triage -->` marker is how future triage runs recognize prior output. Never omit it.

### 4g. Apply `Triaged` Label

`mcp__trello__update_card_details(cardId, labels=[...existing_label_ids, triaged_label_id])`.

De-duplicate if the label is already present. For **Ambiguous** cards, also add the `Needs Help` label ID.

### 4h. Apply terminal move (subagent, inline)

After steps 4a–4g succeed, the subagent moves the card itself based on classification:

| State | Move via `mcp__trello__move_card` |
|---|---|
| `Keep` / `Partial` | NO MOVE — leave in source list (orchestrator's reorder pass handles position) |
| `Complete` | `move_card(cardId, listId=<doneListId>, position="top")` |
| `Obsolete` / `Duplicate` | `move_card(cardId, listId=<cancelledListId>, position="top")` |
| `Ambiguous` | `move_card(cardId, listId=<needsHelpListId>, position="top")` |

`position: "top"` is mandatory on every move (per the global Trello rule). Always include `boardId` if the move-tool supports it.

If the move call fails, do NOT retry silently — set `error` in the returned JSON to `move_failed: <reason>` and keep the rest of the result intact. The orchestrator counts it in the `Errors` section of the report.

### 4i. Wave gating

Within a wave (≤3 parallel subagents), no per-card sleep. Between waves, no sleep needed either — three concurrent subagents issuing ~10 Trello calls each over ~30-60s wall is well below rate limits.

---

## Step 5 — Resolve Epic Groups

Replace each `(epic parent, phase 1, phase 2, ...)` tuple in the Keep/Partial set with a single virtual group node:

- Group's ICE = max(ICE across all members)
- Phase order inside the group is fixed: parent first, then phase cards sorted by `Phase N:` number parsed from title
- Phase cards are NEVER individually re-sorted across the list

**Epic identification:**
- Parent: carries the `Epic` label
- Phase child: title starts with `<Epic Title> > Phase N:` AND the epic's `shortLink` appears in the phase card's description

---

## Step 6 — Topological Sort + ICE Sort

Per list (Review, Action Items, or whatever's in scope):

1. Build the dependency graph: nodes = single cards + epic groups, edges = `depends on` relationships.
2. Assign layers:
   - Nodes with no incoming edges → layer 0
   - Nodes whose deps are all in layers ≤ k → layer k+1
3. Within each layer, sort by ICE descending. Ties: epic groups before single cards, then alphabetical by title.
4. If a cycle remains, drop the weakest-confidence edge (see 4e). Record the drop in the Triage comments of both cards BEFORE the reorder write.
5. Final list order = concatenation of layers, layer 0 at top.

---

## Step 7 — Verify Terminal Moves

Terminal moves (Complete → Done, Obsolete/Duplicate → Cancelled, Ambiguous → Needs Help) are applied INLINE by each subagent in step 4h, so by the time the orchestrator reaches Step 7 the source lists already contain only Keep/Partial cards.

Verification only:
1. For each subagent result with state in `{Complete, Obsolete, Duplicate, Ambiguous}`, ensure `error` is not `move_failed: ...`. Any move-failed result is surfaced in the report's `### Errors` section and skipped from the reorder pass.
2. No re-issue of moves here — that would double-move cards already at the top of their terminal lists.

---

## Step 8 — Apply Reorder Writes

For each list in scope:

1. Iterate the final sort order top-to-bottom.
2. For each card (or each phase card inside an epic group, in phase order):
   - `mcp__trello__move_card(cardId, boardId, listId=<same list>, position="bottom")`
   - Sleep 100ms
3. Because each card is sent to `bottom`, iterating top→bottom builds the exact final order in N writes.

---

## Step 9 — Print the Triage Report

Print this block as your last output before self-termination. This is the user's only view into what you did — make it self-contained.

```markdown
## Triage Report — <ISO timestamp>

Scope (resolved): <human-readable interpretation>
Cards examined: N | Triaged: X | Skipped (already Triaged): Y | Skipped (<24h old): Z | Errors: E

| # | Card | List → Target | State | ICE | Deps | Epic | Notes |
|---|------|---------------|-------|-----|------|------|-------|
| 1 | [Feature] Widget foo | Review → Review (#1) | Keep | 480 (8×6×10) | — | — | — |
| 2 | [Bug] Fix baz | Review → Done | Complete | — | — | — | Implemented by a1b2c3d |
| 3 | Auth epic | Review → Review (#3) | Keep | 630 | depends on #1 | Parent | 3 phases below |
| 3a | Auth > Phase 1 | Review → Review (#4) | Keep | 540 | (epic) | Phase 1 | — |
| … |

### Cycles Resolved
- A ↔ B: dropped A→B (inferred, lower confidence)

### Errors
- [card title]: <error message>
```

Rows appear in final sort order. Epic phase children indent directly below their parent (`3a`, `3b`, …). If no cycles or errors occurred, omit those sections.

---

## Robustness Rules

### Idempotence

Already-triaged cards (carry `Triaged` label AND latest comment has `<!-- danxbot-triage -->`) are skipped in default scope. If the label is present but the marker is missing, treat it as a failed prior run and re-triage.

### Human-override immunity

If the `<!-- danxbot-triage -->` marker exists in prior comments but the `Triaged` label was removed, the human un-tagged this card. Re-triage it from scratch.

### Failure Isolation

A single card failure (API error, unreadable commit, missing file) does NOT abort the run. Record the error in the report's `Errors:` count and list it in the `### Errors` section at the end. Continue with remaining cards.

### Interactive Approval Gate (reorder only)

Terminal moves (Complete/Obsolete/Duplicate/Ambiguous) are committed by subagents in step 4h and CANNOT be gated — by design, the subagent owns its full lifecycle. The approval gate now exists only for **Step 8 reorder writes**, which can shuffle the priority order of every Keep/Partial card in the source list.

If the session is interactive — detected before Step 8 — print the full Triage Report table as a preview and ask:

```
Apply the reorder writes? (yes to apply, anything else leaves Keep/Partial in their current order)
```

Only run Step 8 after explicit `yes` / `go` / `do it` / `approved`. Any other response keeps the source list in its existing order — terminal moves already committed by subagents are NOT undone.

When invoked non-interactively (by another agent, `/loop`, or a scheduled run), skip the approval gate. Detect via `$DANXBOT_NONINTERACTIVE=1` or the absence of a TTY on stdin — fall back to "interactive" if detection is ambiguous.

### Never Touch Out-of-Scope Cards

Only cards in the resolved scope (plus epic parents pulled in for grouping) may be read, labeled, or moved. Never triage a card outside the set even if you notice a problem with it — note it in the report's notes column if relevant.

---

## Step 10 — Signal Completion

If dispatched by danxbot (the `danxbot_complete` MCP tool is available), call it once with `status: "completed"` and `summary: "Triaged N cards — top X promoted to ToDo"`. The worker handles process lifecycle.

If invoked interactively (no `danxbot_complete` tool present), print "Triage complete." and stop. Do not invoke any external termination script.
