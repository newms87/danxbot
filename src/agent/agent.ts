import Anthropic from "@anthropic-ai/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { config } from "../config.js";
import type {
  AgentLogEntry,
  AgentResponse,
  HeartbeatSnapshot,
  HeartbeatUpdate,
  RouterResult,
  ThreadMessage,
} from "../types.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

let systemPrompt: string | null = null;

async function getSystemPrompt(): Promise<string> {
  if (!systemPrompt) {
    systemPrompt = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
  }
  return systemPrompt;
}

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
    model: "claude-haiku-4-5-20251001" as const,
    max_tokens: 256,
    system: ROUTER_SYSTEM_PROMPT,
    messages,
  };

  try {
    const response = await anthropic.messages.create(request);

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    const jsonStr = text
      .replace(/```json\s*\n?/g, "")
      .replace(/```\s*$/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);

    return {
      quickResponse: parsed.quickResponse || "",
      needsAgent: parsed.needsAgent === true,
      reason: parsed.reason || "",
      request: request as unknown as Record<string, unknown>,
      rawResponse: response as unknown as Record<string, unknown>,
    };
  } catch (error) {
    console.error("Router error:", error);
  }

  return {
    quickResponse: "",
    needsAgent: false,
    reason: "router error",
    request: request as unknown as Record<string, unknown>,
    rawResponse: {},
  };
}

const HEARTBEAT_SYSTEM_PROMPT = [
  "You are Flytebot's orchestrator. You dispatched an AI agent to research a question",
  "and you're giving the user status updates in Slack while they wait.",
  "",
  "Return JSON only — no markdown, no code fences, no explanation:",
  '{"emoji": ":detective:", "color": "#e67e22", "text": "...", "stop": false}',
  "",
  "Fields:",
  '- emoji: A Slack emoji shortcode that fits the mood (e.g. :mag:, :hourglass:, :sweat_smile:, :tada:)',
  "- color: A hex color for the Slack attachment sidebar that matches the mood",
  "- text: A 1-sentence status update, max ~20 words. Plain text, no markdown.",
  '- stop: Set to true ONLY when the agent appears to have crashed or fatally errored.',
  "  Signs: a result entry with subtype 'error', process exit codes, or zero activity",
  "  across many consecutive updates (4+) with no tool calls at all.",
  "  When stop is true, text should explain the failure and suggest the user try again.",
  "",
  "RULES FOR THE NARRATIVE:",
  "- You see your previous messages as assistant turns. NEVER repeat yourself.",
  "- Build a running narrative across updates — continue the story, evolve the tone.",
  "- When the agent has NEW activity: describe what it's doing in plain English.",
  "- When the log HASN'T changed: escalate a comedic subplot (searching for the agent,",
  "  filing missing persons reports, organizing search parties, calling in the FBI, etc.)",
  "- Vary your emoji and color each time — match them to the mood of your message.",
  "- Be entertaining. The user is waiting and bored. Make them smile.",
].join("\n");

const HEARTBEAT_FALLBACK: HeartbeatUpdate = {
  emoji: ":hourglass_flowing_sand:",
  color: "#6c5ce7",
  text: "Working on it...",
  stop: false,
};

/**
 * Builds an activity summary string from recent agent log entries.
 */
export function buildActivitySummary(
  log: AgentLogEntry[],
  sinceIndex: number,
  elapsedSeconds: number,
): string {
  const newEntries = log.slice(sinceIndex);
  const activitySummary = newEntries
    .slice(-8)
    .map((e) => `[${e.type}] ${e.summary}`)
    .join("\n");

  const toolEntries = log.filter(
    (e) =>
      e.type === "assistant" &&
      Array.isArray(e.data.content) &&
      (e.data.content as any[]).some((b: any) => b.type === "tool_use"),
  );

  const toolCounts: Record<string, number> = {};
  for (const entry of toolEntries) {
    for (const block of entry.data.content as any[]) {
      if (block.type === "tool_use") {
        const name = block.name || "unknown";
        toolCounts[name] = (toolCounts[name] || 0) + 1;
      }
    }
  }
  const toolSummary = Object.entries(toolCounts)
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");

  return [
    `Elapsed: ${elapsedSeconds}s`,
    `Total log entries: ${log.length} (${newEntries.length} new since last update)`,
    `Total tool calls: ${toolEntries.length} (${toolSummary || "none yet"})`,
    "",
    newEntries.length > 0 ? "New activity:" : "No new activity since last update.",
    activitySummary || "",
  ]
    .join("\n")
    .trim();
}

