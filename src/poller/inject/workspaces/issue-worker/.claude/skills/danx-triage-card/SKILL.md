---
name: danx-triage-card
description: 'Per-card triage agent. Single Claude session reads ONE card via mcp__danx-issue__danx_issue_get, decides per status (Review / Blocked / Waiting On), writes the TTL-stamped triage{} block back with the Edit tool. Dispatched 1-card-per-tick by the poller (Phase 4 / ISS-94). Replaces the bulk-triage orchestrator.'
argument-hint: <PREFIX>-N card id
---

# Danx Triage Card

You triage **ONE** card per dispatch. No orchestrator, no sub-agents. You:

1. `mcp__danx-issue__danx_issue_get({id: "<PREFIX>-N"})` — load the YAML and learn its filesystem path.
2. Decide per `status` (Review / Blocked / Waiting On) — apply the per-status decision tree below.
3. Edit the YAML's `triage{}` block (always) + `status` / `blocked` fields when the decision is terminal, using the `Edit` tool directly on `<repo>/.danxbot/issues/{open,closed}/<PREFIX>-N.yml`.
4. Re-read the file with `Read` to confirm the edit landed and the YAML parses (look for the new `triage.expires_at` value).
5. `danxbot_complete({status: "completed", summary: "..."})` — signal done.

You read the YAML through the `danx-issue` MCP server (which exposes the get/list tools) and write it through `Edit` / `Write` directly. You do NOT make tracker calls — the chokidar watcher in the worker (`src/db/issues-mirror.ts`) catches every YAML edit and mirrors it to Postgres; the poller's per-tick mirror pushes it to the tracker.

## /loop and ScheduleWakeup — narrow contract

Triage is a single-shot dispatch (read → decide → save → complete). You
have NO legitimate reason to arm `/loop` or `ScheduleWakeup` in this skill.
The contract below applies anyway because every dispatched-agent skill
shares it (ISS-135 / ISS-136).

**ALLOWED:**

- Polling an async pipeline whose result IS part of this card's AC (e.g.
  dispatch a build, `/loop` every 5 min until it finishes, then verify the
  artifact and proceed).
- Monitoring a long-running test whose pass/fail is the AC under test.
- Watching for the next state of an external system you triggered AS PART
  OF THIS CARD's WORK.

**FORBIDDEN:**

- Waiting for a human to reply (use `status: Blocked` instead — the
  operator opens the card, answers, moves it back).
- Waiting for the next card to land (the poller dispatches; you exit when
  this card is done).
- "Let me check on this in N minutes" for anything outside this card's
  scope.
- Arming `/loop` and then calling `danxbot_complete` in the same dispatch.
  Loop owns completion timing — if you call complete, disarm the loop
  first; if a loop is active, do not call complete.

**RULE:** when you call `danxbot_complete`, every `ScheduleWakeup` armed
during this dispatch must be disarmed (or have already fired and exited).
Active loop + complete signal = workflow violation; the next resume will
re-fire the loop after the dispatch is logically over.

## Read via MCP, write via Edit

The dispatched workspace exposes the `danx-issue` MCP server (the
`@thehammer/danx-issue-mcp` package) which advertises read tools (`get`,
`list`) plus a `create` tool that allocates the next `<PREFIX>-N` id
atomically. Use those for reading the card and resolving its
filesystem path. The danxbot infrastructure server also advertises
`danx_issue_create` (POSTs to a worker HTTP route) — both work; pick
either based on what's already in your tool list.

DX-157 retired the agent-facing save tool entirely. **Write through
`Edit` / `Write` directly on the YAML at
`<repo>/.danxbot/issues/{open,closed}/<PREFIX>-N.yml`.** The chokidar
watcher catches every file change and mirrors it to Postgres; the
poller's per-tick mirror pushes to the tracker. There is no save verb
to call.

## In-scope cards

The triage agent has THREE paths. The right path is decided by the YAML's
`waiting_on` and `blocked` fields FIRST, then by `status`:

| YAML state | Path |
|---|---|
| `waiting_on != null` (regardless of `status`) | **Waiting On** — re-check `waiting_on.by[]` |
| `waiting_on == null` AND `status === "Review"` | **Review** — ICE-score |
| `waiting_on == null` AND `status === "Blocked"` | **Blocked** — Hard Gate audit |

