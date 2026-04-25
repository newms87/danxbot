/**
 * SessionLogWatcher — Polls Claude Code JSONL session files for new entries.
 *
 * Claude Code writes:
 *   - Parent session:   ~/.claude/projects/<cwd-path>/<session-uuid>.jsonl
 *   - Sub-agent sessions: ~/.claude/projects/<cwd-path>/<session-uuid>/subagents/agent-<hash>.jsonl
 *                        + agent-<hash>.meta.json sidecar with {agentType, description}
 *
 * The watcher tails the parent file and all sub-agent files in parallel, parses
 * new lines, converts them to AgentLogEntry, and emits to registered consumers.
 * Sub-agent entries are decorated with lineage metadata (subagent_id,
 * parent_session_id, agent_type) inside `data` so downstream consumers can
 * attribute usage correctly — they flow under the SAME dispatch, not a separate session.
 */

import { realpathSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import {
  buildAssistantSummary,
  buildToolResultSummary,
} from "./tool-summary.js";
import type { AgentLineage, AgentLogEntry } from "../types.js";

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
 * Claude Code stores sessions at ~/.claude/projects/<encoded-cwd>/, where
 * the encoded form replaces BOTH `/` and `.` with `-`. Verified empirically
 * against on-disk entries like `-home-newms-web-gpt-manager--danxbot-workspace`
 * (from `/home/newms/web/gpt-manager/.danxbot/workspace`) — the leading `.`
 * of `.danxbot` becomes the second dash in the `--danxbot` run.
 *
 * The dot-encoding only matters for dispatched-agent cwds, which live under
 * `.danxbot/workspace` (a hidden-directory segment). Previously the encoder
 * only replaced `/`, producing `-.danxbot-workspace` — a directory Claude
 * Code never writes to — which silently broke SessionLogWatcher attachment
 * for every host-mode dispatch. See Trello `9ZurZCK2`-adjacent failure
 * investigation and the `.danxbot`-path regression tests below.
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
  const dirName = resolved.replace(/[/.]/g, "-");
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
 * used by downstream consumers (stall detection, event forwarding).
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

      if (typeof content === "string") return null;
      const contentArr = (content ?? []) as Record<string, unknown>[];
      if (contentArr.length === 0) return null;

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

      return null;
    }

    case "result": {
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

/**
 * Per-file tail state. `lineage` is present for sub-agent files and used by
 * `emitEntry` to decorate entries — callers never pass lineage separately.
 */
interface TailState {
  filePath: string;
  byteOffset: number;
  lineBuffer: string;
  lastTimestamp: number;
  lineage?: AgentLineage;
}

export class SessionLogWatcher {
  private consumers: EntryConsumer[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private parentTail: TailState | null = null;
  private subagentsDir: string | null = null;
  private subagentTails: Map<string, TailState> = new Map();
  private parentSessionId: string | null = null;
  private sessionDir: string;
  private sessionId: string | undefined;
  private dispatchId: string | undefined;
  private pollIntervalMs: number;
  private running = false;
  private polling = false;
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

  /** Returns the discovered parent session file path, or null if not yet found. */
  getSessionFilePath(): string | null {
    return this.parentTail?.filePath ?? null;
  }

  /** Start polling for session log entries. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.discoverSessionFile();

    if (this.running && this.parentTail) {
      this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
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
   * Read any JSONL bytes appended since the last scheduled poll tick. Used by
   * the launcher's cleanup path to capture the agent's final assistant entry
   * (the one carrying the closing `usage` block + the `tool_use` for
   * `danxbot_complete`) before stop() halts polling. Without this, the row
   * finalized by `DispatchTracker.finalize` snapshots stale `job.usage` and
   * the dispatches table undercounts every token + counter field by exactly
   * what the JSONL grew between ticks.
   *
   * Race contract: if a scheduled `poll()` is already in flight when drain
   * is called, the first poll() invoked here would early-return at the
   * `this.polling` guard and silently miss the tail. To avoid that silent
   * skip we yield until the in-flight poll completes, then run our own
   * poll. The combined effect is "every byte written before drain returns
   * has been observed" — exactly the guarantee finalize depends on.
   *
   * No-op when the parent file has not been discovered (drain before
   * start, or start aborted) — there is nothing to read. Safe to call
   * after `stop()`; returns immediately.
   */
  async drain(): Promise<void> {
    if (!this.running || !this.parentTail) return;
    // Wait for any in-flight scheduled poll to finish so our subsequent
    // poll() doesn't hit the `this.polling` guard. The await yields so
    // setInterval-driven polls can complete; we only loop a few microtasks
    // in the worst case (one scheduled poll cycle).
    while (this.polling) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.poll();
  }

  /**
   * Discover the JSONL session file. Polls until found or max attempts reached.
   * For dispatched agents, the file appears shortly after the process starts.
   */
  private async discoverSessionFile(): Promise<void> {
    for (let attempt = 0; attempt < MAX_FILE_DISCOVERY_ATTEMPTS; attempt++) {
      if (!this.running) return;

      const filePath = this.dispatchId
        ? await findSessionFileByDispatchId(this.sessionDir, this.dispatchId)
        : await findNewestJsonlFile(this.sessionDir, this.sessionId);

      if (filePath) {
        this.setParentFile(filePath);
        const tag = this.dispatchId ? `[Dispatch ${this.dispatchId}] ` : "";
        log.info(`${tag}Watching session file: ${filePath}`);
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

  /** Adopt a parent session file and derive the sub-agent directory. */
  private setParentFile(filePath: string): void {
    this.parentTail = {
      filePath,
      byteOffset: 0,
      lineBuffer: "",
      lastTimestamp: 0,
    };
    this.subagentsDir = join(
      dirname(filePath),
      basename(filePath, ".jsonl"),
      "subagents",
    );
  }

  /**
   * Poll all known files: the parent session, then re-enumerate + tail sub-agent files.
   * Guarded against concurrent polls and against stop() racing an in-flight poll.
   */
  private async poll(): Promise<void> {
    if (this.polling || !this.parentTail || !this.running) return;
    this.polling = true;

    try {
      await this.pollFile(this.parentTail);
      if (!this.running) return;
      await this.discoverNewSubagentFiles();
      await this.refreshPendingAgentTypes();
      for (const state of this.subagentTails.values()) {
        if (!this.running) return;
        await this.pollFile(state);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Read any new bytes from `state.filePath` and emit resulting entries. */
  private async pollFile(state: TailState): Promise<void> {
    const isSubagent = state.lineage !== undefined;
    try {
      const fileStats = await stat(state.filePath);
      if (!this.running) return;
      if (fileStats.size <= state.byteOffset) return;

      const fd = await open(state.filePath, "r");
      try {
        if (!this.running) return;
        const bytesToRead = fileStats.size - state.byteOffset;
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fd.read(
          buffer,
          0,
          bytesToRead,
          state.byteOffset,
        );
        if (!this.running) return;

        if (bytesRead === 0) return;

        state.byteOffset += bytesRead;
        const text = buffer.toString("utf-8", 0, bytesRead);
        this.processText(text, state);
      } finally {
        await fd.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (isSubagent) {
          // Sub-agent file gone — drop it; next discoverNewSubagentFiles
          // will pick up any replacement.
          this.subagentTails.delete(state.filePath);
        } else {
          log.warn("Parent session file disappeared, attempting rediscovery");
          this.parentTail = null;
          this.subagentsDir = null;
          this.subagentTails.clear();
          this.parentSessionId = null;
          await this.discoverSessionFile();
        }
      } else {
        log.error("Poll error:", err);
      }
    }
  }

  /**
   * Re-enumerate the sub-agent directory and add tail states for any
   * `agent-<hash>.jsonl` files not already being tailed.
   */
  private async discoverNewSubagentFiles(): Promise<void> {
    if (!this.subagentsDir) return;

    let files: string[];
    try {
      files = await readdir(this.subagentsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log.error("Failed to enumerate sub-agent directory:", err);
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const fullPath = join(this.subagentsDir, file);
      if (this.subagentTails.has(fullPath)) continue;

      const subagentId = basename(file, ".jsonl");
      const agentType = await this.readAgentType(subagentId);
      this.subagentTails.set(fullPath, {
        filePath: fullPath,
        byteOffset: 0,
        lineBuffer: "",
        lastTimestamp: 0,
        lineage: {
          subagent_id: subagentId,
          parent_session_id: this.parentSessionId,
          agent_type: agentType,
        },
      });
    }
  }

  /**
   * For sub-agent tails whose `agent_type` is still undefined (meta.json had
   * not been written yet when the jsonl was first discovered), retry reading
   * the sidecar on each poll. Claude Code writes .jsonl and .meta.json
   * separately, so the meta can appear one or more ticks after the jsonl.
   * Also back-fills parent_session_id once the parent init has emitted.
   */
  private async refreshPendingAgentTypes(): Promise<void> {
    for (const state of this.subagentTails.values()) {
      if (!state.lineage) continue;
      let { agent_type, parent_session_id } = state.lineage;
      if (agent_type === undefined) {
        agent_type = await this.readAgentType(state.lineage.subagent_id);
      }
      if (parent_session_id === null && this.parentSessionId !== null) {
        parent_session_id = this.parentSessionId;
      }
      state.lineage = {
        subagent_id: state.lineage.subagent_id,
        parent_session_id,
        agent_type,
      };
    }
  }

  /**
   * Read agentType from the `<subagentId>.meta.json` sidecar. Returns
   * undefined only for ENOENT (file not written yet). Malformed JSON or
   * permission errors are logged at WARN and return undefined — the watcher
   * must not crash on bad sidecar files, but the failure is visible in logs.
   */
  private async readAgentType(subagentId: string): Promise<string | undefined> {
    if (!this.subagentsDir) return undefined;
    const metaPath = join(this.subagentsDir, `${subagentId}.meta.json`);
    try {
      const text = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(text) as { agentType?: unknown };
      return typeof meta.agentType === "string" ? meta.agentType : undefined;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      log.warn(
        `Failed to read sub-agent meta for ${subagentId}: ${String(err)}`,
      );
      return undefined;
    }
  }

  /** Process raw text from a file tail, handling partial lines across poll ticks. */
  private processText(text: string, state: TailState): void {
    state.lineBuffer += text;

    let newlineIdx: number;
    while ((newlineIdx = state.lineBuffer.indexOf("\n")) !== -1) {
      const line = state.lineBuffer.substring(0, newlineIdx).trim();
      state.lineBuffer = state.lineBuffer.substring(newlineIdx + 1);

      if (!line) continue;

      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        this.handleRawEntry(raw, state);
      } catch {
        log.warn(`Skipping malformed JSONL line: ${line.substring(0, 100)}`);
      }
    }
  }

  /**
   * Convert a raw JSONL entry and emit to consumers.
   *
   * Init synthesis (parent stream only): interactive JSONL files lack a
   * system/init event, so we synthesize one from the first assistant message's
   * sessionId and model. Sub-agent streams never synthesize — their entries
   * flow under the parent dispatch's existing session.
   *
   * IMPORTANT: synthesized init events carry `tools: []` — interactive mode
   * does not expose the MCP-registered tool list. Any consumer that wants to
   * check whether MCP tools loaded correctly must only trust the tools field
   * when a REAL init was emitted (piped/docker mode, `-p` flag). In host mode
   * you cannot infer MCP health from this watcher's events — the pre-launch
   * probe in `mcp-server-probe.ts` is the tool-registration check that works
   * across both runtimes.
   */
  private handleRawEntry(raw: Record<string, unknown>, state: TailState): void {
    const isSubagent = state.lineage !== undefined;

    if (!isSubagent && !this.initSynthesized && raw.type === "assistant") {
      const message = raw.message as Record<string, unknown> | undefined;
      const model = message?.model as string | undefined;
      const sessionId = raw.sessionId as string | undefined;

      if (sessionId || model) {
        this.parentSessionId = sessionId ?? this.parentSessionId;
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
        this.emitEntry(initEntry, state);
        this.initSynthesized = true;
      }
    }

    const result = convertJsonlEntry(raw, state.lastTimestamp);
    if (!result) return;

    if (
      !isSubagent &&
      result.entry.type === "system" &&
      result.entry.subtype === "init"
    ) {
      this.initSynthesized = true;
      const sid = result.entry.data.session_id as string | undefined;
      if (sid) this.parentSessionId = sid;
    }

    state.lastTimestamp = result.timestamp;
    this.emitEntry(result.entry, state);
  }

  /**
   * Emit an entry to all consumers and the internal accumulator. For sub-agent
   * streams, `state.lineage` decorates `entry.data` so the emitted EventPayload
   * (via mapEntryToEvents) inherits subagent_id/parent_session_id/agent_type.
   */
  private emitEntry(entry: AgentLogEntry, state: TailState): void {
    if (state.lineage) {
      entry.data = {
        ...entry.data,
        subagent_id: state.lineage.subagent_id,
        parent_session_id: state.lineage.parent_session_id,
        agent_type: state.lineage.agent_type,
      };
    }

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