/**
 * Calls Haiku to generate a personality-driven heartbeat status message.
 * Builds a multi-turn conversation from previous snapshots so the orchestrator
 * has full memory of what it said before and what changed.
 *
 * The caller provides the current activity summary (built via buildActivitySummary)
 * so this function doesn't need to know about log entry counts.
 */
export async function generateHeartbeatMessage(
  currentSummary: string,
  previousSnapshots: HeartbeatSnapshot[],
): Promise<HeartbeatUpdate> {
  // Build multi-turn conversation: replay previous cycles
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const snapshot of previousSnapshots) {
    messages.push({ role: "user", content: snapshot.activitySummary });
    messages.push({
      role: "assistant",
      content: JSON.stringify(snapshot.update),
    });
  }

  // Final user message: current state
  messages.push({ role: "user", content: currentSummary });

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: HEARTBEAT_SYSTEM_PROMPT,
      messages,
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    const jsonStr = text
      .replace(/```json\s*\n?/g, "")
      .replace(/```\s*$/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);

    return {
      emoji: parsed.emoji || HEARTBEAT_FALLBACK.emoji,
      color: parsed.color || HEARTBEAT_FALLBACK.color,
      text: parsed.text || HEARTBEAT_FALLBACK.text,
      stop: parsed.stop === true,
    };
  } catch (error) {
    console.error("Heartbeat message generation failed:", error);
    return { ...HEARTBEAT_FALLBACK };
  }
}

/**
 * Runs the main Claude Code agent to answer a platform question.
 * Uses the Claude Code SDK (subscription auth) for codebase/DB exploration.
 * Optionally resumes a previous session for thread continuity.
 *
 * When onStream is provided, partial text deltas are streamed via the callback
 * as they arrive. The caller is responsible for throttling updates.
 */
