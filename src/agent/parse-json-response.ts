import type Anthropic from "@anthropic-ai/sdk";

/**
 * Extract the first JSON object from a string that may contain
 * surrounding text, code fences, or trailing commentary.
 */
function extractJson(text: string): string {
  // Strip code fences
  const stripped = text.replace(/```[^\n]*\n?/g, "").trim();

  // Try strict parse first (fastest path)
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {
    // Fall through to extraction
  }

  // Find the first { and its matching } by counting braces
  const start = stripped.indexOf("{");
  if (start === -1) throw new SyntaxError("No JSON object found in response");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }

  throw new SyntaxError("Unterminated JSON object in response");
}

/**
 * Extracts text from an Anthropic API response, strips code fences,
 * extracts the JSON object, and parses it.
 */
export function parseJsonResponse(
  response: Anthropic.Messages.Message,
): Record<string, unknown> {
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return JSON.parse(extractJson(text));
}
