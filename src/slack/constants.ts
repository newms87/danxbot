/**
 * Hardcoded tool allowlist for Slack `runAgent` dispatches.
 *
 * Slack runs the Claude Code SDK `query()` in-process to keep latency low —
 * never spawns the CLI. The allowlist is therefore static (no per-message
 * tool selection) and limited to the read-only built-ins needed to answer a
 * codebase question:
 *   - Read / Glob / Grep — explore source files
 *   - Bash — read-only inspection (e.g. `ls`, `cat`, `git log`); the system
 *     prompt instructs the agent to avoid mutating commands
 *
 * Notably absent:
 *   - Edit / Write — Slack agents never modify the codebase
 *   - mcp__trello__* / mcp__schema__* — no MCP servers spawn for Slack
 *   - mcp__danxbot__danxbot_complete — Slack uses the SDK iterator's `result`
 *     message as the completion signal, so no worker callback is needed
 *     (`resolveDispatchTools` is called with `danxbotStopUrl: null`)
 *
 * Lives in src/slack/ and not a shared registry per the architecture note on
 * card XCptaJ34: each entry-point owns its own static allowlist; the resolver
 * is the only shared code path.
 */
export const SLACK_ALLOW_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Bash",
]);
