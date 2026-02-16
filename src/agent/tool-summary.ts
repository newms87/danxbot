/**
 * Summarizes a tool's input into a short human-readable string.
 * Shared between agent.ts (log creation) and log-parser.ts (log parsing).
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
