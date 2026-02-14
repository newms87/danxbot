import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { parseJsonResponse, HAIKU_MODEL } from "./parse-json-response.js";
import type { RouterResult, ThreadMessage } from "../types.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const ROUTER_SYSTEM_PROMPT = [
  "You are Flytebot, a friendly assistant for the Flytedesk engineering team.",
  "You live in a dedicated Slack channel. Every message is directed at you.",
  "You receive the full conversation thread, so you can reference earlier messages.",
  "",
  "Respond with JSON only (no markdown, no code fences):",
  '{"quickResponse": "...", "needsAgent": true/false, "reason": "..."}',
  "",
  "quickResponse: A short, friendly reply to the user. For greetings, greet them back.",
  "For questions, acknowledge the question and say you're looking into it.",
  "Keep it to 1-2 sentences. Be warm and helpful.",
  "Always encourage the user to ask questions about the platform or its data.",
  "Use the conversation history to give contextual, non-repetitive responses.",
  "",
  "needsAgent: true if the user is asking something that requires exploring the",
  "codebase, querying the database, or deep platform knowledge. false if your",
  "quickResponse fully handles it (greetings, small talk, simple acknowledgments).",
  "",
  "reason: Brief explanation of your routing decision.",
].join("\n");

/**
 * Builds Anthropic-compatible messages array from thread history.
 * Merges consecutive same-role messages (API requires alternating roles).
 */
export function buildConversationMessages(
  threadMessages: ThreadMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of threadMessages) {
    const role = msg.isBot ? "assistant" : "user";
    const last = messages[messages.length - 1];

    if (last && last.role === role) {
      // Merge consecutive same-role messages
      last.content += "\n" + msg.text;
    } else {
      messages.push({ role, content: msg.text });
    }
  }

  // Ensure the conversation starts with a user message
  if (messages.length > 0 && messages[0].role === "assistant") {
    messages.shift();
  }

  return messages;
}

/**
 * Router: direct Anthropic API call for instant responses (~300ms).
 * Always produces a quick response, then decides whether the full
 * Claude Code agent needs to be invoked.
 *
 * Receives full thread history so it can understand conversational context.
 */
export async function runRouter(
  messageText: string,
  threadMessages: ThreadMessage[] = [],
): Promise<RouterResult> {
  // Use multi-turn conversation when thread history exists,
  // otherwise fall back to single message
  const messages =
    threadMessages.length > 1
      ? buildConversationMessages(threadMessages)
      : [{ role: "user" as const, content: messageText }];

  const request = {
    model: HAIKU_MODEL,
    max_tokens: 256,
    system: ROUTER_SYSTEM_PROMPT,
    messages,
  };

  try {
    const response = await anthropic.messages.create(request);
    const parsed = parseJsonResponse(response);

    return {
      quickResponse: String(parsed.quickResponse || ""),
      needsAgent: parsed.needsAgent === true,
      reason: String(parsed.reason || ""),
      request: request as unknown as Record<string, unknown>,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  } catch (error) {
    console.error("Router error:", error);
  }

  return {
    quickResponse: "I'm having a moment — give me a sec and try again.",
    needsAgent: true,
    reason: "router error",
    request: request as unknown as Record<string, unknown>,
    rawResponse: {},
  };
}
