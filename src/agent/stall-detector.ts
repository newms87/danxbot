/**
 * StallDetector — Detects agents that are stuck after receiving tool results.
 *
 * An agent is "stalled" when:
 * 1. All outstanding tool calls have received results (no sub-agent is running), AND
 * 2. The agent hasn't shown the thinking indicator (✻) in the terminal recently, AND
 * 3. No terminal activity has been seen for stallThresholdMs (default: 7 minutes).
 *
 * Three states:
 *  - sub_agent_running: tool_use with no matching tool_result yet. Claude is waiting
 *    for an external tool — this is NOT a stall regardless of elapsed time.
 *  - actively_thinking: tool_results received; terminal shows ✻ or recent activity.
 *  - stalled: tool_results received; no terminal activity for stallThresholdMs.
 *
 * On detecting a stall, `onStall` is called. Limited to `maxNudges` attempts before
 * the detector gives up (to avoid infinite nudge loops).
 *
 * Key helpers (exported for testing):
 *  - isSubAgentRunning(entries): true if any tool_use lacks a matching tool_result
 *  - getLastToolResultTimestamp(entries): timestamp of the most recent tool_result
 */

import { createLogger } from "../logger.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { TerminalOutputWatcher } from "./terminal-output-watcher.js";
import type { AgentLogEntry } from "../types.js";

const log = createLogger("stall-detector");

export type StallState = "sub_agent_running" | "actively_thinking" | "stalled";

/** Threshold for how recently the thinking indicator must have appeared. */
const THINKING_ACTIVE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export const DEFAULT_STALL_THRESHOLD_MS = 7 * 60 * 1000; // 7 minutes
export const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds
export const DEFAULT_MAX_NUDGES = 3;

export interface StallDetectorOptions {
  /** The SessionLogWatcher whose entries will be inspected for tool call state. */
  watcher: SessionLogWatcher;
  /** Optional terminal output watcher for thinking indicator detection. */
  terminalWatcher?: TerminalOutputWatcher;
  /** Called when a stall is detected. Should nudge the agent to resume. */
  onStall: () => void;
  /** How long without terminal activity before declaring a stall. Default: 7 minutes. */
  stallThresholdMs?: number;
  /** How often to check for stalls. Default: 30 seconds. */
  checkIntervalMs?: number;
  /** Maximum number of nudges before giving up. Default: 3. */
  maxNudges?: number;
}

/**
 * Returns true if there is at least one outstanding tool_use in the JSONL entries
 * that has not received a matching tool_result.
 *
 * Scans all entries in order: assistant entries add tool_use IDs to a pending set,
 * user entries (tool_result blocks) remove them. Any remaining IDs are unresolved.
 */
export function isSubAgentRunning(entries: AgentLogEntry[]): boolean {
  const pendingToolUseIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "assistant") {
      const content = (entry.data.content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          pendingToolUseIds.add(block.id);
        }
      }
    }

    if (entry.type === "user") {
      const content = (entry.data.content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          pendingToolUseIds.delete(block.tool_use_id);
        }
      }
    }
  }

  return pendingToolUseIds.size > 0;
}

/**
 * Returns the timestamp (ms) of the most recent tool_result entry, or null if none.
 */
export function getLastToolResultTimestamp(entries: AgentLogEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "user") {
      const content = (entry.data.content ?? []) as Array<Record<string, unknown>>;
      if (content.some((b) => b.type === "tool_result")) {
        return entry.timestamp;
      }
    }
  }
  return null;
}

export class StallDetector {
  private readonly watcher: SessionLogWatcher;
  private readonly terminalWatcher: TerminalOutputWatcher | undefined;
  private readonly onStall: () => void;
  private readonly stallThresholdMs: number;
  private readonly checkIntervalMs: number;
  private readonly maxNudges: number;

  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private nudgeCount = 0;
  private running = false;

  constructor(options: StallDetectorOptions) {
    this.watcher = options.watcher;
    this.terminalWatcher = options.terminalWatcher;
    this.onStall = options.onStall;
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES;
  }

  /** Start periodic stall checks. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.checkTimer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  /** Stop stall checking. */
  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  /** Returns how many nudges have been sent so far. */
  getNudgeCount(): number {
    return this.nudgeCount;
  }

  /**
   * Compute the current stall state from JSONL entries + terminal output.
   *
   * - sub_agent_running: outstanding tool_use with no tool_result yet
   * - actively_thinking: thinking indicator seen recently OR recent terminal activity
   * - stalled: no terminal activity for stallThresholdMs
   */
  getState(): StallState {
    const entries = this.watcher.getEntries();

    // No entries yet — agent just started, not stalled
    if (entries.length === 0) return "actively_thinking";

    // If a tool is still pending (tool_use without tool_result), not stalled
    if (isSubAgentRunning(entries)) return "sub_agent_running";

    const now = Date.now();

    if (this.terminalWatcher) {
      const { lastThinkingAt, lastActivityAt } = this.terminalWatcher;

      // No terminal activity yet — agent is starting up, not stalled
      if (lastActivityAt === null) return "actively_thinking";

      // Thinking indicator seen recently → agent is actively working
      if (lastThinkingAt !== null && now - lastThinkingAt < THINKING_ACTIVE_WINDOW_MS) {
        return "actively_thinking";
      }

      // Activity within stall threshold → not stalled yet
      if (now - lastActivityAt < this.stallThresholdMs) {
        return "actively_thinking";
      }

      // Activity older than stall threshold → stalled
      return "stalled";
    }

    // Fallback when no terminal watcher: use last tool_result timestamp
    const lastResultTs = getLastToolResultTimestamp(entries);
    if (lastResultTs === null) return "actively_thinking";
    if (now - lastResultTs >= this.stallThresholdMs) return "stalled";

    return "actively_thinking";
  }

  private check(): void {
    if (!this.running) return;

    const state = this.getState();

    if (state !== "stalled") return;

    if (this.nudgeCount >= this.maxNudges) {
      log.warn(`Stall detected but max nudges (${this.maxNudges}) reached — stopping detector`);
      this.stop();
      return;
    }

    this.nudgeCount++;
    log.warn(`Stall detected (nudge ${this.nudgeCount}/${this.maxNudges}) — calling onStall`);
    try {
      this.onStall();
    } catch (err) {
      log.error("onStall callback threw:", err);
    }
  }
}
