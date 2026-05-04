/**
 * Completion-instruction string appended to dispatch agent prompts when the
 * `danxbot_complete` MCP tool is available. Tells the agent to call the tool
 * instead of silently stopping output. Pure function — extracted from
 * launcher.ts so dispatch/core.ts can build prompts without importing the
 * launcher (which pulls in the spawn pipeline).
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
