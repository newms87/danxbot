/**
 * Summarizes a tool's input into a short human-readable string.
 */
export function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "Read":
      return truncStr(String(input.file_path || ""), 80);
    case "Grep":
      return truncStr(String(input.pattern || ""), 60);
    case "Glob":
      return truncStr(String(input.pattern || ""), 60);
    case "Bash":
      return truncStr(String(input.command || ""), 100);
    default:
      return "";
  }
}

export function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Builds a human-readable summary for an assistant message from its content blocks.
 * Returns "Tools: Read(...), Bash(...)" for tool calls, or "Text: <preview>" for text-only.
 * Shared between agent.ts (SDK log creation) and session-log-watcher.ts (JSONL conversion).
 */
export function buildAssistantSummary(
  content: Record<string, unknown>[],
): string {
  const toolUses = content.filter((b) => b.type === "tool_use");
  const textBlocks = content.filter((b) => b.type === "text");

  const toolNames = toolUses
    .map((t) => {
      const name = (t.name as string) || "unknown";
      const input = (t.input ?? {}) as Record<string, unknown>;
      const detail = summarizeToolInput(name, input);
      return detail ? `${name}(${detail})` : name;
    })
    .join(", ");

  const textPreview = textBlocks
    .map((b) => b.text as string)
    .join(" ")
    .slice(0, 200);

  return toolNames
    ? `Tools: ${toolNames}`
    : `Text: ${textPreview || "(empty)"}`;
}

/**
 * Builds a human-readable summary for a user message containing tool results.
 * Returns "Tool results: toolu_01, toolu_02".
 * Shared between agent.ts (SDK log creation) and session-log-watcher.ts (JSONL conversion).
 */
export function buildToolResultSummary(
  content: Record<string, unknown>[],
): string {
  const toolResults = content.filter((r) => r.type === "tool_result");
  const ids = toolResults
    .map((r) => (r.tool_use_id as string) || "result")
    .join(", ");
  return `Tool results: ${ids}`;
}
