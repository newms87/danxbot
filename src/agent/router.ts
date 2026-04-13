import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { isOperationalError } from "../errors/patterns.js";
import { parseJsonResponse } from "./parse-json-response.js";
import { trimThreadMessages } from "../threads.js";
import { FEATURE_LIST, FEATURE_EXAMPLES } from "./features.js";
import type { ApiCallUsage, ComplexityLevel, RouterResult, ThreadMessage } from "../types.js";
import { buildApiCallUsage } from "./pricing.js";

const log = createLogger("router");

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const ROUTER_SYSTEM_PROMPT = [
  "You are Danxbot, a friendly codebase knowledge assistant for the engineering team.",
  "You live in a dedicated Slack channel. Every message is directed at you.",
  "You receive the full conversation thread, so you can reference earlier messages.",
  "",
  "Respond with JSON only (no markdown, no code fences):",
  '{"quickResponse": "...", "needsAgent": true/false, "complexity": "very_low"|"low"|"medium"|"high"|"very_high", "reason": "..."}',
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
  "complexity: Determines the agent tier. Pick the LOWEST level that can handle the question.",
  '- very_low: Single direct lookup, 1 tool call. "How many active records?", "Show me user X", "What\'s the schema for orders?"',
  '- low: 1-3 tool calls, straightforward. "Show recent records with related names", "What columns does the users table have?"',
  '- medium: Moderate exploration, 3-6 tool calls. "How does filtering work?", "What triggers a status change?"',
  '- high: Multi-step investigation, cross-referencing. "Why might a record show wrong status?", "Walk me through the approval flow"',
  '- very_high: Deep exploration across multiple domains. "Explain the entire billing lifecycle end-to-end", "Compare the two workflows"',
  'When needsAgent is false, set complexity to "very_low".',
  "",
  "reason: Brief explanation of your routing decision.",
  "",
  'When the user seems unsure, asks "what can you do?", sends a vague or exploratory',
  'message, or says "help":',
  "- Set quickResponse to a friendly message that picks 2-3 relevant features from the list below",
  "- Include 1-2 example questions they could try",
  "- Set needsAgent to false",
  '- Set complexity to "very_low"',
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
  '- Set complexity to "very_low"',
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
  // Trim thread messages to prevent token overflow, then build conversation
  const trimmed = trimThreadMessages(threadMessages, config.agent.maxThreadMessages);
  const messages =
    trimmed.length > 1
      ? buildConversationMessages(trimmed)
      : [{ role: "user" as const, content: messageText }];

  const routerModel = config.agent.routerModel;
  const request = {
    model: routerModel,
    max_tokens: 256,
    system: ROUTER_SYSTEM_PROMPT,
    messages,
  };

  try {
    const response = await anthropic.messages.create(request);
    const usage = buildApiCallUsage(response.usage, routerModel, "router");
    const parsed = parseJsonResponse(response);

    const VALID_LEVELS = new Set<ComplexityLevel>(["very_low", "low", "medium", "high", "very_high"]);
    const rawComplexity = String(parsed.complexity || "");
    const complexity: ComplexityLevel = VALID_LEVELS.has(rawComplexity as ComplexityLevel)
      ? (rawComplexity as ComplexityLevel)
      : "high";

    return {
      quickResponse: String(parsed.quickResponse || ""),
      needsAgent: parsed.needsAgent === true,
      complexity,
      reason: String(parsed.reason || ""),
      error: null,
      request: request as unknown as Record<string, unknown>,
      rawResponse: response as unknown as Record<string, unknown>,
      usage,
    };
  } catch (error) {
    log.error("Router error", error);

    const errorMessage = error instanceof Error ? error.message : String(error);

    const isOperational = isOperationalError(errorMessage);

    return {
      quickResponse: isOperational
        ? "I'm temporarily unavailable due to a service configuration issue. The team has been notified."
        : "I'm having a moment — give me a sec and try again.",
      needsAgent: false,
      complexity: "very_low",
      reason: "router error",
      error: errorMessage,
      isOperational,
      request: request as unknown as Record<string, unknown>,
      rawResponse: {},
      usage: null,
    };
  }
}
