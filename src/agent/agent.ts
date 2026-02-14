import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { trimThreadMessages } from "../threads.js";
import type { AgentLogEntry, AgentResponse, ThreadMessage } from "../types.js";

const log = createLogger("agent");

// Re-export router and heartbeat modules so existing imports continue to work
export { buildConversationMessages, runRouter } from "./router.js";
export {
  buildActivitySummary,
  generateHeartbeatMessage,
} from "./heartbeat.js";

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

  // Trim thread messages to prevent token overflow
  const trimmed = trimThreadMessages(threadMessages, config.agent.maxThreadMessages);

  // When resuming a session, the SDK already has conversation history.
  // Otherwise, prepend thread context so the agent understands the conversation.
  let agentPrompt = messageText;
  if (!sessionId && trimmed.length > 1) {
    const history = trimmed
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
      log.debug(message.trimEnd());
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
  const agentLog: AgentLogEntry[] = [];
  let lastTimestamp = Date.now();
  const pushLog = (entry: AgentLogEntry) => {
    entry.data.delta_ms = entry.timestamp - lastTimestamp;
    lastTimestamp = entry.timestamp;
    agentLog.push(entry);
    onLogEntry?.(entry);
  };

  let caughtError: Error | null = null;

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
    caughtError = new Error(
      `${err instanceof Error ? err.message : String(err)}${detail}`,
    );
  } finally {
    // Always write agent log to disk, even on crash
    writeAgentLog({
      prompt: agentPrompt,
      sessionId: resultSessionId,
      model: config.agent.model,
      costUsd,
      turns,
      log: agentLog,
    }).catch((err) => log.error("Failed to write agent log", err));
  }

  if (caughtError) {
    throw caughtError;
  }

  if (!resultText) {
    resultText = "I wasn't able to generate a response. Please try again.";
  }

  return {
    text: resultText,
    sessionId: resultSessionId,
    costUsd,
    turns,
    config: queryOptions as unknown as Record<string, unknown>,
    log: agentLog,
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
  log.info(`Agent log written to ${filePath}`);
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
