import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { config, COMPLEXITY_PROFILES, getPrimaryRepoPath } from "../config.js";
import { createLogger } from "../logger.js";
import { trimThreadMessages } from "../threads.js";
import { FEATURE_LIST } from "./features.js";
import type { AgentLogEntry, AgentResponse, AgentUsageSummary, ComplexityLevel, ModelUsage, ThreadMessage } from "../types.js";
import { summarizeToolInput } from "./tool-summary.js";

export { summarizeToolInput, truncStr } from "./tool-summary.js";

const log = createLogger("agent");

let systemPrompt: string | null = null;
let fastSystemPrompt: string | null = null;

async function getSystemPrompt(): Promise<string> {
  if (!systemPrompt) {
    const raw = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
    systemPrompt = raw
      .replace("{{FEATURE_LIST}}", FEATURE_LIST)
      .replace(/\{\{REVIEW_LIST_ID\}\}/g, config.trello.reviewListId);
  }
  return systemPrompt;
}

async function getFastSystemPrompt(): Promise<string> {
  if (!fastSystemPrompt) {
    const raw = await readFile(
      new URL("./fast-system-prompt.md", import.meta.url),
      "utf-8",
    );
    fastSystemPrompt = raw.replace(/\{\{REVIEW_LIST_ID\}\}/g, config.trello.reviewListId);
  }
  return fastSystemPrompt;
}

interface ExecuteAgentOptions {
  queryOptions: Record<string, unknown>;
  agentPrompt: string;
  modelLabel: string;
  onStream?: (accumulatedText: string) => void;
  onLogEntry?: (entry: AgentLogEntry) => void;
}

/**
 * Shared stream-processing core for all agent invocations.
 * Handles the for-await loop over SDK messages, log collection,
 * error handling, and log file writing.
 */
async function executeAgent(opts: ExecuteAgentOptions): Promise<AgentResponse> {
  const { queryOptions, agentPrompt, modelLabel, onStream, onLogEntry } = opts;
  const stderrMessages: string[] = [];

  const fullOptions = {
    ...queryOptions,
    stderr: (message: string) => {
      log.debug(message.trimEnd());
      stderrMessages.push(message.trimEnd());
    },
  };

  const conversation = query({
    prompt: agentPrompt,
    options: fullOptions,
  });

  let resultText = "";
  let resultError: string | null = null;
  let resultSessionId: string | null = null;
  let subscriptionCostUsd = 0;
  let turns = 0;
  let resultUsage: AgentUsageSummary | null = null;
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
          summary: `Session initialized: ${msg.model || modelLabel}`,
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
        subscriptionCostUsd = msg.total_cost_usd;
        turns = msg.num_turns;

        // Extract granular usage from SDK result
        const sdkUsage = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
        const sdkModelUsage = msg.model_usage as Record<string, { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost?: number }> | undefined;
        if (sdkUsage) {
          const modelUsage: Record<string, ModelUsage> = {};
          if (sdkModelUsage) {
            for (const [model, mu] of Object.entries(sdkModelUsage)) {
              modelUsage[model] = {
                inputTokens: mu.input_tokens ?? 0,
                outputTokens: mu.output_tokens ?? 0,
                cacheReadInputTokens: mu.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens: mu.cache_creation_input_tokens ?? 0,
                costUsd: mu.cost ?? 0,
              };
            }
          }
          resultUsage = {
            totalCostUsd: subscriptionCostUsd,
            durationMs: msg.duration_ms ?? 0,
            durationApiMs: msg.duration_api_ms ?? 0,
            numTurns: turns,
            inputTokens: sdkUsage.input_tokens ?? 0,
            outputTokens: sdkUsage.output_tokens ?? 0,
            cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: sdkUsage.cache_read_input_tokens ?? 0,
            modelUsage,
          };
        }

        if (msg.subtype === "success" && !msg.is_error) {
          resultText = msg.result;
        } else if (msg.subtype === "success" && msg.is_error) {
          resultText = msg.result;
          resultError = msg.result;
        } else {
          resultText =
            `I ran into an issue while researching your question: ${msg.subtype}. ${msg.errors?.join(", ") || ""}`.trim();
        }

        pushLog({
          timestamp: Date.now(),
          type: "result",
          subtype: msg.subtype,
          summary: `${msg.subtype}: ${turns} turns, $${subscriptionCostUsd.toFixed(4)}, ${msg.duration_ms || 0}ms (api: ${msg.duration_api_ms || 0}ms)`,
          data: {
            subtype: msg.subtype,
            result_text: resultText,
            total_cost_usd: subscriptionCostUsd,
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
    // Prefer the descriptive error from a result message with is_error: true
    // over a generic process exit message
    const errorMessage = resultError ?? (err instanceof Error ? err.message : String(err));
    const detail = stderrOutput ? `\nstderr:\n${stderrOutput}` : "";
    caughtError = new Error(`${errorMessage}${detail}`);
  } finally {
    // Always write agent log to disk, even on crash
    writeAgentLog({
      prompt: agentPrompt,
      sessionId: resultSessionId,
      model: modelLabel,
      costUsd: subscriptionCostUsd,
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
    subscriptionCostUsd,
    turns,
    config: fullOptions as unknown as Record<string, unknown>,
    log: agentLog,
    usage: resultUsage,
  };
}

/**
 * Runs the Claude Code agent to answer a platform question.
 * Uses the Claude Code SDK (subscription auth) for codebase/DB exploration.
 * Optionally resumes a previous session for thread continuity.
 *
 * When complexity is provided, the matching profile overrides model/turns/budget/tokens.
 * When onStream is provided, partial text deltas are streamed via the callback.
 */
export async function runAgent(
  messageText: string,
  sessionId: string | null,
  onStream?: (accumulatedText: string) => void,
  onLogEntry?: (entry: AgentLogEntry) => void,
  threadMessages: ThreadMessage[] = [],
  complexity?: ComplexityLevel,
): Promise<AgentResponse> {
  // Resolve profile overrides if complexity is specified
  const profile = complexity ? COMPLEXITY_PROFILES[complexity] : null;
  const promptText = profile && profile.systemPrompt === "fast"
    ? await getFastSystemPrompt()
    : await getSystemPrompt();
  const model = profile?.model ?? config.agent.model;

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

  const queryOptions = {
    model,
    systemPrompt: promptText,
    cwd: getPrimaryRepoPath(),
    settingSources: ["project"],
    tools: ["Read", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    maxTurns: profile?.maxTurns ?? config.agent.maxTurns,
    maxBudgetUsd: profile?.maxBudgetUsd ?? config.agent.maxBudgetUsd,
    maxThinkingTokens: profile?.maxThinkingTokens ?? config.agent.maxThinkingTokens,
    persistSession: true,
    includePartialMessages: !!onStream,
    ...(sessionId ? { resume: sessionId } : {}),
  };

  return executeAgent({
    queryOptions,
    agentPrompt,
    modelLabel: model,
    onStream,
    onLogEntry,
  });
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

