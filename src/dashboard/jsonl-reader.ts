import { readFile, readdir, access } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("jsonl-reader");

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UserBlock {
  type: "user";
  text: string;
  timestampMs: number;
}

export interface AssistantTextBlock {
  type: "assistant_text";
  text: string;
  timestampMs: number;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  timestampMs: number;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  timestampMs: number;
  subagent?: SubagentTimeline;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
  timestampMs: number;
}

export interface SystemBlock {
  type: "system";
  subtype: string;
  summary: string;
  timestampMs: number;
}

export interface UsageBlock {
  type: "usage";
  usage: UsageTotals;
  timestampMs: number;
}

export type JsonlBlock =
  | UserBlock
  | AssistantTextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | SystemBlock
  | UsageBlock;

export interface SubagentTimeline {
  agentType: string;
  description: string;
  sessionId: string | null;
  blocks: JsonlBlock[];
  totals: JsonlTotals;
}

export interface JsonlTotals extends UsageTotals {
  tokensTotal: number;
  toolCallCount: number;
  subagentCount: number;
}

export interface JsonlReadResult {
  blocks: JsonlBlock[];
  totals: JsonlTotals;
  sessionId: string | null;
}

function parseTimestamp(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function readUsage(rawUsage: Record<string, unknown> | undefined): UsageTotals {
  if (!rawUsage) {
    return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return {
    tokensIn: Number(rawUsage.input_tokens ?? 0),
    tokensOut: Number(rawUsage.output_tokens ?? 0),
    cacheRead: Number(rawUsage.cache_read_input_tokens ?? 0),
    cacheWrite: Number(rawUsage.cache_creation_input_tokens ?? 0),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type?: string; text?: string } =>
        typeof c === "object" && c !== null,
    )
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/**
 * Parse a single raw JSONL line into zero or more normalized display blocks.
 * Returns an empty array for lines that carry no displayable content
 * (permission-mode, hooks, file-history snapshots, etc.).
 */
export function parseJsonlLine(raw: Record<string, unknown>): JsonlBlock[] {
  const timestampMs = parseTimestamp(raw.timestamp);
  const type = raw.type as string | undefined;

  if (type === "system") {
    const subtype = (raw.subtype as string | undefined) ?? "system";
    return [
      {
        type: "system",
        subtype,
        summary: typeof raw.summary === "string" ? raw.summary : subtype,
        timestampMs,
      },
    ];
  }

  if (type === "user") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = message.content;

    // Plain-text prompt
    if (typeof content === "string") {
      if (!content.trim()) return [];
      return [{ type: "user", text: content, timestampMs }];
    }

    if (!Array.isArray(content)) return [];

    const blocks: JsonlBlock[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      const btype = block.type as string | undefined;
      if (btype === "tool_result") {
        blocks.push({
          type: "tool_result",
          toolUseId: String(block.tool_use_id ?? ""),
          content: extractText(block.content) || String(block.content ?? ""),
          isError: block.is_error === true,
          timestampMs,
        });
      } else if (btype === "text" && typeof block.text === "string") {
        blocks.push({ type: "user", text: block.text, timestampMs });
      }
    }
    return blocks;
  }

  if (type === "assistant") {
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = message.content;
    if (!Array.isArray(content)) return [];

    const blocks: JsonlBlock[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      const btype = block.type as string | undefined;
      if (btype === "text" && typeof block.text === "string") {
        blocks.push({ type: "assistant_text", text: block.text, timestampMs });
      } else if (btype === "thinking" && typeof block.thinking === "string") {
        blocks.push({
          type: "thinking",
          text: block.thinking,
          timestampMs,
        });
      } else if (btype === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: (block.input as Record<string, unknown>) ?? {},
          timestampMs,
        });
      }
    }

    const usage = readUsage(message.usage as Record<string, unknown> | undefined);
    if (
      usage.tokensIn ||
      usage.tokensOut ||
      usage.cacheRead ||
      usage.cacheWrite
    ) {
      blocks.push({ type: "usage", usage, timestampMs });
    }
    return blocks;
  }

  return [];
}

function emptyTotals(): JsonlTotals {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokensTotal: 0,
    toolCallCount: 0,
    subagentCount: 0,
  };
}

