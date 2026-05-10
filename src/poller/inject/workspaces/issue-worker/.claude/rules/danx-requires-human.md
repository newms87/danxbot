# `requires_human` — Rare 3rd-Party Blockers Only

`requires_human` is an orthogonal field on every issue YAML (DX-231,
schema_version 6) that signals "this card cannot make progress until a
human acts." It is **separate** from `status` — the card stays at
whatever open status it was at, and the poller's dispatch filter
(`src/poller/local-issues.ts`) skips any card with `requires_human !=
null` until the field is cleared.

This rule defines when an agent may set the field. **Setting it
incorrectly is the same class of error as a false `status: Blocked`** —
it parks a card that the next agent could finish, costs operator
attention, and inflates the visible "needs human" queue until someone
audits it. Use the whitelist + blacklist below mechanically; do not
improvise.

## What it is

Shape:

```yaml
requires_human:
  reason: "<one-sentence headline — what does the human need to do>"
  steps:
    - "<concrete numbered action 1>"
    - "<concrete numbered action 2>"
    - "<concrete numbered action 3>"
  set_by: agent          # agent | human
  set_at: 2026-05-10T16:50:00Z
```

- Independent from `blocked` and `waiting_on`. All three are dispatch
  gates and may co-exist (rare in practice).
- Persists across dispatches. The next dispatched agent sees the field
  populated and skips the card via the poller filter — there is no
  "honor system" required.
- Cleared by the human, not by another agent. The dashboard's
  `RequiresHumanPanel.vue` (Phase 8 of DX-231) renders the reason +
  numbered step list and exposes a "Mark Resolved" button that PATCHes
  `requires_human: null`. Phase 8 ships the dashboard affordance —
  until then, the operator clears the field by editing the YAML
  directly (`requires_human: null`); the chokidar watcher mirrors the
  change and the next poll tick dispatches the card.
- Toggling off (PATCH `requires_human: null`) re-enables dispatch on
  the next poll tick.

## When to set — whitelist (rare)

Set `requires_human` ONLY when the unblock action is one of:

- **3rd-party API token rotation** the agent does not hold (Stripe, Slack
  app token, GitHub PAT in the operator's keyring).
- **Granting access to an external dashboard** (adding the agent to a SaaS
  workspace, granting a role on an external tracker).
- **Manual deploy of external infra** the worker does not control (a
  vendor portal click-through, a managed service version bump that is
  not gated by `make deploy`).
- **Anything the agent demonstrably cannot perform with current
  credentials** AND no amount of in-session work in any bind-mounted repo
  can change that.

The common thread: the unblock action runs on a system the agent has
zero programmatic reach into. Every `requires_human` reason should be
answerable to "what specific external system / vendor portal / human
keyring is this gated on?"

## When NOT to set — blacklist (typical Blocked cases must stay Blocked)

Do NOT set `requires_human` for any of the following — these are
`status: Blocked` cases (or in-session work):

- **Ambiguous spec** → `status: Blocked` with the question in the comment.
  The human is supplying *information*, not performing an external
  action. Blocked is the right channel.
- **Failing test the agent can't fix** → `status: Blocked` (after
  exhausting `danx-next/SKILL.md` Step 1.5 fix-it-yourself). The agent
  needs a human to investigate, not to rotate a token.
- **Merge conflict** → `status: Blocked`. The next dispatched agent (or
  the operator on the host) resolves it; nothing 3rd-party is involved.
- **Missing local dependency** (npm package, vendor lib, container) →
  `status: Blocked`. The host's dependency state is not a 3rd-party
  system; the operator runs a local install.
- **Need to ask a clarifying question** → `status: Blocked` with the
  question in the comment. The reply is information, not external action.