`Blocked` is a top-level `status` value (replaced "Needs Help"). The schema's allowed statuses
are `Review`, `ToDo`, `In Progress`, `Blocked`, `Needs Approval`, `Done`,
`Cancelled`. A "blocked" card has `status: "Blocked"` AND `blocked: {reason, timestamp}`
populated; the worker enforces the invariant `status === "Blocked" ⟺ blocked !== null`. A card with `status: ToDo` AND `waiting_on != null` is a Waiting On
card and routes to the Waiting On path; a card with `status: ToDo` AND
`waiting_on == null` is dispatchable work and OUT OF SCOPE for triage (the
poller dispatches it through the worker path, not the triage path).

The poller only dispatches you when the card is in one of the three
in-scope shapes above AND `triage.expires_at <= now` (or empty). For any
other shape (`status` ∈ `{ToDo, In Progress, Done, Cancelled, Needs Approval}` AND `waiting_on == null` AND `blocked == null`) the poller refuses to dispatch — if you somehow receive one, fail loud with `danxbot_complete({status: "failed", summary: "..."})` and do NOT mutate the YAML.

## TTLs (per-status re-triage cadence)

| Status | TTL on triage success | Why |
|---|---|---|
| `Review` | 24h | Review cards are static input from humans; daily re-evaluation is enough. |
| `Blocked` | 3h | A human is supposed to act; checking back every 3h surfaces stalled blockers fast. |
| `Waiting On` | 1h | Blocking cards may flip to terminal at any moment — re-check on the same hour. |

Compute `expires_at` as `(now + TTL).toISOString()` in UTC. **Always** stamp `triage.expires_at` on every save, even when the decision was no-op (e.g. blocker still pending) — the poller uses `expires_at` as the gate for re-dispatch.

## ICE rubric (Review only)

Per the schema, `triage.ice = {total, i, c, e}` with each component on a **1–5** scale. `total = i × c × e` (1–125). Score every card in Review.

| Score | Impact (I) | Confidence (C) | Ease (E) |
|---|---|---|---|
| 5 | Unblocks production / blocks an epic | All AC anchors verified in code | < 1 hour, isolated edit |
| 4 | Major UX or perf improvement | Most anchors verified, minor stale text | 1–3 hours, contained scope |
| 3 | Cleanup or moderate feature | Some anchors stale; needs re-investigation | Half-day, some discovery |
| 2 | Nice-to-have | Anchors uncertain; verifier must hunt | Multi-session, cross-cutting |
| 1 | Speculative / vague | Card needs rewrite first | Heavy refactor / rebuild |

Each component MUST have a one-sentence justification in `triage.last_explain`. No bare numbers.

ICE is only persisted on **Review** decisions (`Keep` / `Cancel` / `Approve`). For Blocked and Waiting On, leave `triage.ice` at zeros (the cards already have a status; ICE is for prioritising the dispatch queue, which only applies to ToDo).

## reassess_hint contract (Blocked / Waiting On only)

`triage.reassess_hint` is a **≤120 character, action-shaped sentence** that tells the next triage agent the one fast check that decides whether to re-confirm the parked status. The hint is mechanical: it must be answerable in ≤30 seconds by reading code, git log, an env var, or a list of issue ids — never "ask the user."

| Good (action-shaped) | Bad (vague / unactionable) |
|---|---|
| "Check if AGD-148..158 dispatches all completed cleanly (canonical path observer log)" | "See if the verification has been done" |
| "Check if `package.json` upstream merge has shipped" | "Wait for upstream" |
| "Check if `make publish-danx-issue-mcp` ran (npm v1.0.0+ visible)" | "Needs npm publish" |
| "Re-check `waiting_on.by[]` — ISS-42 still in progress?" | "Still waiting" |

Hint is REQUIRED on every Blocked and Waiting On save (whether confirming, demoting, or unblocking). Empty `triage.reassess_hint` is a save error.

For Review decisions, leave `triage.reassess_hint` empty — Review re-triage simply re-runs the full ICE pass.

## Per-status decision trees

### Status = `Review`

Decide one of three outcomes:

| Outcome | Action | YAML changes |
|---|---|---|
| **Keep** | Card is sound; promote into the dispatch queue. | `status: ToDo`, `triage.last_status: Keep`, `triage.ice` populated. |
| **Cancel** | Obsolete / superseded / no-longer-desired. | `status: Cancelled`, `triage.last_status: Cancel`, `triage.ice` zeros. |
| **Approve** | Implementable but the **direction needs human sign-off** before work starts (architectural risk, cross-cutting scope, ambiguous tradeoff). | `status: Needs Approval`, `triage.last_status: Approve`, `triage.ice` populated (so when the human approves and flips to ToDo, the dispatch queue already has a score). |

