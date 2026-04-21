# Triage Skill — Design

**Status:** Approved, pending implementation plan
**Date:** 2026-04-21
**Author:** Dan (brainstormed with Claude Opus 4.7)

## Summary

A new autonomous `/danx-triage` skill that audits Trello cards against the current codebase and git history, classifies each into one of six terminal states, scores every kept card with ICE, detects inter-card dependencies, groups epics atomically, and reorders the affected lists by priority. Output is a single markdown report table summarizing every card's decision.

Default scope is the **Review** and **Action Items** lists. A free-form prompt argument lets the user (or another agent) broaden or narrow the scope; the agent's interpretation of that prompt is echoed in the report for auditability.

## Motivation

Cards in Review and Action Items accumulate over time. Many become obsolete because the underlying work was completed by other means, or superseded by a different approach, or duplicate ideas that landed on the board twice. Humans don't have time to manually re-read every card. Without triage, the lists rot — the top card is no longer the most important card, and agents picking up the top card waste cycles on stale work.

Triage keeps the lists honest:
- Completed work exits to Done so agents don't re-implement it.
- Obsolete / duplicate cards exit to Cancelled.
- Live work is ICE-scored, dependency-ordered, and sorted so the top card is always the next thing to do.
- Ambiguous cards route to Needs Help with a specific question instead of silently aging.

## Non-Goals

- Not a replacement for `/danx-ideate`. Ideate generates new cards; triage audits existing ones. They're complementary: ideate fills Review, triage keeps Review tidy.
- Not a replacement for `/flow-code-review`. Triage decides *whether to work on the card at all*; code review decides *whether the implementation is good*.
- Not a way to delete cards. Triage only moves cards between existing lists and annotates them. Deletion is a human decision.
- Not a background job. Triage is invoked on demand (human, other agent, or a scheduled `/loop`). The poller does not run it automatically.

## High-Level Architecture

The skill runs inside a single Claude Code session. No subagents. The session is the orchestrator and does all the work inline, because every step needs the full card context and the full running dependency graph in memory.

```
/danx-triage [prompt]
      │
      ▼
┌──────────────────────────────────────────┐
│  1. Resolve scope                        │
│  2. Fetch cards in scope                 │
│  3. For each card (serial):              │
│        - read card + comments + AC       │
│        - find related commits / code     │
│        - classify (6 states)             │
│        - ICE score                       │
│        - detect dependencies             │
│        - queue Trello mutations          │
│        - post Triage comment             │
│        - apply Triaged label             │
│  4. Resolve epic groups                  │
│  5. Topological sort + ICE sort          │
│  6. Apply queued terminal moves          │
│  7. Apply queued reorder in each list    │
│  8. Print Triage Report table            │
│  9. Self-terminate                       │
└──────────────────────────────────────────┘
```

All reads happen before any writes. The agent builds a full plan in memory, then executes the mutations in one pass.

## File Layout

**Created**

