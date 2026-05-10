# Don't Block On These — False Blocker Patterns

Three patterns commonly mistaken for human-action blockers. **None of them
are valid `status: Blocked` reasons.** Use the in-session resolution below;
keep the card moving.

These extend (do NOT override) `danx-next/SKILL.md` Step 10 — Step 10 stays
the authoritative menu. This rule names the patterns Step 10 does not yet
list.

## Pattern 1 — Test failure unrelated to your card

**Symptom:** `npx vitest run` (or any suite) fails on a test that touches
a file / module your card does not modify.

**NOT a blocker.** Three options. There is no fourth.

1. **Uncommitted diff in a related file (visible in `git status`)** →
   another agent's active work. Leave it alone. Do NOT `git stash`, do
   NOT `git checkout --`, do NOT `git restore`, do NOT run any gate
   whose result depends on that file being in a different state. Note
   the conflict in a `comments[]` entry on this card and proceed with
   what you CAN verify.
2. **Failure in a code path your card touches** → fix it, in this
   dispatch.
3. **Failure unrelated to your card, root-caused by READING the
   problem code path (not by stashing or reverting), AND too involved
   to fix in 30 min** → create an Action Item card via
   `danx_issue_create({type: "Bug", title, description, ac, ...})`
   with the actual root-cause hypothesis you traced. Push the returned
   `<PREFIX>-N` into `retro.action_item_ids[]`. Check the AC off (your
   card's tests pass) and proceed.

**STRICTLY FORBIDDEN — do not run any of these against working-tree
state you did not personally write in this dispatch:**

- `git stash` / `git stash push <path>` / `git stash pop`
- `git checkout -- <path>` / `git checkout HEAD <path>`
- `git restore <path>` / `git restore --staged <path>`
- `git reset <path>` / `git reset --hard`
- Any "verify failure pre-existed my changes" investigation. There is
  ZERO value in the answer. The suite either passes for YOUR changes
  (option 2) or it does not (option 1 / 3).

Reverting another agent's uncommitted work cascades — the peer agent
re-runs, re-applies, two sessions fight over the same file, the
working tree melts. Cost of the cascade > cost of any verification
benefit. Do not.

**Forbidden:** "I stashed the diff, ran tests, popped back to confirm
the failure pre-existed" → rule violation, regardless of how clean the
result looked. The act of stashing IS the violation.

## Pattern 2 — Manual UI smoke / dashboard verification

**Symptom:** AC says "manually verify at http://localhost:5566 …" or
"operator clicks X, sees Y." Agent has no human eyeball to satisfy literal
wording.

**NOT a blocker.** The AC's INTENT is "the rendered UI shows the new
state." That intent has three programmatic substitutes — pick the cheapest
one that works.

**In-session resolution (in priority order):**

### a) Component test (cheapest, almost always sufficient)

Mount the SFC with fixture data using `@vue/test-utils` + the dashboard's
existing `vitest` setup (`cd dashboard && npx vitest run`). Assert the DOM
reflects the new state. This satisfies "renders X when state Y" ACs
deterministically without a browser.

```ts
// dashboard/src/components/AgentBadge.test.ts
import { mount } from "@vue/test-utils";
import AgentBadge from "./AgentBadge.vue";

it("renders initials when no avatar", () => {
  const wrapper = mount(AgentBadge, { props: { name: "Dan", size: "md" } });
  expect(wrapper.text()).toContain("D");
});
```

### b) Playwright drive (when component test can't reach it)

Workspace `.mcp.json` ships `mcp__playwright__*` tools. Auth via the
operator's persistent token:

```bash
# Host-mode dispatch — token file is on the host filesystem.
TOKEN=$(cat ~/.config/danxbot/dashboard-token)
curl -sS -H "Authorization: Bearer $TOKEN" http://localhost:5566/api/auth/me
# → {"user":{"username":"monitor"}}  (sanity check)
```

For UI navigation, log the dashboard in once via the API (`POST
/api/auth/login` with the `monitor` user), capture the session cookie /
bearer, and inject it into the playwright context before navigating to a
protected page. Take a screenshot, assert the badge is present in the
serialized DOM. If the playwright MCP does not currently support cookie
injection, fall back to (a) or (c).

### c) Rewrite the AC

If neither (a) nor (b) works, the AC is mis-specified. Edit the AC item
title to a programmatic gate you CAN run:

```yml
# was: "Manual smoke at http://localhost:5566 — badges visible"
# now: "Component test dashboard/src/components/AgentBadge.test.ts asserts badge renders for issue rows + drawer header + busy state"
```

Add a `comments[]` note explaining the rewrite. The AC's intent is
preserved; the gate is now executable. Run the gate, check the AC off,
proceed.

**Forbidden:** "AC says 'manually verify' so I cannot complete it →
Blocked." Manual-only language in an AC is a wording defect, not a human-
action requirement. Rewrite or substitute.

## Pattern 3 — Post-terminal-save / self-derived state

**Symptom:** AC says "after this card moves to Done, the parent epic
auto-flips to Done" or "the worker post-completion auto-sync renders the
retro comment" or "the chokidar watcher mirrors the YAML to Postgres."
The behavior fires AFTER the agent calls `danxbot_complete` — there is no
moment inside the dispatch when it can be observed end-to-end.

**NOT a blocker.** A self-referential post-save behavior is NEVER
verifiable from inside the dispatch that triggers it (chicken-and-egg).
The AC must verify the CODE PATH that performs the derivation, not the
runtime side-effect.

**In-session resolution:**
1. Identify the function / module that produces the derived state. Examples:
   `src/poller/index.ts#deriveEpicStatus`, `src/worker/auto-sync.ts`,
   `src/db/issues-mirror.ts` chokidar handler.
2. Confirm a unit test exists that exercises that function directly with
   fixture inputs. If absent, write one (Step 1.5 — fix in-session).
3. Rewrite the AC to point at the unit test:
   ```yml
   # was: "Epic DX-158 every AC checkable; epic flipped to Done by operator/automation on terminal save"
   # now: "Unit test src/poller/epic-derive.test.ts asserts deriveEpicStatus({phases all Done}) returns 'Done' (covers the auto-flip code path that runs on next poll tick after terminal save)"
   ```
4. Run the unit test, check the AC off.

**Forbidden:** "the auto-flip happens after my dispatch ends, so I cannot
verify it → Blocked." That logic blocks every card that touches a system
with eventual-consistency / post-save hooks. The unit test on the
derivation function IS the verification.

## Generalized rule

A card is **Blocked** only when a HUMAN ACTION (credential rotation,
external repo write access, ambiguous spec needing a design decision) is
the next step. Three things that are NOT human actions:

| Apparent blocker | Actual class | Resolution |
|---|---|---|
| Pre-existing flaky test in unrelated file | In-session work or Action Item | Fix in 30 min OR file Action Item, check AC, proceed |
| "Manual UI smoke" AC | Wording defect or programmatic substitute available | Component test → playwright → rewrite AC |
| Post-terminal-save behavior verification | Self-referential AC | Rewrite AC to point at the unit test for the code path |

Before writing `status: Blocked`, mechanically run this checklist:

1. Does this require a HUMAN to act (rotate credentials, push to SSM,
   make a design decision, edit a repo I cannot write to)? **No → not
   Blocked.**
2. Does any existing tool in my dispatch (Bash, Edit, Write, playwright
   MCP, dashboard token file, component test runner, unit test runner)
   produce evidence equivalent to what the AC asks for? **Yes → use it.**
3. If the AC's literal wording demands something only a human can do,
   does its INTENT have a programmatic substitute? **Yes → rewrite the
   AC to the substitute, add a `comments[]` note explaining the rewrite,
   verify, check off.**

Only after answering all three "no" do you proceed to Step 10.