**Before emitting `Approve`:** read `<repo>/.danxbot/config/trello.yml` and verify `lists.needs_approval` is non-empty. If empty, fall back to `Cancel` is wrong — instead, **do not save Approve** and append a one-line note in `triage.last_explain`: `"Direction approval needed; Trello board not yet provisioned for Needs Approval — leaving in Review until operator provisions the list."` Stamp `triage.expires_at = now + 24h` and save with `last_status: ""`.

Distinguishing `Approve` vs `Cancel` vs `Keep` — apply the rule from `claude-plugins/issues/skills/issue-card-workflow/SKILL.md` "Needs Approval vs Blocked":

- Could a competent agent finish the card without ever asking the human a question? → **Keep**.
- Card is implementable but the chosen direction needs sanity-check? → **Approve**.
- Card is no longer desired / superseded by a different approach / duplicate? → **Cancel**.

`triage.expires_at = now + 24h` on every Review save (even when promoting to ToDo — if the card bounces back to Review later, it'll be re-triaged on schedule).

### Status = `Blocked` — Hard Gate audit

A card sits in Blocked because some prior agent claimed a human-only blocker. **Audit that claim** before re-confirming. Reuse the misclassification logic from `claude-plugins/issues/skills/unblock/SKILL.md`:

1. Read the most recent `author: danxbot` comment containing a `## Blocked` / "Operator must do" section. That's the contract.
2. Inspect every "operator must do" step. For each, classify:
   - **Locally executable** = any of: edit `.env` / config files; `./vendor/bin/sail artisan ...`; `make ...`, `yarn ...`, `npm ...`, `composer ...`; `tail` / `grep` / `cat` on `storage/logs/`; re-running test suites (`vitest`, `phpunit`, `artisan test:*`); restarting Octane / queue / Horizon; reading session JSONL logs; running a git command; reading code.
   - **Human-only** = ONLY: credential / secret rotation, deploy / SSM access, write-only repo, design / product decision, physical / OOB action (per `issue-card-workflow` "Hard Gate" table).
3. Decide:

| Audit outcome | Action | YAML changes |
|---|---|---|
| **Every step is locally executable** — wrongly punted | **Demote** to ToDo. Append a comment naming the misclassification (which steps were local-runnable). | `status: ToDo`, `blocked: null`, `triage.last_status: Demote`, `triage.last_explain: "<one sentence — what was misclassified>"`, `triage.reassess_hint: ""` (cleared — card is no longer parked). The next worker dispatch will pick it up and DO the local work; this triage agent does NOT execute the steps itself. |
| **At least one step is genuinely human-only** | **Confirm** Blocked. Write `triage.reassess_hint` — the one fast check that decides whether to re-confirm next time. | `status: Blocked` (unchanged), `blocked` (unchanged), `triage.last_status: Confirm-Block`, `triage.last_explain: "<one sentence — which human-only step gates the card>"`, `triage.reassess_hint: "<≤120 chars, action-shaped>"`. |
| **Mixed** (some local, some human-only) | Same as Confirm — but mention in `last_explain` that the next worker dispatch should execute the local steps before re-confirming. The `reassess_hint` tells the next triage agent how to verify the human-only step landed. | Same as Confirm above. |

`triage.expires_at = now + 3h` on every Blocked save (Confirm, Demote, or Mixed). Stamp `now + 3h` even on Demote — if the demoted card bounces back to Blocked later, the cadence is the right floor.

**Rationalisation detector (refuse to confirm if the prior comment contains any of):**

- "operator-driven verification"
- "production-shaped infra"
- "honest way to verify"
- "intermittent — needs more samples"
- "needs to be tested in production / staging"

These phrases mean the prior agent punted. Demote.

### Status = `Waiting On` — re-check `waiting_on.by[]`

A card with `waiting_on != null` is parked waiting on other in-flight cards. Your job is to re-check whether every blocker has reached a terminal status (Done or Cancelled).

Procedure:

1. Read `waiting_on.by[]` from the YAML. For each `<PREFIX>-N`:
   - `mcp__danx-issue__danx_issue_get({id: "<PREFIX>-N"})` to read the blocker.
   - Note its `status`. Terminal = `Done` or `Cancelled`. Non-terminal = anything else.
2. Decide:

| Audit outcome | Action | YAML changes |
|---|---|---|
| **Every blocker is terminal** | **Unblock**. Set `waiting_on: null` (the worker mechanically forces `status: ToDo` on save when `waiting_on` is null and the prior status was the worker-managed `ToDo` — see `issue-card-workflow` "Waiting On vs Blocked"). | `waiting_on: null`, `triage.last_status: Unblock`, `triage.last_explain: "<one sentence — every blocker reached terminal status>"`, `triage.reassess_hint: ""` (cleared — card is dispatchable). |
| **At least one blocker is non-terminal** | **Confirm-Block**. Update `triage.reassess_hint` to name which blockers are still pending. | `waiting_on` unchanged, `status` unchanged (worker enforces ToDo), `triage.last_status: Confirm-Block`, `triage.last_explain: "<one sentence — naming the still-pending blockers>"`, `triage.reassess_hint: "<≤120 chars — e.g. 'Re-check ISS-91, ISS-92 — still in progress as of <iso>'>"`. |

`triage.expires_at = now + 1h` on every Waiting On save. The 1h cadence is intentionally short — a phase sibling can move from In Progress to Done at any minute, and we want the dependent card dispatched as soon as possible.

**Edge case — blocker not found.** If `mcp__danx-issue__danx_issue_get` returns `{error: "..."}` for a blocker id (file missing on disk and not in tracker), treat that blocker as **Cancelled** (a non-existent card cannot block) and proceed with the rest. Note in `last_explain`: `"Blocker <PREFIX>-N not found — treated as Cancelled."`

### Out-of-scope cards

A card is **out of scope** ONLY when ALL conditions hold:

1. `waiting_on == null` (no dep-chain record), AND
2. `blocked == null` (no self-block record), AND
3. `status` is one of: `ToDo`, `In Progress`, `Done`, `Cancelled`, `Needs Approval`.

| `status` (with `waiting_on == null` AND `blocked == null`) | Action |
|---|---|
| `ToDo` / `In Progress` | Refuse — these are dispatchable / actively-dispatched cards; never re-triaged. `danxbot_complete({status: "failed", summary: "..."})`. |
| `Done` / `Cancelled` | Refuse — terminal cards stay frozen. `danxbot_complete({status: "failed", summary: "..."})`. |
| `Needs Approval` | Refuse — humans only set/clear this status. `danxbot_complete({status: "failed", summary: "..."})`. |

**A card with `waiting_on != null` is NEVER out of scope** — even if its `status` is `ToDo` (the worker forces `ToDo` on every waiting-on card). **A card with `blocked != null` is NEVER out of scope** — even if its `status` is `Blocked` (the worker enforces the invariant). Always route waiting-on cards to the Waiting On path and blocked cards to the Blocked path. Re-read the in-scope table at the top of "Per-status decision trees" if you find yourself looking at `status: ToDo` and considering refusal — the FIRST checks are `waiting_on != null` and `blocked != null`, not `status`.

The poller is the gatekeeper; if you receive a genuinely out-of-scope card (`blocked == null` AND non-Review/non-Needs-Help status) the poller has a bug — fail loud so it surfaces.

## YAML changes — checklist (every triage save)

Before calling `Edit`, every triage decision MUST update the `triage{}` block:

1. `triage.expires_at` — set to `(now + status_ttl).toISOString()` where `status_ttl ∈ {24h, 3h, 1h}` per the table above.
2. `triage.last_status` — one of `Keep | Cancel | Approve | Demote | Confirm-Block | Unblock`.
3. `triage.last_explain` — 1–2 sentence English description of the decision (include ICE breakdown for Review / Keep|Approve).
4. `triage.reassess_hint` — required for Blocked (Confirm) and Waiting On (Confirm-Block). Cleared (`""`) on Demote and Unblock. Empty on Review.
5. `triage.ice` — populated on Review / Keep|Approve. Zeros on every other path.
6. `triage.history` — APPEND a new entry with the same fields (`{timestamp, status, explain, expires_at, ice}`). Cap history at 10; oldest dropped on overflow.

After `Edit`, re-read the file with `Read`. Confirm the file parses (no YAML errors visible in the lines you cared about) and `triage.expires_at` matches the value you wrote. If the file is malformed (e.g. wrong indentation broke a sibling key), fix it via another `Edit` and re-read. The chokidar watcher mirrors every YAML write to the DB; a malformed file is mirrored as `{_malformed: true, raw: <text>}` and surfaces in the dashboard banner — recover before calling `danxbot_complete` so you don't ship malformed state.

## Comment policy

Triage decisions DO append a comment to `comments[]` for human-readable history (in addition to the structured `triage{}` block). Logical shape:

- `author: "danxbot-triage"`
- `timestamp: <current ISO>`
- `text:` markdown body — uses the `comment-style` skill (`claude-plugins/issue-worker/skills/comment-style/SKILL.md`):
  - `## Triage — <YYYY-MM-DD>`
  - `**Status:** <prior status> → <new status>`
  - `**Decision:** <last_status — one of Keep | Cancel | Approve | Demote | Confirm-Block | Unblock>`
  - `**ICE:** <total> (<I>×<C>×<E>)` — Review with **Keep** or **Approve** ONLY. **DO NOT include this line for Cancel / Demote / Confirm-Block / Unblock** (`triage.ice` is zeros for those — printing `**ICE:** 0 (0×0×0)` is noise).
  - `**Reassess hint:** <reassess_hint>` — Blocked **Confirm** and Waiting On **Confirm-Block** ONLY. **DO NOT include this line for Review (any decision), Blocked / Demote, or Waiting On / Unblock** (`triage.reassess_hint` is `""` for those — printing `**Reassess hint:**` with no value is a half-line of garbage in the dashboard).
  - `**Explain:** <last_explain>`
- No `id` field — worker stamps it on tracker push.

One comment per triage. Don't append more than one comment per dispatch.

## Smoke-test checklist (manual operator verification)

When verifying the agent against the live wiring:

1. Pick one card per in-scope status and dispatch the agent (`/api/launch` with `workspace: "issue-worker"`, `task: "Triage card <PREFIX>-N using the danx-triage-card skill."`).
2. After dispatch finishes (`status: completed`), re-read the YAML:
   - `triage.expires_at` is a future ISO 8601 timestamp (within ±30s of `now + status_ttl`).
   - `triage.history[]` gained exactly one new entry with matching `expires_at`, `status`, `explain`.
   - `triage.last_status` matches one of the allowed values for that input status.
   - For Blocked / Confirm and Waiting On / Confirm-Block: `triage.reassess_hint` is non-empty AND ≤120 characters.
   - For Blocked / Demote and Waiting On / Unblock: `triage.reassess_hint` is `""` (cleared — card is no longer parked).
   - For Review with Keep / Approve: `triage.ice.total = i × c × e` with each component in [1,5].
   - For Review with Cancel: `triage.ice = {total: 0, i: 0, c: 0, e: 0}` (Cancel doesn't score).
3. `comments[]` gained exactly one new `## Triage — <date>` comment.

Any mismatch on the above is a skill-body bug; file as a follow-up issue and surface in retro.

## Failure handling

- YAML parse error / `danx_issue_get` returns `{error: ...}` → `danxbot_complete({status: "failed", summary: "Failed to load <PREFIX>-N: <error>"})`. Do NOT edit the file.
- Re-read after `Edit` shows the YAML is malformed → fix it via another `Edit`, re-read again. If you can't recover after one retry, `danxbot_complete({status: "failed", summary: "..."})` describing what went wrong.
- MCP tool itself errors (server unreachable, tool not registered) → `danxbot_complete({status: "critical_failure", summary: "mcp__danx-issue__* tools not available — workspace .mcp.json wiring broken"})` per `claude-plugins/issue-worker/skills/halt-flag/SKILL.md`.

## Boundaries

- You read + write **exactly one** card. Never edit `comments[]`, `ac[]`, `description`, or any field of a card you weren't dispatched for.
- You do NOT investigate the underlying bug / feature — that's the worker dispatch (Phase 4 / ISS-94). Triage decides "is this card ready to be worked on" not "what is the work."
- For Review cards, the `ice` score is your judgement based on the card's CURRENT description, ACs, and recent commits. You may `git log --oneline -200` for context but DO NOT edit the description, append diagnostic notes, or restate ACs.
- For Blocked cards, the audit is read-only — if the misclassification is "every step locally executable," you Demote and let the next worker dispatch DO the steps. You never run the steps yourself.
