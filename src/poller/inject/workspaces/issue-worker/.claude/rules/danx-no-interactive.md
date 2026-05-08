# Autonomous Mode — Never Ask, Never Pause

You are running unattended in a dispatched dispatch. There is no operator
watching the terminal. There is no one to answer a question, approve a plan,
or click a button. The "user" is the issue card YAML you were given.

## Hard rule: zero interactive prompts

Do not, under any circumstance, fire any of the following while processing a
card:

- `AskUserQuestion`
- `ExitPlanMode` / plan-mode confirmation prompts
- "Should I do A or B?" / "Which option do you prefer?" — written or via tool
- Any open-ended question expecting an operator reply
- Any "ready to proceed?" / "want me to continue?" pause
- Any UI that displays choices and waits for selection

Inline interactive prompts — even ones the harness silently auto-confirms —
are a rule violation. The orchestrator agent in production has no terminal
attached; the question is invisible and the dispatch hangs (or falls
through with no answer) until the inactivity timer kills it. Tokens burned,
nothing shipped.

## Process skills override

Process skills you may have learned in interactive sessions
(`brainstorming`, `writing-plans`, decision-prompt patterns, `EnterPlanMode`)
are SUPPRESSED in this workspace. Anything those skills accomplish via a
question must be resolved another way — by reading the card, by deciding
unilaterally and documenting the choice, or by escalating to Needs Help
with the question on the card.

## What to do when you'd otherwise ask

Pick exactly one of the following. Do not pause first.

1. **Decide unilaterally and document.** If the choice is reversible and
   you can pick a reasonable default, pick it, do the work, and explain
   the decision in a `comments[]` entry on the card so a reviewer can
   challenge it later. Reasonable defaults are almost always correct
   here — the operator can revert in seconds; the dispatch costs tokens.

2. **Escalate to Blocked with the question on the card.** When the
   choice is genuinely irreversible / architectural / requires
   credentials or design intent you don't have, follow Step 10 of
   `danx-next/SKILL.md`:
   - Stop processing.
   - Set `status: "Blocked"` and populate `blocked: {reason, timestamp}`.
   - Add a `comments[]` entry with the question phrased the way you'd
     have asked the human, every option you considered, and your
     recommended choice with reasoning.
   - Save and exit. The poller stops dispatching this card; a human
     answers on the tracker; the next operator-driven move releases the
     card.

3. **Block on another card.** If the question is "should we do X first?"
   and X is real work tracked on another card, use Step 10b (Blocked)
   instead — set `blocked.by` to the dependency's ISS-N. Don't ask, don't
   wait for an answer, don't sit idle.

That's the entire menu. There is no fourth option that involves waiting.

## Why this exists

This rule exists because production has burned tokens on dispatched agents
freezing in plan-mode confirmations and AskUserQuestion prompts the
operator never sees. Those dispatches sit until the inactivity timeout
kills them, then redispatch on the next tick, then freeze again. The
no-interactive-prompt rule is the load-bearing assumption that keeps
autonomous dispatch from melting the budget.

If you find yourself thinking "but the right thing to do is ask the
operator first" — re-read this file. The answer is not "ask." The answer
is one of the three options above.
