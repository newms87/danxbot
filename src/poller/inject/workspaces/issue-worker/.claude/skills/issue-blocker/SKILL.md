---
name: issue-blocker
description: MANDATORY before writing `status: "Blocked"` on any card OR populating the `blocked: {reason, timestamp}` record OR appending a `## Blocked` comment OR calling `danxbot_complete({status: "failed", ...})` with a "operator must X" framing. Loads the 8-item gating checklist (false-blocker pattern audit, forbidden git ops audit, programmatic-substitute audit, root-cause trace audit) as a TodoWrite checklist. Refuses to ship a Blocked move that fails any item — sends you back to in-session work or Action Item creation.
---

# Issue Blocker — MANDATORY Pre-Block Gate

You are about to mark a card Blocked. STOP. Most "blockers" are not real
blockers — they are rationalizations of avoidable work. Run this
checklist first. EVERY item must pass. If even one fails, you are NOT
authorized to write `status: Blocked` — return to in-session work,
Action Item creation, or AC rewrite per the path the failed item names.

## Why this gate exists

Production has burned hundreds of dollars on cards parked in Blocked for
"reasons" that were programmatically resolvable: pre-existing flaky
tests an agent could file as Action Items, "manual UI smoke" ACs an
agent could replace with component tests, post-terminal-save state an
agent could verify via a unit test on the derivation function,
uncommitted diffs an agent should have ignored. Every one of those
re-dispatches the next agent into the same trap. The cost of one false
Blocked move > the cost of running this 8-item checklist.

## The Checklist — every item MUST pass

Create a TodoWrite todo for each item. Mark each `in_progress` while
auditing, `completed` only after writing the verification answer in
your reasoning. If any item ends `failed`, abandon the Blocked move
and follow the named recovery path.

### 1. Is a HUMAN action the actual next step?

A real blocker has a specific human action that unblocks: rotate a
credential, push a secret to SSM, write to a repo I cannot access, make
a design decision that changes the goal of the card.

- **PASS:** name the human action in one sentence. The action must be
  something a human MUST do — not something I could do if I tried
  harder.
