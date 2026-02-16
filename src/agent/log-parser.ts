import type { AgentLogEntry } from "../types.js";
import { summarizeToolInput } from "./tool-summary.js";

// --- Parsed log entry types ---

export interface ParsedSystemInit {
  type: "system_init";
  timestamp: number;
  deltaMs: number;
  sessionId: string;
  model: string;
  tools: string[];
}

export interface ParsedToolCall {
  id: string;
  name: string;
  inputSummary: string;
  input: Record<string, unknown>;
}

export interface ParsedAssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ParsedAssistant {
  type: "assistant";
  timestamp: number;
  deltaMs: number;
  thinking: string | null;
  text: string | null;
  toolCalls: ParsedToolCall[];
  model: string | null;
  usage: ParsedAssistantUsage | null;
}

export interface ParsedToolResultItem {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ParsedToolResult {
  type: "tool_result";
  timestamp: number;
  deltaMs: number;
  results: ParsedToolResultItem[];
}

export interface ParsedToolProgress {
  type: "tool_progress";
  timestamp: number;
  deltaMs: number;
  toolName: string;
  elapsedSeconds: number;
}

export interface ParsedResult {
  type: "result";
  timestamp: number;
  deltaMs: number;
  subtype: string;
  resultText: string;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  isError: boolean;
}

export interface ParsedError {
  type: "error";
  timestamp: number;
  deltaMs: number;
  message: string;
  stderr: string | null;
}

export type ParsedLogEntry =
  | ParsedSystemInit
  | ParsedAssistant
  | ParsedToolResult
  | ParsedToolProgress
  | ParsedResult
  | ParsedError;

const TOOL_RESULT_MAX_LENGTH = 1000;

/**
 * Transforms raw AgentLogEntry[] into structured, typed ParsedLogEntry[].
 * Extracts human-readable fields and strips noise (signatures, raw blobs).
 */
export function parseAgentLog(entries: AgentLogEntry[] | null | undefined): ParsedLogEntry[] {
  if (!entries || entries.length === 0) return [];

  const parsed: ParsedLogEntry[] = [];
  for (const entry of entries) {
    const result = parseEntry(entry);
    if (result) parsed.push(result);
  }
  return parsed;
}

function parseEntry(entry: AgentLogEntry): ParsedLogEntry | null {
  if (!entry.data) return null;
  const deltaMs = (entry.data.delta_ms as number) ?? 0;

  switch (entry.type) {
    case "system":
      if (entry.subtype === "init") return parseSystemInit(entry, deltaMs);
      return null;
    case "assistant":
      return parseAssistant(entry, deltaMs);
    case "user":
      return parseToolResult(entry, deltaMs);
    case "tool_progress":
      return parseToolProgress(entry, deltaMs);
    case "result":
      return parseResult(entry, deltaMs);
    case "error":
      return parseError(entry, deltaMs);
    default:
      return null;
  }
}

function parseSystemInit(entry: AgentLogEntry, deltaMs: number): ParsedSystemInit {
  const data = entry.data;
  return {
    type: "system_init",
    timestamp: entry.timestamp,
    deltaMs,
    sessionId: String(data.session_id ?? ""),
    model: String(data.model ?? ""),
    tools: Array.isArray(data.tools) ? (data.tools as string[]) : [],
  };
}

function parseAssistant(entry: AgentLogEntry, deltaMs: number): ParsedAssistant {
  const content = Array.isArray(entry.data.content) ? (entry.data.content as Record<string, unknown>[]) : [];
  const usage = entry.data.usage as Record<string, number> | undefined;
  const raw = entry.data.raw as Record<string, unknown> | undefined;
  const model = (raw?.message as Record<string, unknown>)?.model as string | undefined;

  // Extract thinking (first thinking block)
  const thinkingBlock = content.find((b) => b.type === "thinking");
  const thinking = thinkingBlock ? String(thinkingBlock.thinking ?? "") : null;

  // Extract text (concatenate all text blocks)
  const textBlocks = content.filter((b) => b.type === "text");
  const text = textBlocks.length > 0
    ? textBlocks.map((b) => String(b.text ?? "")).join("\n")
    : null;

  // Extract tool calls
  const toolCalls: ParsedToolCall[] = content
    .filter((b) => b.type === "tool_use")
    .map((b) => {
      const name = String(b.name ?? "unknown");
      const input = (b.input ?? {}) as Record<string, unknown>;
      return {
        id: String(b.id ?? ""),
        name,
        inputSummary: summarizeToolInput(name, input),
        input,
      };
    });

  // Parse usage
  const parsedUsage: ParsedAssistantUsage | null = usage
    ? {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      }
    : null;

  return {
    type: "assistant",
    timestamp: entry.timestamp,
    deltaMs,
    thinking,
    text,
    toolCalls,
    model: model ?? null,
    usage: parsedUsage,
  };
}

function parseToolResult(entry: AgentLogEntry, deltaMs: number): ParsedToolResult {
  const content = Array.isArray(entry.data.content) ? (entry.data.content as Record<string, unknown>[]) : [];

  const results: ParsedToolResultItem[] = content.map((block) => {
    const rawContent = block.content;
    let contentStr: string;

    if (Array.isArray(rawContent)) {
      // Content can be an array of text blocks
      contentStr = (rawContent as Record<string, unknown>[])
        .map((c) => String(c.text ?? ""))
        .join("\n");
    } else {
      contentStr = String(rawContent ?? "");
    }

    // Truncate long content (keeps total length at TOOL_RESULT_MAX_LENGTH)
    if (contentStr.length > TOOL_RESULT_MAX_LENGTH) {
      contentStr = contentStr.slice(0, TOOL_RESULT_MAX_LENGTH - 3) + "...";
    }

    return {
      toolUseId: String(block.tool_use_id ?? ""),
      content: contentStr,
      isError: Boolean(block.is_error),
    };
  });

  return {
    type: "tool_result",
    timestamp: entry.timestamp,
    deltaMs,
    results,
  };
}

function parseToolProgress(entry: AgentLogEntry, deltaMs: number): ParsedToolProgress {
  return {
    type: "tool_progress",
    timestamp: entry.timestamp,
    deltaMs,
    toolName: String(entry.data.tool_name ?? "unknown"),
    elapsedSeconds: (entry.data.elapsed_time_seconds as number) ?? 0,
  };
}

function parseResult(entry: AgentLogEntry, deltaMs: number): ParsedResult {
  const data = entry.data;
  return {
    type: "result",
    timestamp: entry.timestamp,
    deltaMs,
    subtype: String(data.subtype ?? "unknown"),
    resultText: String(data.result_text ?? ""),
    totalCostUsd: (data.total_cost_usd as number) ?? 0,
    numTurns: (data.num_turns as number) ?? 0,
    durationMs: (data.duration_ms as number) ?? 0,
    durationApiMs: (data.duration_api_ms as number) ?? 0,
    isError: Boolean(data.is_error),
  };
}

function parseError(entry: AgentLogEntry, deltaMs: number): ParsedError {
  return {
    type: "error",
    timestamp: entry.timestamp,
    deltaMs,
    message: String(entry.data.error ?? "Unknown error"),
    stderr: entry.data.stderr ? String(entry.data.stderr) : null,
  };
}