export async function runAgent(
  messageText: string,
  sessionId: string | null,
  onStream?: (accumulatedText: string) => void,
  onLogEntry?: (entry: AgentLogEntry) => void,
  threadMessages: ThreadMessage[] = [],
): Promise<AgentResponse> {
  const prompt = await getSystemPrompt();

  // When resuming a session, the SDK already has conversation history.
  // Otherwise, prepend thread context so the agent understands the conversation.
  let agentPrompt = messageText;
  if (!sessionId && threadMessages.length > 1) {
    const history = threadMessages
      .slice(0, -1) // Exclude the current message (passed as messageText)
      .map((msg) => `${msg.isBot ? "Bot" : "User"}: ${msg.text}`)
      .join("\n");
    agentPrompt = `[Thread context]\n${history}\n\n[Current message]\n${messageText}`;
  }

  const stderrMessages: string[] = [];

  const queryOptions = {
    model: config.agent.model,
    systemPrompt: prompt,
    cwd: config.platform.repoPath,
    tools: ["Read", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    maxTurns: config.agent.maxTurns,
    maxBudgetUsd: config.agent.maxBudgetUsd,
    maxThinkingTokens: config.agent.maxThinkingTokens,
    persistSession: !!sessionId,
    includePartialMessages: !!onStream,
    stderr: (message: string) => {
      console.error("[agent stderr]", message.trimEnd());
      stderrMessages.push(message.trimEnd());
    },
    ...(sessionId ? { resume: sessionId } : {}),
  };

  const conversation = query({
    prompt: agentPrompt,
    options: queryOptions,
  });

  let resultText = "";
  let resultSessionId: string | null = null;
  let costUsd = 0;
  let turns = 0;
  let streamText = "";
  const log: AgentLogEntry[] = [];
  let lastTimestamp = Date.now();
  const pushLog = (entry: AgentLogEntry) => {
    entry.data.delta_ms = entry.timestamp - lastTimestamp;
    lastTimestamp = entry.timestamp;
    log.push(entry);
    onLogEntry?.(entry);
  };

  try {
  for await (const message of conversation) {
    if (message.type === "system" && message.subtype === "init") {
      resultSessionId = message.session_id;
      const msg = message as any;
      pushLog({
        timestamp: Date.now(),
        type: "system",
        subtype: "init",
        summary: `Session initialized: ${msg.model || config.agent.model}`,
        data: {
          session_id: message.session_id,
          model: msg.model,
          tools: msg.tools,
          raw: msg,
        },
      });
    } else if (message.type === "assistant") {
      const msg = message as any;
      const content = msg.message?.content || [];
      const toolUses = content.filter((b: any) => b.type === "tool_use");
      const textBlocks = content.filter((b: any) => b.type === "text");
      const toolNames = toolUses
        .map((t: any) => {
          const name = t.name || "unknown";
          const input = t.input || {};
          const detail = summarizeToolInput(name, input);
          return detail ? `${name}(${detail})` : name;
        })
        .join(", ");
      const textPreview = textBlocks
        .map((b: any) => b.text)
        .join(" ")
        .slice(0, 200);
      const summary = toolNames
        ? `Tools: ${toolNames}`
        : `Text: ${textPreview || "(empty)"}`;
      pushLog({
        timestamp: Date.now(),
        type: "assistant",
        summary,
        data: {
          content,
          usage: msg.message?.usage,
          raw: msg,
        },
      });
    } else if (message.type === "user") {
      const msg = message as any;
      const results = msg.message?.content || [];
      const toolNames = results
        .map((r: any) => r.tool_use_id || "result")
        .join(", ");
      pushLog({
        timestamp: Date.now(),
        type: "user",
        summary: `Tool results: ${toolNames}`,
        data: {
          content: results,
          raw: msg,
        },
      });
    } else if (message.type === "tool_progress") {
      const msg = message as any;
      pushLog({
        timestamp: Date.now(),
        type: "tool_progress",
        summary: `${msg.tool_name || "tool"} running (${msg.elapsed_time_seconds || 0}s)`,
        data: {
          tool_name: msg.tool_name,
          elapsed_time_seconds: msg.elapsed_time_seconds,
          raw: msg,
        },
      });
    } else if (message.type === "stream_event") {
      // Stream text deltas to the caller for live preview
      if (onStream) {
        const event = message.event as unknown as Record<string, unknown>;
        if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (
            delta?.type === "text_delta" &&
            typeof delta.text === "string"
          ) {
            streamText += delta.text;
            onStream(streamText);
          }
        }
      }
      // Skip logging stream_event — no diagnostic value
    } else if (message.type === "result") {
      const msg = message as any;
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;

      if (msg.subtype === "success") {
        resultText = msg.result;
      } else {
        resultText =
          `I ran into an issue while researching your question: ${msg.subtype}. ${msg.errors?.join(", ") || ""}`.trim();
      }

      pushLog({
        timestamp: Date.now(),
        type: "result",
        subtype: msg.subtype,
        summary: `${msg.subtype}: ${turns} turns, $${costUsd.toFixed(4)}, ${msg.duration_ms || 0}ms (api: ${msg.duration_api_ms || 0}ms)`,
        data: {
          subtype: msg.subtype,
          result_text: resultText,
          total_cost_usd: costUsd,
          num_turns: turns,
          duration_ms: msg.duration_ms,
          duration_api_ms: msg.duration_api_ms,
          is_error: msg.subtype !== "success",
          errors: msg.errors,
          raw: msg,
        },
      });
    }
  }
  } catch (err) {
    const stderrOutput = stderrMessages.join("\n");
    pushLog({
      timestamp: Date.now(),
      type: "error",
      summary: `Process error: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        error: err instanceof Error ? err.message : String(err),
        stderr: stderrOutput || null,
        raw: null,
      },
    });
    const detail = stderrOutput ? `\nstderr:\n${stderrOutput}` : "";
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}${detail}`,
    );
  }

  if (!resultText) {
    resultText = "I wasn't able to generate a response. Please try again.";
  }

  // Write full agent log to disk for post-mortem analysis
  writeAgentLog({
    prompt: agentPrompt,
    sessionId: resultSessionId,
    model: config.agent.model,
    costUsd,
    turns,
    log,
  }).catch((err) => console.error("Failed to write agent log:", err));

  return {
    text: resultText,
    sessionId: resultSessionId,
    costUsd,
    turns,
    config: queryOptions as unknown as Record<string, unknown>,
    log,
  };
}

async function writeAgentLog(data: {
  prompt: string;
  sessionId: string | null;
  model: string;
  costUsd: number;
  turns: number;
  log: AgentLogEntry[];
}): Promise<void> {
  await mkdir(config.logsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}_${data.sessionId || "no-session"}.json`;
  const filePath = join(config.logsDir, filename);
  await writeFile(filePath, JSON.stringify(data, null, 2));
  console.log(`Agent log written to ${filePath}`);
}

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