- **FAIL paths:**
  - "Operator must decide" → if the decision is between an obviously
    correct option and an obviously wrong one (e.g. "revert silent
    fallback that breaks fail-loud test" vs "keep silent fallback"),
    DECIDE UNILATERALLY + document. That's not a human decision —
    that's an obvious choice with a paper trail.
  - "Operator must verify in the UI / log in / click" → see Pattern 2
    of `danx-no-false-blockers.md`. Use component test → playwright →
    rewrite AC.
  - "Operator must restart the worker / deploy / run X command" → not
    a Done gate. See `danx-next/SKILL.md` Step 10 forbidden-blocker
    list.

### 2. Is there an uncommitted working-tree diff involved?

Run `git status -s`. List every file with `M` / `??` status that you
did not personally write in this dispatch.

- **PASS:** zero such files in the path the blocker references.
- **FAIL — do NOT block:** another agent's diff is interfering.
  - Forbidden: `git stash`, `git checkout --`, `git restore`,
    `git reset`. Do NOT touch their work. Do NOT run gates that
    depend on the file being in a different state.
  - Resolution: note the conflict in a `comments[]` entry on this
    card. Proceed with what you CAN verify. If the blocker is
    LITERALLY "another agent's diff broke a test," your card is NOT
    blocked — it's interrupted. File a `comments[]` note + go back
    to your own ACs. The peer agent will commit + the diff resolves.

### 3. Did you "verify the failure pre-existed your changes"?

`git stash`-then-test-then-pop, `git checkout HEAD`, comparing against
parent SHA via stash, ANY workflow whose purpose is determining
whether a failure is your fault vs prior work.

- **PASS:** no, never did this. Zero value in the answer.
- **FAIL:** abandon the Blocked move. The act of stashing already
  violated `danx-no-false-blockers.md` Pattern 1's STRICTLY FORBIDDEN
  list. Recover: `git stash pop` if you stashed, document the
  violation in retro.bad, then re-evaluate WITHOUT pre-existence
  reasoning. Either YOUR code path produces the failure (option 2:
  fix in-session) or you can root-cause by READING the failing test
  + traced code (option 3: Action Item).

### 4. Did you trace the actual problem code path by reading?

Real root-cause analysis: read the failing test → read the code under
test → identify the line that produces the wrong behavior → name the
function / file / line.

- **PASS:** quote the file:line of the root cause + one-sentence
  explanation of WHY it fails. If the cause is a pre-existing bug in a
  module unrelated to your card, you have the data to file a
  high-quality Action Item card.
- **FAIL:** you don't actually know why the test fails. Stop. Read
  the test. Read the code under test. Trace until you can name the
  line. Without this you cannot file an Action Item card (it will be
  speculation, useless to the next agent) and you cannot Block (you
  haven't proven a human is needed).

### 5. Is there a programmatic substitute for the AC's literal wording?

Run through the substitutes in `danx-no-false-blockers.md`:
- **Manual UI smoke** → component test (`@vue/test-utils`) →
  playwright + dashboard token at `~/.config/danxbot/dashboard-token`
  → rewrite AC.
- **Post-terminal-save state** → unit test on the derivation function.
- **"Needs deploy" / "needs prod smoke"** → AC is mis-specified;
  rewrite to local-verify form.
- **Pre-existing flaky test** → Action Item card + check off
  (your changes pass).

- **PASS:** no substitute exists for this specific AC. Quote the AC +
  why each substitute fails.
- **FAIL:** use the substitute. Do NOT block.

### 6. Could you fix the underlying defect in 10–30 minutes?

Apply Step 1.5 of `danx-next/SKILL.md` literally. Read the smallest
fix that would make the AC pass. Estimate the time honestly.

- **PASS:** fix is genuinely multi-phase / cross-cutting / requires
  scoping a redesign. Quote the scope.
- **FAIL:** do it now. "Action item is fine" is not the answer when
  you could ship the fix in this dispatch.

### 7. Does the Blocked record name a HUMAN action with a verification command?

If you reach this point, write the `blocked.reason` AS IF a human will
read it in 30 seconds and execute it. The reason MUST contain:
- One sentence naming the human action.
- The exact command(s) the human runs to unblock.
- The exact verification command(s) the human runs to confirm the
  unblock worked.

- **PASS:** reason has all three.
- **FAIL:** the blocker is too vague to be actionable. That usually
  means it isn't a real blocker. Re-run items 1–6.

### 8. Are you about to use Blocked to dodge a test failure / AC?

Final sanity check. Read the AC list. Read your blocker reason. Are
you blocking because the work is ACTUALLY impossible without a human,
or because a verification command failed and you don't want to chase
the root cause?

- **PASS:** ACTUALLY impossible. You can name the human action + the
  command they run. Item 7 passed.
- **FAIL:** you're using Blocked as an exit door. Go back to item 4
  (trace the failure) or item 6 (fix it).

## After all 8 items pass

Only then are you authorized to:
1. Set `status: "Blocked"`.
2. Populate `blocked: {reason, timestamp}` per Step 10 of `danx-next/SKILL.md`.
3. Append the `## Blocked` comment.
4. Call `danxbot_complete({status: "failed", summary: "..."})`.

Quote the 8 PASS results into a `## Blocker self-audit` section of the
Blocked comment so the operator can audit your reasoning. If you
cannot quote 8 PASS results, you have not earned the Blocked move.

## Forbidden patterns this skill catches

| Pattern | Why it's forbidden | Recovery |
|---|---|---|
| "Operator must decide revert vs keep silent-fallback" | Item 1 — silent-fallback violates `dev:code-quality`; the choice is obvious. Decide unilaterally. | Apply the obvious-correct option, document, ship. |
| "I stashed the diff to verify pre-existence" | Item 3 — stashing is STRICTLY FORBIDDEN. | Pop the stash, abandon pre-existence reasoning, root-cause via reading. |
| "Operator must run UI smoke / log in" | Item 5 — programmatic substitute exists. | Component test → playwright → rewrite AC. |
| "Auto-flip happens after I exit, can't verify" | Item 5 — unit-test the derivation function. | Rewrite AC to point at the unit test. |
| "Pre-existing flaky test fails the local-verify AC" | Item 1 + 5 — Action Item card + check off. | `danx_issue_create`, push id, check AC, proceed. |
| "Another agent has uncommitted diff that breaks my test" | Item 2 — interruption, not blocker. | Note in comments[], proceed with what you can verify. |