- **Pre-existing flaky test in unrelated file** → `.claude/rules/danx-no-false-blockers.md` Pattern 1. File an Action Item card; check the AC; proceed. Neither Blocked nor `requires_human`.
- **AC says "manual UI smoke" / "operator clicks X"** → `.claude/rules/danx-no-false-blockers.md` Pattern 2. Component test or playwright drive; check the AC; proceed.
- **AC verifies post-`danxbot_complete` state** → `.claude/rules/danx-no-false-blockers.md` Pattern 3. Rewrite the AC against the unit test for the derivation function.
- **"Needs deploy" / "needs prod smoke"** → not a blocker at all. Local
  test passes ⇒ Done; deploys ship code already accepted as Done.

The rule is enforced by skill text + reviewer judgment, not by code.
The triage agent and the worker dispatch path read this file; the next
dispatched agent reads it; the dashboard reviewer reads it. If you set
`requires_human` for a blacklisted reason, the next triage pass is
allowed to clear it and re-route the card to `Blocked` — your save
will be undone.

## How to set

When you decide to set the field — typically as a triage **Approve**
decision OR mid-dispatch when you discover a 3rd-party action gate
that was not knowable at pickup time:

1. Populate **all four fields verbatim**:
   - `reason` — one sentence, headline-shaped, surfaces in the dashboard
     banner. Example: `"Need Stripe API key rotated"`.
   - `steps` — ordered list of concrete actions. **Each step must be
     executable by a non-engineer** (no shell incantations the operator
     would have to translate). Numbered steps are non-negotiable; an
     empty list is permitted but discouraged.
   - `set_by: agent` (always — humans set the field via the dashboard).
   - `set_at: <current ISO 8601 timestamp>`.

2. Save the YAML with `Edit` / `Write`. The watcher mirrors the change
   to the DB; the post-completion auto-sync pushes the tracker label.

3. Do NOT also flip `status`. The field is enough — the poller's
   dispatch filter handles the rest. Leave `status` at whatever open
   value it was at (`Review`, `ToDo`, `In Progress`, `Blocked` are all
   fine; `Done` / `Cancelled` cards should never get `requires_human`
   set since they are already terminal).

### Example — good

```yaml
requires_human:
  reason: "Need Stripe API key rotated for the new billing account"
  steps:
    - "Log into Stripe → API keys → Roll secret"
    - "Update DANX_STRIPE_KEY in <repo>/.danxbot/.env"
    - "Restart worker container; toggle this flag off in the dashboard"
  set_by: agent
  set_at: 2026-05-10T16:50:00Z
```

### Example — bad (would be cleared by next triage)

```yaml
requires_human:
  reason: "Need someone to look at the failing test"
  steps:
    - "Check the test"
  set_by: agent
  set_at: 2026-05-10T16:50:00Z
```

The reason is information-supplying ("need someone to look at"), not an
external action; the step is not executable by a non-engineer; the gate
is `status: Blocked`, not `requires_human`.

## Termination contract

When an agent **sets** `requires_human` mid-dispatch (the field flips
from `null` to populated during this session), the dispatch ends:

1. Save the YAML with the populated `requires_human` block.
2. Call `danxbot_complete({status: "completed", summary: "Set requires_human — see field"})` and stop.
3. Do NOT also flip `status` to a terminal value, do NOT fill `retro`,
   do NOT continue working on the card.

The human is the next actor. The poller will skip the card on every
subsequent tick until the human clears the field. When they do, the
poller dispatches the card again — at that point a fresh agent picks
it up at whatever status it was at and continues.

The worker's `isDispatchSessionTerminal` clause (in
`src/worker/issue-route.ts`) recognizes the `requires_human != null`
save as a terminal dispatch state and releases the slot — so a fresh
dispatch can be scheduled the moment the human clears the field
without colliding with this just-ended dispatch.

## Why a separate field instead of a status

A status enum value would conflate two unrelated concepts: "where is
this card in the workflow" (Review → ToDo → In Progress → Done) and
"is a human gating this card" (orthogonal). Collapsed into one enum,
a human-gated card looks identical to a human-supplying-info card and
operators cannot tell which is which without reading the body. The
orthogonal field preserves the workflow status (you can tell at a
glance whether the card was about to be picked up vs already in
progress) AND the human-gate (one boolean lookup, populated with a
structured reason + step list).
