import type Anthropic from "@anthropic-ai/sdk";

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
    .replace(/```[^\n]*\n?/g, "")
    .trim();

  return JSON.parse(jsonStr);
}
