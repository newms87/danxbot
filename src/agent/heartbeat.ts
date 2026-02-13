import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { parseJsonResponse, HAIKU_MODEL } from "./parse-json-response.js";
import type {
  AgentLogEntry,
  HeartbeatSnapshot,
  HeartbeatUpdate,
} from "../types.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

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

const RECENT_LOG_ENTRIES = 8;

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
    .slice(-RECENT_LOG_ENTRIES)
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
      model: HAIKU_MODEL,
      max_tokens: 150,
      system: HEARTBEAT_SYSTEM_PROMPT,
      messages,
    });

    const parsed = parseJsonResponse(response);

    return {
      emoji: String(parsed.emoji || HEARTBEAT_FALLBACK.emoji),
      color: String(parsed.color || HEARTBEAT_FALLBACK.color),
      text: String(parsed.text || HEARTBEAT_FALLBACK.text),
      stop: parsed.stop === true,
    };
  } catch (error) {
    console.error("Heartbeat message generation failed:", error);
    return { ...HEARTBEAT_FALLBACK };
  }
}
