import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { isOperationalError } from "../errors/patterns.js";
import { parseJsonResponse } from "./parse-json-response.js";
import { trimThreadMessages } from "../threads.js";
import { FEATURE_LIST, FEATURE_EXAMPLES } from "./features.js";
import type { RouterResult, ThreadMessage } from "../types.js";
import { buildApiCallUsage } from "./pricing.js";

const log = createLogger("router");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const ROUTER_SYSTEM_PROMPT = [
  "You are Danxbot, a friendly codebase knowledge assistant for the engineering team.",
  "You live in a dedicated Slack channel. Every message is directed at you.",
  "You receive the full conversation thread, so you can reference earlier messages.",
  "",
  "Respond with JSON only (no markdown, no code fences):",
  '{"quickResponse": "...", "needsAgent": true/false, "reason": "..."}',
  "",
  "quickResponse: A short, friendly reply to the user. For greetings, greet them back.",
  "For questions, acknowledge the question and say you're looking into it.",
  "Keep it to 1-2 sentences. Be warm and helpful.",
  "Always encourage the user to ask questions about the codebase or its data.",
  "Use the conversation history to give contextual, non-repetitive responses.",
  "",
  "needsAgent: true if the user is asking something that requires exploring the",
  "codebase, querying the database, or deep domain knowledge. false if your",
  "quickResponse fully handles it (greetings, small talk, simple acknowledgments).",
  "",
  "reason: Brief explanation of your routing decision.",
  "",
  'When the user seems unsure, asks "what can you do?", sends a vague or exploratory',
  'message, or says "help":',
  "- Set quickResponse to a friendly message that picks 2-3 relevant features from the list below",
  "- Include 1-2 example questions they could try",
  "- Set needsAgent to false",
  "- Keep it concise — 2-3 bullet points max, not the full feature list",
  "",
  "## Available Features",
  "",
  FEATURE_LIST,
  "",
  FEATURE_EXAMPLES,
  "",
  "## Feature Requests",
  "",
  "When the user asks you to do something you can't, asks for a new feature or capability,",
  'or says something like "can you add that?", "can you do X?", "feature request":',
  '- Set needsAgent to true (the agent can create Trello cards for feature requests)',
  '- Set quickResponse to acknowledge the request and say you\'re looking into it',
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
  // Trim thread messages to prevent token overflow.
  // Only send user messages as context — bot responses are natural language
  // that confuses the model into responding conversationally instead of as JSON.
  const trimmed = trimThreadMessages(threadMessages, config.agent.maxThreadMessages);
  const userMessages = trimmed.filter((m) => !m.isBot);
  let messages: Array<{ role: "user" | "assistant"; content: string }>;
  if (userMessages.length > 1) {
    // Combine earlier user messages as context, current message separate
    const history = userMessages.slice(0, -1).map((m) => m.text).join("\n");
    const current = userMessages[userMessages.length - 1].text;
    messages = [{ role: "user", content: `[Earlier in thread]\n${history}\n\n[Current message]\n${current}` }];
  } else {
    messages = [{ role: "user", content: messageText }];
  }

  const routerModel = config.agent.routerModel;
  const request = {
    model: routerModel,
    max_tokens: 256,
    system: ROUTER_SYSTEM_PROMPT,
    messages,
  };

  const maxAttempts = 2;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await anthropic.messages.create(request);
      const usage = buildApiCallUsage(response.usage, routerModel, "router");
      const parsed = parseJsonResponse(response);

      return {
        quickResponse: String(parsed.quickResponse || ""),
        needsAgent: parsed.needsAgent === true,
        reason: String(parsed.reason || ""),
        error: null,
        request: request as unknown as Record<string, unknown>,
        rawResponse: response as unknown as Record<string, unknown>,
        usage,
      };
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Only retry on JSON parse errors — API errors won't improve on retry
      if (error instanceof SyntaxError && attempt < maxAttempts - 1) {
        log.warn(`Router JSON parse failed (attempt ${attempt + 1}/${maxAttempts}), retrying: ${errorMessage}`);
        continue;
      }

      break;
    }
  }

  const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  log.error("Router error", lastError);

  const isOperational = isOperationalError(errorMessage);

  return {
    quickResponse: isOperational
      ? "I'm temporarily unavailable due to a service configuration issue. The team has been notified."
      : "I'm having a moment — give me a sec and try again.",
    needsAgent: false,
    reason: "router error",
    error: errorMessage,
    isOperational,
    request: request as unknown as Record<string, unknown>,
    rawResponse: {},
    usage: null,
  };
}