function aggregateTotals(blocks: JsonlBlock[]): JsonlTotals {
  const totals = emptyTotals();
  for (const block of blocks) {
    if (block.type === "usage") {
      totals.tokensIn += block.usage.tokensIn;
      totals.tokensOut += block.usage.tokensOut;
      totals.cacheRead += block.usage.cacheRead;
      totals.cacheWrite += block.usage.cacheWrite;
    } else if (block.type === "tool_use") {
      totals.toolCallCount++;
      if (isSubagentTool(block.name)) totals.subagentCount++;
    }
  }
  totals.tokensTotal =
    totals.tokensIn + totals.tokensOut + totals.cacheRead + totals.cacheWrite;
  return totals;
}

/** Tool names that indicate a sub-agent invocation. */
function isSubagentTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

/**
 * Parse the JSONL body text into a stream of normalized blocks without
 * attempting to hydrate sub-agents. Callers that need sub-agent nesting
 * should use `parseJsonlFile` instead.
 */
export function parseJsonlContent(text: string): JsonlReadResult {
  const blocks: JsonlBlock[] = [];
  let sessionId: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && typeof raw.sessionId === "string") {
      sessionId = raw.sessionId;
    }

    for (const block of parseJsonlLine(raw)) blocks.push(block);
  }

  return { blocks, totals: aggregateTotals(blocks), sessionId };
}

/**
 * Read a parent JSONL file and, for each Agent/Task tool_use inside,
 * attempt to locate the matching sub-agent JSONL in the sibling
 * `subagents/` directory via its `meta.json` description field, hydrate
 * its timeline, and attach it to the parent block.
 */
export async function parseJsonlFile(
  filepath: string,
): Promise<JsonlReadResult> {
  let text: string;
  try {
    text = await readFile(filepath, "utf-8");
  } catch (err) {
    log.error(`Failed to read JSONL file ${filepath}`, err);
    return { blocks: [], totals: emptyTotals(), sessionId: null };
  }

  const result = parseJsonlContent(text);
  const subagentDir = join(
    dirname(filepath),
    basename(filepath, ".jsonl"),
    "subagents",
  );
  const subagentIndex = await loadSubagentIndex(subagentDir);
  if (subagentIndex.size === 0) return result;

  for (const block of result.blocks) {
    if (block.type !== "tool_use" || !isSubagentTool(block.name)) continue;
    const description = String(
      (block.input as { description?: unknown }).description ?? "",
    );
    if (!description) continue;
    const match = subagentIndex.get(description);
    if (!match) continue;
    const subResult = await parseJsonlContent(await readFile(match, "utf-8"));
    block.subagent = {
      agentType: String(
        (block.input as { subagent_type?: unknown }).subagent_type ?? "",
      ),
      description,
      sessionId: subResult.sessionId,
      blocks: subResult.blocks,
      totals: subResult.totals,
    };
  }

  // Recompute totals including nested sub-agent token/tool contributions.
  result.totals = aggregateTotalsWithSubagents(result.blocks);
  return result;
}

interface SubagentMeta {
  agentType?: string;
  description?: string;
}

/** Map from subagent description -> jsonl file path. */
async function loadSubagentIndex(dir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  try {
    await access(dir);
  } catch {
    return index;
  }
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return index;
  }
  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;
    const metaPath = join(dir, file);
    let meta: SubagentMeta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf-8"));
    } catch {
      continue;
    }
    if (!meta.description) continue;
    const jsonlPath = metaPath.replace(/\.meta\.json$/, ".jsonl");
    index.set(meta.description, jsonlPath);
  }
  return index;
}

function aggregateTotalsWithSubagents(blocks: JsonlBlock[]): JsonlTotals {
  const totals = aggregateTotals(blocks);
  for (const block of blocks) {
    if (block.type === "tool_use" && block.subagent) {
      totals.tokensIn += block.subagent.totals.tokensIn;
      totals.tokensOut += block.subagent.totals.tokensOut;
      totals.cacheRead += block.subagent.totals.cacheRead;
      totals.cacheWrite += block.subagent.totals.cacheWrite;
      totals.toolCallCount += block.subagent.totals.toolCallCount;
    }
  }
  totals.tokensTotal =
    totals.tokensIn + totals.tokensOut + totals.cacheRead + totals.cacheWrite;
  return totals;
}
