/**
 * SessionLogWatcher — Polls Claude Code JSONL session files for new entries.
 *
 * Claude Code writes a complete session log to ~/.claude/projects/<cwd-path>/<session-uuid>.jsonl.
 * This watcher polls the file at a configurable interval, reads new lines from the last byte offset,
 * parses them as JSON, converts to AgentLogEntry format, and emits to registered consumers.
 *
 * Used by all agent modes (SDK, piped, terminal) to provide unified session observability.
 */

import { realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import {
  buildAssistantSummary,
  buildToolResultSummary,
} from "./tool-summary.js";
import type { AgentLogEntry } from "../types.js";

const log = createLogger("session-log-watcher");

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const FILE_DISCOVERY_POLL_MS = 1_000;
const MAX_FILE_DISCOVERY_ATTEMPTS = 60; // 60s max wait for file to appear

/**
 * Tag prefix injected into the piped prompt by the launcher. The watcher scans
 * JSONL files for this tag to deterministically find the correct session file
 * for a given dispatch, avoiding mtime-based heuristics that can pick up the
 * wrong file (e.g., an active human session).
 */
export const DISPATCH_TAG_PREFIX = "<!-- danxbot-dispatch:";

export type EntryConsumer = (entry: AgentLogEntry) => void;

export interface SessionLogWatcherOptions {
  /** Working directory the agent was launched in. Used to derive the session directory. */
  cwd: string;
  /** How often to poll for new entries in milliseconds. Default: 5000. */
  pollIntervalMs?: number;
  /** Specific session ID to watch. If omitted, watches the newest .jsonl file. */
  sessionId?: string;
  /** Override the session directory path (for testing). */
  sessionDir?: string;
  /**
   * Dispatch job ID to search for in JSONL file content.
   * When set, the watcher scans files for the `<!-- danxbot-dispatch:<id> -->` tag
   * instead of picking the newest file by mtime. This prevents picking up the wrong
   * session file (e.g., an active human session) when the agent's file doesn't exist yet.
   */
  dispatchId?: string;
}

/**
 * Derives the Claude Code session directory from a working directory path.
 * Claude Code stores sessions at ~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/
 */
export function deriveSessionDir(cwd: string): string {
  const normalized = cwd.startsWith("/") ? cwd : `/${cwd}`;
  let resolved: string;
  try {
    resolved = realpathSync(normalized);
  } catch {
    // Path doesn't exist yet — use as-is (agent may not have started)
    resolved = normalized;
  }
  const dirName = resolved.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", dirName);
}

/**
 * Finds the newest .jsonl file in a directory.
 * Returns the full path, or null if no .jsonl files exist.
 */
export async function findNewestJsonlFile(
  dir: string,
  sessionId?: string,
): Promise<string | null> {
  try {
    const files = await readdir(dir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    if (jsonlFiles.length === 0) return null;

    // If a specific session ID is requested, look for that exact file
    if (sessionId) {
      const target = `${sessionId}.jsonl`;
      if (jsonlFiles.includes(target)) {
        return join(dir, target);
      }
      return null;
    }

    // Find the newest by mtime
    let newest: { path: string; mtime: number } | null = null;
    for (const file of jsonlFiles) {
      const filePath = join(dir, file);
      const stats = await stat(filePath);
      const mtime = stats.mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { path: filePath, mtime };
      }
    }

    return newest?.path ?? null;
  } catch (err) {
    // Directory doesn't exist yet — expected during agent startup
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Finds a JSONL session file that contains the dispatch tag for a specific job ID.
 *
 * Scans the first 64KB of each .jsonl file in the directory for the dispatch tag
 * `<!-- danxbot-dispatch:<dispatchId> -->`. This tag is injected into the piped
 * prompt by the launcher, so it appears in an early `user` JSONL entry.
 *
 * Returns the full path to the matching file, or null if no file matches.
 */
export async function findSessionFileByDispatchId(
  dir: string,
  dispatchId: string,
): Promise<string | null> {
  const tag = `${DISPATCH_TAG_PREFIX}${dispatchId} -->`;
  const SCAN_BYTES = 65_536; // 64KB — enough to cover the prompt entry

  try {
    const files = await readdir(dir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      const filePath = join(dir, file);
      let fd;
      try {
        fd = await open(filePath, "r");
        const fileStats = await stat(filePath);
        const bytesToRead = Math.min(fileStats.size, SCAN_BYTES);
        const buffer = Buffer.alloc(bytesToRead);
        await fd.read(buffer, 0, bytesToRead, 0);
        const content = buffer.toString("utf-8", 0, bytesToRead);
        if (content.includes(tag)) {
          return filePath;
        }
      } finally {
        await fd?.close();
      }
    }

    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Converts a raw JSONL entry from Claude Code's session log into an AgentLogEntry
 * compatible with log-parser.ts's parseAgentLog().
 *
 * JSONL format:
 *   { type: "assistant", message: { model, content: [...], usage: {...} }, timestamp: "ISO", sessionId, ... }
 *   { type: "user", message: { content: [{type: "tool_result", ...}] }, timestamp: "ISO", sessionId, ... }
 *   { type: "system", subtype: "turn_duration", durationMs, messageCount, timestamp: "ISO", ... }
 *
 * Returns `{ entry, timestamp }` or null. The timestamp is returned separately so the
 * caller can track it for delta_ms computation across consecutive entries.
 *
 * Returns null for entries that should be skipped (metadata, non-loggable).
 */
export function convertJsonlEntry(
  raw: Record<string, unknown>,
  lastTimestamp: number,
): { entry: AgentLogEntry; timestamp: number } | null {
  const type = raw.type as string;
  const timestamp = raw.timestamp
    ? new Date(raw.timestamp as string).getTime()
    : Date.now();
  const deltaMs = lastTimestamp > 0 ? timestamp - lastTimestamp : 0;
  const message = raw.message as Record<string, unknown> | undefined;

  switch (type) {
    case "assistant": {
      if (!message) return null;
      const content = (message.content ?? []) as Record<string, unknown>[];
      const usage = message.usage as Record<string, number> | undefined;

      return {
        entry: {
          timestamp,
          type: "assistant",
          summary: buildAssistantSummary(content),
          data: {
            content,
            usage,
            delta_ms: deltaMs,
            raw,
          },
        },
        timestamp,
      };
    }

    case "user": {
      if (!message) return null;
      const content = message.content;

      // Skip plain text user messages (prompts) — only tool results are loggable
      if (typeof content === "string") return null;
      const contentArr = (content ?? []) as Record<string, unknown>[];
      if (contentArr.length === 0) return null;

      // Only process tool_result content blocks
      const hasToolResults = contentArr.some((b) => b.type === "tool_result");
      if (!hasToolResults) return null;

      return {
        entry: {
          timestamp,
          type: "user",
          summary: buildToolResultSummary(contentArr),
          data: {
            content: contentArr,
            delta_ms: deltaMs,
            raw: raw,
          },
        },
        timestamp,
      };
    }

    case "system": {
      const subtype = raw.subtype as string | undefined;

      if (subtype === "init") {
        // Rare — only present in SDK-mode JSONL, not interactive
        return {
          entry: {
            timestamp,
            type: "system",
            subtype: "init",
            summary: `Session initialized: ${(raw.model as string) || "unknown"}`,
            data: {
              session_id: raw.session_id as string,
              model: raw.model as string,
              tools: raw.tools as string[],
              delta_ms: deltaMs,
              raw,
            },
          },
          timestamp,
        };
      }

      // Skip non-loggable system subtypes
      return null;
    }

    case "result": {
      // Result entry with cost/duration summary — written by Claude Code at session end
      const subtype = (raw.subtype as string) || "success";
      const costUsd = (raw.cost_usd as number) || 0;
      const numTurns = (raw.num_turns as number) || 0;
      return {
        entry: {
          timestamp,
          type: "result",
          subtype,
          summary: `${subtype}: ${numTurns} turns, $${costUsd.toFixed(4)}`,
          data: {
            subtype,
            result_text: (raw.result as string) || "",
            total_cost_usd: costUsd,
            num_turns: numTurns,
            duration_ms: (raw.duration_ms as number) || 0,
            duration_api_ms: (raw.duration_api_ms as number) || 0,
            is_error: Boolean(raw.is_error),
            delta_ms: deltaMs,
            raw,
          },
        },
        timestamp,
      };
    }

    default:
      // Skip metadata types: permission-mode, attachment, file-history-snapshot, queue-operation, last-prompt
      return null;
  }
}

export class SessionLogWatcher {
  private consumers: EntryConsumer[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private byteOffset = 0;
  private lineBuffer = "";
  private lastTimestamp = 0;
  private sessionFilePath: string | null = null;
  private sessionDir: string;
  private sessionId: string | undefined;
  private dispatchId: string | undefined;
  private pollIntervalMs: number;
  private running = false;
  private entries: AgentLogEntry[] = [];
  private initSynthesized = false;

  constructor(options: SessionLogWatcherOptions) {
    this.sessionDir = options.sessionDir ?? deriveSessionDir(options.cwd);
    this.sessionId = options.sessionId;
    this.dispatchId = options.dispatchId;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Register a consumer callback that receives each new AgentLogEntry. */
  onEntry(consumer: EntryConsumer): void {
    this.consumers.push(consumer);
  }

  /** Returns all entries collected so far. */
  getEntries(): AgentLogEntry[] {
    return this.entries;
  }

  /** Returns the discovered session file path, or null if not yet found. */
  getSessionFilePath(): string | null {
    return this.sessionFilePath;
  }

  /** Start polling for session log entries. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Phase 1: Discover the session file
    await this.discoverSessionFile();

    // Phase 2: Start polling for new entries
    if (this.running && this.sessionFilePath) {
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
      // Run an immediate poll
      await this.poll();
    }
  }

  /** Stop polling and clean up. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /**
   * Discover the JSONL session file. Polls until found or max attempts reached.
   * For dispatched agents, the file appears shortly after the process starts.
   */
  private async discoverSessionFile(): Promise<void> {
    for (let attempt = 0; attempt < MAX_FILE_DISCOVERY_ATTEMPTS; attempt++) {
      if (!this.running) return;

      // When a dispatch ID is set, scan file content for the tag instead of
      // relying on mtime (which can pick up the wrong session file).
      const filePath = this.dispatchId
        ? await findSessionFileByDispatchId(this.sessionDir, this.dispatchId)
        : await findNewestJsonlFile(this.sessionDir, this.sessionId);

      if (filePath) {
        this.sessionFilePath = filePath;
        log.info(`Watching session file: ${filePath}`);
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, FILE_DISCOVERY_POLL_MS),
      );
    }

    log.error(
      `Session file not found after ${MAX_FILE_DISCOVERY_ATTEMPTS}s in ${this.sessionDir}`,
    );
  }

  /** Read new lines from the session file and emit entries. */
  private async poll(): Promise<void> {
    if (!this.sessionFilePath || !this.running) return;

    try {
      const fileStats = await stat(this.sessionFilePath);
      if (fileStats.size <= this.byteOffset) return;

      const fd = await open(this.sessionFilePath, "r");
      try {
        const bytesToRead = fileStats.size - this.byteOffset;
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fd.read(
          buffer,
          0,
          bytesToRead,
          this.byteOffset,
        );

        if (bytesRead === 0) return;

        this.byteOffset += bytesRead;
        const text = buffer.toString("utf-8", 0, bytesRead);
        this.processText(text);
      } finally {
        await fd.close();
      }
    } catch (err) {
      // File may have been deleted or rotated — try to rediscover
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        log.warn("Session file disappeared, attempting rediscovery");
        this.sessionFilePath = null;
        this.byteOffset = 0;
        this.lineBuffer = "";
        await this.discoverSessionFile();
      } else {
        log.error("Poll error:", err);
      }
    }
  }

  /** Process raw text from the file, handling partial lines. */
  private processText(text: string): void {
    this.lineBuffer += text;

    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.substring(0, newlineIdx).trim();
      this.lineBuffer = this.lineBuffer.substring(newlineIdx + 1);

      if (!line) continue;

      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        this.handleRawEntry(raw);
      } catch {
        // Malformed JSON line — skip
        log.warn(`Skipping malformed JSONL line: ${line.substring(0, 100)}`);
      }
    }
  }

  /**
   * Convert a raw JSONL entry and emit to consumers.
   *
   * Init synthesis: Interactive JSONL files lack a system/init event, so we synthesize
   * one from the first assistant message's sessionId and model. If a real system/init
   * entry arrives first (SDK-mode JSONL), convertJsonlEntry handles it and we set
   * initSynthesized=true to prevent a duplicate. The check below only fires for
   * assistant entries, so it never conflicts with a preceding system/init.
   */
  private handleRawEntry(raw: Record<string, unknown>): void {
    // Synthesize a system init entry from the first assistant message
    if (!this.initSynthesized && raw.type === "assistant") {
      const message = raw.message as Record<string, unknown> | undefined;
      const model = message?.model as string | undefined;
      const sessionId = raw.sessionId as string | undefined;

      if (sessionId || model) {
        const initEntry: AgentLogEntry = {
          timestamp: raw.timestamp
            ? new Date(raw.timestamp as string).getTime()
            : Date.now(),
          type: "system",
          subtype: "init",
          summary: `Session initialized: ${model || "unknown"}`,
          data: {
            session_id: sessionId || "",
            model: model || "",
            tools: [],
            delta_ms: 0,
            raw: {},
          },
        };
        this.emitEntry(initEntry);
        this.initSynthesized = true;
      }
    }

    const result = convertJsonlEntry(raw, this.lastTimestamp);
    if (!result) return;

    // Mark init as synthesized if a real system init comes through
    if (result.entry.type === "system" && result.entry.subtype === "init") {
      this.initSynthesized = true;
    }

    this.lastTimestamp = result.timestamp;
    this.emitEntry(result.entry);
  }

  /** Emit an entry to all consumers and the internal accumulator. */
  private emitEntry(entry: AgentLogEntry): void {
    this.entries.push(entry);
    for (const consumer of this.consumers) {
      try {
        consumer(entry);
      } catch (err) {
        log.error("Consumer error:", err);
      }
    }
  }
}
