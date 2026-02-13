import type Anthropic from "@anthropic-ai/sdk";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001" as const;

/**
 * Extracts text from an Anthropic API response, strips code fences,
 * and parses the result as JSON.
 */
export function parseJsonResponse(
  response: Anthropic.Messages.Message,
): Record<string, unknown> {
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const jsonStr = text
    .replace(/```json\s*\n?/g, "")
    .replace(/```\s*$/g, "")
    .trim();

  return JSON.parse(jsonStr);
}