| Path | Purpose |
|---|---|
| `.claude/skills/danx-triage/SKILL.md` | Project-level skill definition (this repo's own invocation) |
| `src/poller/inject/skills/danx-triage/SKILL.md` | Copy injected into every connected repo by the authoritative poller sync |
| `docs/superpowers/specs/2026-04-21-triage-skill-design.md` | This document |

**Edited**

| Path | Change |
|---|---|
| `~/.claude/rules/trello.md` | Add `Triaged` (sky) to the required-labels list in the "Board Setup — List Creation Order" section |
| `.claude/skills/setup/SKILL.md` | Step 4 — add `Triaged` to expected labels + color mapping |

No changes to `src/poller/index.ts`: the inject sync is authoritative and directory-driven, so a new `src/poller/inject/skills/danx-triage/` directory is propagated automatically on the next poll tick.

## Invocation & Scope

**Usage:** `/danx-triage [free-form prompt]`

The prompt argument is free text. The agent parses it to resolve scope. The agent MUST echo its interpretation in the final report under "Scope (resolved): ...". If no prompt is given, default scope is Review + Action Items.

**Scope defaults (when no prompt):**
- Lists: Review, Action Items
- Skip cards already carrying the `Triaged` label
- Skip cards created in the last 24 hours
- Include epic parent cards even if they live outside the named lists, when any of their phase children are in scope

**Scope override keywords (any prompt containing these):**
- `re-triage`, `force`, `all`, `refresh` → re-triage cards regardless of existing `Triaged` label
- `include new`, `all ages` → ignore the 24h age floor
- Explicit list names → use only those lists
- `only <label>` → filter to cards with that label
- `older than N days` → further restrict by age

When the prompt is ambiguous, the agent picks the most conservative interpretation (smaller scope, preserve `Triaged` skip) and states the choice in the report.

## Per-Card Workflow

For each card in scope, in the order the Trello API returns them (position order within each list, lists iterated in scope order), the agent runs this sequence serially:

### 1. Read

- `get_card(cardId)` — name, description, labels, list, createdAt, shortUrl, shortLink
- `get_card_comments(cardId)` — all comments
- `get_acceptance_criteria(cardId)` — AC checklist items
- `get_checklist_items` for any other checklists (Implementation Phases, Progress)

### 2. Find Evidence

Run in this order; stop at the first step that yields a confident answer.

1. **Git log search.** `git log --oneline -500` (or `--since=<card.createdAt>` if the card is older than 500 commits). Derive 3-5 keyword variants from the card title + AC subjects. Grep the commit messages for those keywords.
2. **If any commit messages sound relevant**, fetch their diffs with `git show <sha>` and read what changed. Correlate against the card's AC.
3. **If zero commit messages sound relevant**, open the files named in the card's "Key files" section (or inferred from the description). Read the current code and judge whether the described behavior is present.

The agent does NOT run semantic pickaxe searches (`git log -S`) or broad file-path filters. Keep it fast. If simple grep doesn't find the work, trust that the code read is the source of truth.

### 3. Classify into One of Six States

| State | When |
|---|---|
| **Keep** | Still relevant, no meaningful progress in git or code |
| **Partial** | Some AC items satisfied by recent commits or already-present code; others outstanding |
| **Complete** | All AC items satisfied; behavior is live in the code |
| **Obsolete** | Work was intentionally superseded by a different approach, or is no longer desired based on current architecture |
| **Duplicate** | Another card (in any list) covers the same work |
| **Ambiguous** | Evidence is inconclusive or the card itself is too vague to classify |

### 4. ICE Score (Keep and Partial only)

Use the same rubric as `/home/newms/web/danxbot-flytebot/.claude/agents/ideator.md`:

- **Impact (1-10)** — How many users benefit and how much?
- **Confidence (1-10)** — How likely is the stated approach to work?
- **Ease (1-10)** — How fast can this land?

**ICE = Impact × Confidence × Ease** (max 1000).

Each component requires a one-sentence justification — no bare numbers.

Cards in states Complete / Obsolete / Duplicate / Ambiguous do NOT get an ICE score; they're leaving the source list.

### 5. Detect Dependencies

Scan description, AC items, and all comments for:

- Literal phrases: "depends on", "blocked by", "after card", "requires", "needs"
- Trello card URLs or shortLinks pointing at other cards
- Same-named file paths / symbols as another card (weak signal — only flag if the overlap is obvious)

For inferred dependencies (agent deduced from content without an explicit signal), the agent MUST append a line to the card description:

```
Depends on: <card shortUrl> — <why>
```

This makes future triage deterministic and gives humans a chance to correct.

**Cycle handling:** If A depends on B and B depends on A, drop the edge with lower confidence (prefer explicit over inferred; prefer newer comment over older). Note the dropped edge in both cards' Triage comments.

### 6. Post Triage Comment

Via `add_comment`:

```markdown
## Triage — <YYYY-MM-DD>

**State:** <Keep | Partial | Complete | Obsolete | Duplicate | Ambiguous>

**ICE:** <total> (<I>×<C>×<E>)
- Impact (<I>): <one sentence>
- Confidence (<C>): <one sentence>
- Ease (<E>): <one sentence>

(omit ICE block for non-scored states)

**Evidence:**
- Git: <shas, or "no relevant commits in last 500">
- Code: <file:line references, or "as described">

**Dependencies:**
- Depends on: <cardUrl> — <reason>
- Blocks: <cardUrl>
- (or "None")

**Decision:** <1-2 sentences explaining the state>

<!-- danxbot-triage -->
```

The HTML marker is how future triage runs programmatically recognize prior triage output.

### 7. Apply `Triaged` Label

`update_card_details(cardId, labels=[<existing>, <triaged_label_id>])`.

If the label doesn't exist on the board (board was set up before triage was introduced), create it via `create_label(boardId, name="Triaged", color="sky")` on the first card and cache the returned ID for the rest of the run. Persist the new ID to `<repo>/.danxbot/config/trello.yml` so subsequent poller-synced runs read it from config.

### 8. Queue Trello Mutations

The agent does NOT move the card in steps 1-7. It records a planned move in memory:

- Complete → Done, position top
- Obsolete / Duplicate → Cancelled, position top
- Ambiguous → Needs Help, position top, plus apply `Needs Help` label
- Keep / Partial → stay in current list, position TBD (determined by the reorder pass)

All Trello writes (label application, comment post) that DON'T involve reordering can happen inline for responsiveness. Moves are queued.

## Priority Model (Final Reorder Pass)

Runs once after all cards are triaged. Per list in scope:

### 1. Collect

All `Keep` and `Partial` cards currently in the list. Exclude cards queued to move to Done/Cancelled/Needs Help — they're handled in the terminal-move phase.

### 2. Group Epics

Replace each (epic parent + phase children) set with a single virtual group node:
- Group's ICE = max(ICE across all members)
- Phase order inside the group is fixed: parent first, then Phase 1, Phase 2, …
- Phase cards are NEVER individually re-sorted across the list

An epic is identified by the `Epic` label on the parent; phase cards are identified by title prefix `<Epic Title> > Phase N:` AND the epic's shortLink present in the phase card's description.

### 3. Topological Layer

- Cards/groups with no incoming deps (no `depends on`) → layer 0
- Cards/groups depending only on layer 0 → layer 1
- Etc.

### 4. Sort Within Each Layer

By ICE descending. Ties broken by: epic groups before single cards, then alphabetical by title.

### 5. Cycle Resolution

If a cycle exists, drop the weakest-confidence edge (see step 5 of per-card workflow). Record the drop in both cards' Triage comments before the reorder write.

### 6. Apply Order

Iterate top-to-bottom through the computed order. For each card, call:

```
move_card(cardId, boardId, listId=<same list>, position="bottom")
```

Because `position: "bottom"` places each successive card after the previously-moved one, iterating top→bottom builds exact final order in N writes. A 100ms sleep between writes keeps us well under Trello's 300-req/10s rate limit.

### 7. Terminal Moves First

Before the reorder pass, move every card queued for Done / Cancelled / Needs Help to its terminal list (also `position: "top"`) so they don't pollute the source list when we compute the reorder plan.

## The Six Terminal States — Full Detail

| State | Action | Required side effects |
|---|---|---|
| **Keep** | Stay in current list, position set by reorder | Triaged label, Triage comment, ICE score in comment |
| **Partial** | Stay in current list, position set by reorder | Triaged label, Triage comment, check off satisfied AC items, optionally rewrite description to reflect remaining work |
| **Complete** | Move to Done, position top | Triaged label, Triage comment including `Completed by <shas>`, check off all AC items |
| **Obsolete** | Move to Cancelled, position top | Triaged label, Triage comment explaining what superseded it |
| **Duplicate** | Move to Cancelled, position top | Triaged label, Triage comment linking the canonical card's URL |
| **Ambiguous** | Move to Needs Help, position top | Triaged label AND Needs Help label, Triage comment including a specific question for the human |

## Final Report Table

Printed as the skill's last output. Self-contained — the reader can audit every decision without scrolling back through the session.

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
| 3b | Auth > Phase 2 | Review → Review (#5) | Keep | 540 | (epic) | Phase 2 | — |
| 3c | Auth > Phase 3 | Review → Review (#6) | Keep | 540 | (epic) | Phase 3 | — |
| 4 | Old analytics v1 | Review → Cancelled | Obsolete | — | — | — | Superseded by analytics v2 epic (#3) |
| 5 | Sketchy feature X | Review → Needs Help | Ambiguous | — | — | — | Need human confirm: keep or drop? |
| … |

### Cycles Resolved
- A ↔ B: dropped A→B (inferred, lower confidence)

### Errors
- [card title]: <error message>
```

Epic rows indent phase children directly below the parent (`3a`, `3b`, `3c`) in their fixed phase order. Rows appear in final sort order — the reader sees the new list top-to-bottom.

## The `Triaged` Label

**Color:** `sky` (Trello's light blue).

**Created at setup.** `.claude/skills/setup/SKILL.md` Step 4 adds `Triaged` to the expected labels list and the color mapping:

> Bug: red, Feature: green, Epic: purple, Needs Help: orange, **Triaged: sky**

`~/.claude/rules/trello.md` is also updated to include `Triaged` in the required-labels line of the "Board Setup" section.

**Runtime fallback.** If the skill runs against a board where `Triaged` doesn't exist (setup ran before this change was shipped), the skill:
1. Calls `create_label(boardId, name="Triaged", color="sky")` once
2. Writes the returned ID back to `<repo>/.danxbot/config/trello.yml` under `labels.triaged`
3. Proceeds

Subsequent runs (and the poller) pick up the cached ID from `trello.yml` without creating a duplicate.

## Robustness & Autonomy Rules

These are defaults the skill carries so it can run unattended.

### Idempotence

Re-running `/danx-triage` with no prompt is a no-op for already-`Triaged` cards. The agent identifies already-triaged cards by the `Triaged` label AND the `<!-- danxbot-triage -->` marker in the latest triage comment.

If the label is present but the marker is missing, the agent treats the card as needing re-triage (someone else applied the label manually or the prior run failed mid-way).

### Re-triage on Human Override

If the `Triaged` label was removed by a human since the last triage run (detected by marker-in-comment but label-missing), re-triage from scratch. The agent NEVER fights a human override.

### Rate Limiting

Trello allows 300 requests / 10s per token. The skill:
- Batches reads: one `get_cards_by_list_id` per list, then per-card reads
- Serializes writes
- Inserts a 100ms sleep between `move_card` calls and between `update_card_details` + `add_comment` pairs

Expected ceiling: ~20 cards per minute of triage work, comfortably under the limit.

### Failure Isolation

A single card failing (Trello API error, missing file, unreadable commit) does NOT abort the run. The agent records `Errors: E` in the report header and lists each error under `### Errors` at the end. The rest of the run proceeds.

### Dry-Run Preview (Interactive Invocation Only)

When invoked in a human-interactive session (TTY detected), the agent does all reads and classifications first, then prints a preview of the final report table and asks for explicit approval before writing any Trello mutations.

Approval phrases: `go`, `do it`, `approved`, `yes`, `proceed`. Any other response aborts without writing.

When invoked by another agent or a scheduled `/loop` (non-interactive), this approval step is skipped — the agent writes mutations immediately after classification. Detection: check whether STDIN is a TTY (`process.stdin.isTTY`) at skill start. Fall back to "interactive" if detection is ambiguous.

### Self-Termination

Same pattern as `/danx-next` and `/danx-ideate`. After the report is printed, run:

```
.claude/tools/danx-self-terminate.sh $PPID
```

The script checks `DANXBOT_EPHEMERAL` and handles lock file removal and process termination atomically. Always run the script — never assume session type.

## Open Knobs (Defaulted)

| Knob | Default | Override |
|---|---|---|
| Scope lists | Review + Action Items | Free-form prompt |
| Skip `Triaged` cards | On | Prompt keyword `re-triage` / `force` / `all` / `refresh` |
| 24h age floor | On | Prompt keyword `include new` / `all ages` |
| Git search window | 500 commits or since card creation, whichever is fewer | Not exposed — modify skill if changed |
| Interactive approval gate | On when TTY | Off when non-TTY |
| Inter-write sleep | 100ms | Not exposed |

## Alternatives Considered

### A. Running insertion (sort on every card)

Recompute list order after each card and call `move_card` for every affected position. Rejected: O(N²) Trello writes, noisy card history, and slow enough to hit rate limits at N > 30.

### B. Skip ICE, just sort by dependency layer + card age

Rejected: loses the ability to put a high-impact card ahead of a low-impact older card. ICE is cheap to compute inline and matches the Ideator's existing convention.

### C. Full semantic diff review of every commit

Rejected: too slow. The user's constraint was "just read the git log messages, only diff if the message sounds relevant." That captures 95% of the signal at 10% of the cost.

### D. Triage as a background poller job

Rejected: the user explicitly scoped this as on-demand. A background job can be layered on later via `/schedule` or `/loop` if desired, without changing the skill itself.

## Risks

1. **Bad classification.** The agent decides a card is Complete when it isn't, moves it to Done, and the work is lost.
   - Mitigation: Triage comment explicitly names the evidence (commits, file:line). Humans can review Done + reverse any wrong move. The `Triaged` label + comment marker make it trivial to grep for agent-touched cards.
   - Mitigation: Interactive preview gate when human is driving.

2. **Dependency graph wrong.** Agent infers a spurious dependency, blocks a high-priority card behind an unrelated one.
   - Mitigation: Inferred dependencies are written to the description so humans see them. Explicit dependencies beat inferred ones in cycle resolution.

3. **ICE inflation / deflation drift.** Agent's ICE scores diverge from the Ideator's scoring style.
   - Mitigation: Triage uses the exact same rubric text as the Ideator (copied verbatim into the skill).

4. **Trello rate limit hit during large triage.** Agent is killed mid-run.
   - Mitigation: 100ms sleeps + serialized writes keep us well below the ceiling for any realistic board size.
   - Mitigation: Mutations are idempotent (label application, comment post — Trello deduplicates on exact match). A restart resumes safely.

## Testing Strategy

Unit tests (Vitest, alongside existing `src/__tests__/`):
- ICE score formatter: assert `480 (8×6×10)` formatting
- Dependency detector: fixture card text → expected edges
- Topological layer builder: fixture graph → expected layer assignment
- Epic grouper: fixture set of cards → expected group membership
- Cycle resolver: A↔B fixture → expected dropped edge + report entry

Integration tests (against a scratch Trello board via recorded fixtures):
- Full workflow on 10 synthetic cards covering all six terminal states
- Re-run idempotence: second triage is a no-op
- Human override detection: manually remove label → triage re-runs

No new system tests required — the skill is an orchestrator, not a new transport.

## Rollout

1. Land spec + plan + code + tests in a single PR.
2. Run `/danx-triage` manually against danxbot's own Review list (12 cards today) as the first real-world smoke test.
3. After confidence, document the skill in `CLAUDE.md` under "Skills" alongside `/danx-next` and `/danx-ideate`.
4. Optional follow-up: schedule a weekly `/danx-triage` via the `/schedule` skill for each connected repo.

## Out of Scope for This Spec

- Extending triage to In Progress / ToDo lists. Easy to add later — the scope prompt already supports it; just not a default.
- A dashboard "Triage Score" column. Nice-to-have, not required.
- Background / poller-driven triage. Layered on via `/loop` or `/schedule` if wanted.
- Cross-repo triage (one invocation, N connected repos). The skill runs per repo like `/danx-next`.
