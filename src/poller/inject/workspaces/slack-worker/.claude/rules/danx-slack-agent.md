# Slack Agent Dispatch — Replying to Slack Threads

If you were dispatched in response to a Slack message, your entire
user-facing output goes through the `danxbot_slack_*` MCP tools. You do
not print answers to stdout for a Slack user to see — there is nobody
reading your stdout. The Slack thread is the only surface the user ever
sees, and the only way to reach it is via the tools below.

## Required tool calls

1. **`danxbot_slack_reply`** — call this exactly ONCE, after you have
   finished investigating and have a final answer. The `text` parameter
   IS the user's reply; write it as if you are the one person in the
   thread answering their question. Format with Slack mrkdwn
   (`*bold*` / `_italic_` / `\`code\``), keep it focused, and do not
   hedge with meta-commentary like "I'll go check X" — that belongs in a
   `danxbot_slack_post_update`, not the final reply.

2. **`danxbot_complete`** — call this IMMEDIATELY after
   `danxbot_slack_reply`, with `status: "completed"` and a short
   `summary` (one sentence, for the dispatches dashboard — NOT for the
   Slack user). Never exit without calling this.

If something went wrong and you cannot produce a useful reply, still
post a `danxbot_slack_reply` explaining what you couldn't answer and
why, then call `danxbot_complete` with `status: "failed"` and the
failure reason.

## Intermediate updates — use sparingly

**`danxbot_slack_post_update`** posts a status line into the same
thread while you're still working. Use it ONLY for updates the user
cares about:

- "Reading the campaign schema now" — yes
- "Found the failing test — it's a stale fixture" — yes
- "Running Read on src/foo.ts" — NO, the user doesn't care
- Any progress-bar-style spam — NO

A good dispatch has zero to two intermediate updates. If you catch
yourself posting every file read, stop — noise erodes trust and the
user will mute the bot. The canonical pattern is: post one update when
you've identified the investigation plan, finish the work silently,
post the final `danxbot_slack_reply`, and `danxbot_complete`.

## Thread scope is automatic

The worker routes every `danxbot_slack_*` call back to the originating
thread (same channel, same `thread_ts`) based on the dispatch row. You
do not pick a thread. You do not pick a channel. If you try to address
a different thread, you can't — the tool has no parameter for it.

## This is the ONLY path

There is no direct `chat.postMessage`. There is no Bash-to-curl escape
hatch. There is no "reply in stdout and danxbot will forward it." The
MCP tools are the contract — everything else is an agent that forgot
it was dispatched from Slack and went silent.
