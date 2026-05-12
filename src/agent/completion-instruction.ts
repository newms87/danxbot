/**
 * Completion-instruction string appended to dispatch agent prompts when the
 * `danxbot_complete` MCP tool is available. Tells the agent to call the tool
 * instead of silently stopping output. Pure function — extracted from
 * launcher.ts so dispatch/core.ts can build prompts without importing the
 * launcher (which pulls in the spawn pipeline).
 *
 * Skipped for poller dispatches whose task body is a `/danx-*` slash command
 * — those skills (`danx-next`, `danx-triage-card`, `danx-ideate`,
 * `danx-start`, `danx-epic-link`) ship the completion contract in their own
 * SKILL.md bodies so the prompt itself can stay minimal (persona + slash
 * command + card id). See `shouldAppendCompletionInstruction` below.
 */
export function buildCompletionInstruction(): string {
  return (
    "\n\n---\nIMPORTANT: When you have finished all work, you MUST call the " +
    "`danxbot_complete` tool with status 'completed' and a brief summary. " +
    "Do not simply stop producing output — always call the completion tool to " +
    "signal that you are done. If you encounter a fatal error, call it with " +
    "status 'failed' and a description of the error."
  );
}

/**
 * Returns true when the caller should append `buildCompletionInstruction()`
 * to the agent's task body. The skip rule: any task whose first non-empty
 * line begins with a `/danx-` slash command. Those tasks target dispatched-
 * agent skills whose SKILL.md body already includes the
 * `danxbot_complete`-on-finish contract, so the prompt-side footer is
 * redundant noise that bloats the system prompt cache.
 *
 * `/api/launch` callers, Slack dispatches, and any future entry whose task
 * body does NOT start with `/danx-` keep the footer — those agents do not
 * load a `danx-*` skill that knows the completion contract.
 *
 * Mechanical check, not a heuristic: agents that load a `danx-*` skill by
 * slash command get the contract from the skill; everyone else needs the
 * footer.
 */
export function shouldAppendCompletionInstruction(task: string): boolean {
  return !task.trimStart().startsWith("/danx-");
}
