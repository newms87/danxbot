# Critical Failure — Signaling Environment Blockers

If the environment you're running in is broken in a way that is NOT specific
to the card you're working on, you MUST signal this to the worker so the
poller halts. Without this signal the poller re-dispatches you (and every
future agent) into the same broken box, burning tokens on work that cannot
succeed. Production has seen this burn ~$1K in a single day.

## When to use `status: "critical_failure"`

Use `critical_failure` ONLY for environment-level blockers that would break
ANY dispatch in this environment, regardless of the card:

- **MCP server(s) failed to load** — a tool you expected (Trello, schema, etc.)
  is not present in your tools list when it should be.
- **Bash tool is broken** — returning errors unrelated to the command you ran
  (PATH issues, shell segfault, permission denied on the repo dir, the tool
  simply not available).
- **Claude auth credentials are missing or rejected** — 401s from the API, no
  `.claude.json` credentials found.
- **Critical CLI tools unavailable** — node, docker, git itself not available
  inside the dispatched session when your card needs them.
- **Any other "the agent on this machine cannot function" class of failure.**

Rule of thumb: if you tried to do a reasonable thing and the **tool itself**
(not the result) errored, it is likely a critical failure.

## When to use `status: "failed"` instead

Use `failed` (not `critical_failure`) for card-specific blockers. The
orchestrator moves the card to Needs Help — it does NOT halt the poller,
because other cards might still be processable:

- Card description is ambiguous or incomplete.
- Dependencies aren't ready (another card must ship first).
- Tests for the feature can't be written without more info from a human.
- User feedback is needed before proceeding.
- The repo you'd need to modify is not accessible in this worker's bind mount.

## The signal

Call the `danxbot_complete` MCP tool with:

```
danxbot_complete({
  status: "critical_failure",
  summary: "<specific description of the env issue — operators read this>"
})
```

`summary` is REQUIRED and must be non-empty. The operator reads it to decide
what to fix on the host. Useless: `"Environment broken"`. Actionable: `"MCP
Trello tools not loaded — tools list shows only builtins; `mcp__trello__*` is
missing"`.

## What happens next

1. Worker writes `<repo>/.danxbot/CRITICAL_FAILURE` flag with your summary.
2. Next poller tick (~60s) reads the flag, logs "halted", refuses to dispatch
   further agents.
3. Dashboard Agents tab shows a red banner per-repo with your reason.
4. A human operator investigates, fixes the underlying env issue, and clears
   the flag via the dashboard button or `rm <repo>/.danxbot/CRITICAL_FAILURE`.
5. Poller resumes on the next tick after clearing.

## Why this exists

Without the critical_failure signal, a broken box burns tokens forever. The
poller has no way to distinguish "this card needs a human" (card-specific)
from "every card in this environment is doomed" (environment-specific). Your
explicit signal is the fast path. There is a backup — the worker checks
whether you moved the card out of ToDo and writes the flag itself if you
didn't — but that only fires AFTER a full dispatch runs. Prefer the explicit
signal so you don't burn a full run's tokens before the halt kicks in.

## Failing to signal is a rule violation

If your tools are broken badly enough that you cannot complete the card AND
you do not call `danxbot_complete` with `critical_failure`, you are the
direct cause of the next agent being dispatched into the same broken
environment. Signal explicitly. Do not just exit silently.
