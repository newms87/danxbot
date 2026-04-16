/**
 * StallDetector — Detects agents that are stuck after receiving tool results.
 *
 * Uses the ✻ thinking indicator as a positive heartbeat signal. Claude Code emits ✻
 * continuously while actively thinking — its absence means the agent is frozen.
 * Detection happens within seconds, not minutes.
 *
 * Three observable states (from getState()):
 *  - thinking: Agent is actively working. ✻ visible, text being emitted, or JSONL entries appearing.
 *  - waiting: Agent is waiting for something external. Pending tool_use (Read, Bash, Agent, etc.)
 *    or no tool_result has happened yet (first turn). NOT stalled regardless of elapsed time.
 *  - stalled: All tool_results received, no ✻, no terminal text, no new JSONL entries for
 *    stallThresholdMs. Agent is frozen.
 *
 * Confirmation window: When getState() first returns "stalled", the detector enters a
 * confirmation phase (default 10s). Only if the stall persists for the full confirmation
 * window does onStall fire. If activity resumes during confirmation, it cancels silently.
 * This prevents false positives from brief pauses, slow API responses, or network hiccups.
 *
 * Stall detection only activates after the first tool_result entry appears in the JSONL.
 * Before that, the agent is in its initial response — not stalled.
 *
 * On detecting a confirmed stall, `onStall` is called. Limited to `maxNudges` attempts
 * before the detector gives up (to avoid infinite nudge loops).
 *
 * Key helpers (exported for testing):
 *  - isToolCallPending(entries): true if any tool_use lacks a matching tool_result
 *  - hasReceivedToolResult(entries): true if at least one tool_result exists
 *  - getLastToolResultTimestamp(entries): timestamp of the most recent tool_result
 */

import { createLogger } from "../logger.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { TerminalOutputWatcher } from "./terminal-output-watcher.js";
import type { AgentLogEntry } from "../types.js";

const log = createLogger("stall-detector");

export type StallState = "thinking" | "waiting" | "stalled";

export const DEFAULT_STALL_THRESHOLD_MS = 5_000; // 5 seconds (with terminal watcher)
const DEFAULT_FALLBACK_STALL_THRESHOLD_MS = 7 * 60 * 1000; // 7 minutes (Docker, no terminal)
export const DEFAULT_CHECK_INTERVAL_MS = 2_000; // 2 seconds
export const DEFAULT_MAX_NUDGES = 3;
export const DEFAULT_CONFIRMATION_WINDOW_MS = 10_000; // 10 seconds

export interface StallDetectorOptions {
  /** The SessionLogWatcher whose entries will be inspected for tool call state. */
  watcher: SessionLogWatcher;
  /** Optional terminal output watcher for thinking indicator detection. */
  terminalWatcher?: TerminalOutputWatcher;
  /**
   * Called when a stall is detected. May be async — concurrent invocations are
   * suppressed by an internal `_handlerRunning` flag until the previous call resolves.
   */
  onStall: () => void | Promise<void>;
  /**
   * How long without terminal activity before declaring a stall.
   * When terminalWatcher is present: default 5 seconds.
   * When absent (Docker fallback): default 7 minutes.
   */
  stallThresholdMs?: number;
  /** How often to check for stalls. Default: 2 seconds. */
  checkIntervalMs?: number;
  /** Maximum number of nudges before giving up. Default: 3. */
  maxNudges?: number;
  /**
   * How long the stall must persist after initial detection before firing onStall.
   * Prevents false positives from brief pauses, slow API responses, or network hiccups.
   * Default: 10 seconds.
   */
  confirmationWindowMs?: number;
}

/** Extract content blocks from an AgentLogEntry, safely handling missing data. */
function getContentBlocks(entry: AgentLogEntry): Array<Record<string, unknown>> {
  return (entry.data.content ?? []) as Array<Record<string, unknown>>;
}

/**
 * Returns true if there is at least one outstanding tool_use in the JSONL entries
 * that has not received a matching tool_result.
 */
export function isToolCallPending(entries: AgentLogEntry[]): boolean {
  const pendingToolUseIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "assistant") {
      for (const block of getContentBlocks(entry)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          pendingToolUseIds.add(block.id);
        }
      }
    }
    if (entry.type === "user") {
      for (const block of getContentBlocks(entry)) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          pendingToolUseIds.delete(block.tool_use_id);
        }
      }
    }
  }

  return pendingToolUseIds.size > 0;
}

/**
 * Returns true if any tool_result entry exists in the JSONL entries.
 * Stall detection only activates after the first tool_result.
 */
export function hasReceivedToolResult(entries: AgentLogEntry[]): boolean {
  return entries.some(
    (e) => e.type === "user" && getContentBlocks(e).some((b) => b.type === "tool_result"),
  );
}

/**
 * Returns the timestamp (ms) of the most recent tool_result entry, or null if none.
 */
export function getLastToolResultTimestamp(entries: AgentLogEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "user" && getContentBlocks(entry).some((b) => b.type === "tool_result")) {
      return entry.timestamp;
    }
  }
  return null;
}

export class StallDetector {
  private readonly watcher: SessionLogWatcher;
  private readonly terminalWatcher: TerminalOutputWatcher | undefined;
  private readonly onStall: () => void | Promise<void>;
  private readonly stallThresholdMs: number;
  private readonly checkIntervalMs: number;
  private readonly maxNudges: number;
  private readonly confirmationWindowMs: number;

  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private nudgeCount = 0;
  private running = false;
  /** Prevents concurrent stall handler invocations when onStall is async. */
  private _handlerRunning = false;
  /** Timestamp when the stall was first detected (confirmation window start). Null = not confirming. */
  private _confirmingStartedAt: number | null = null;

  constructor(options: StallDetectorOptions) {
    this.watcher = options.watcher;
    this.terminalWatcher = options.terminalWatcher;
    this.onStall = options.onStall;
    this.stallThresholdMs = options.stallThresholdMs ??
      (options.terminalWatcher ? DEFAULT_STALL_THRESHOLD_MS : DEFAULT_FALLBACK_STALL_THRESHOLD_MS);
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.maxNudges = options.maxNudges ?? DEFAULT_MAX_NUDGES;
    this.confirmationWindowMs = options.confirmationWindowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
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
   * - waiting: no tool_result yet (first turn), or tool_use pending (waiting for tool)
   * - thinking: terminal activity within stallThresholdMs, or new JSONL entries appearing
   * - stalled: no terminal activity for stallThresholdMs after all tool_results received
   */
  getState(): StallState {
    const entries = this.watcher.getEntries();

    // No entries yet — agent just started, waiting for first output
    if (entries.length === 0) return "waiting";

    // No tool_result has happened yet — first turn, agent is still in initial response
    if (!hasReceivedToolResult(entries)) return "waiting";

    // A tool call is pending (tool_use without matching tool_result) — waiting for tool
    if (isToolCallPending(entries)) return "waiting";

    // All tool_results received — check activity signals
    return this.terminalWatcher
      ? this.getTerminalStallState(this.terminalWatcher)
      : this.getFallbackStallState(entries);
  }

  /** Check stall state using terminal output timestamps (host mode). */
  private getTerminalStallState(tw: TerminalOutputWatcher): StallState {
    // No terminal activity yet — agent is starting up, not stalled
    if (tw.lastActivityAt === null) return "thinking";

    // lastActivityAt is always >= lastThinkingAt (processChunk updates both),
    // so checking lastActivityAt alone covers the ✻ heartbeat case too.
    if (Date.now() - tw.lastActivityAt < this.stallThresholdMs) return "thinking";

    return "stalled";
  }

  /** Check stall state using JSONL timestamps only (Docker fallback). */
  private getFallbackStallState(entries: AgentLogEntry[]): StallState {
    const lastResultTs = getLastToolResultTimestamp(entries);
    if (lastResultTs === null) return "waiting";
    if (Date.now() - lastResultTs >= this.stallThresholdMs) return "stalled";
    return "thinking";
  }

  private check(): void {
    if (!this.running || this._handlerRunning) return;

    const state = this.getState();

    if (state !== "stalled") {
      // Activity resumed during confirmation — cancel silently
      if (this._confirmingStartedAt !== null) {
        log.info("Activity resumed during confirmation window — cancelling stall");
        this._confirmingStartedAt = null;
      }
      return;
    }

    // State is stalled — enter or continue confirmation window
    if (this._confirmingStartedAt === null) {
      this._confirmingStartedAt = Date.now();
      log.info("Stall detected — entering confirmation window");
      return;
    }

    // Check if confirmation window has elapsed
    if (Date.now() - this._confirmingStartedAt < this.confirmationWindowMs) {
      return;
    }

    // Confirmed stall — _confirmingStartedAt is intentionally NOT reset after the
    // first nudge. This means subsequent nudges fire immediately on each check interval
    // without re-entering the confirmation window. Only activity resumption (state !== stalled)
    // resets the confirmation state.
    this.fireNudge();
  }

  /** Execute a nudge: check limits, increment counter, invoke onStall callback. */
  private fireNudge(): void {
    if (this.nudgeCount >= this.maxNudges) {
      log.warn(`Stall confirmed but max nudges (${this.maxNudges}) reached — stopping detector`);
      this.stop();
      return;
    }

    this.nudgeCount++;
    log.warn(`Stall confirmed (nudge ${this.nudgeCount}/${this.maxNudges}) — calling onStall`);

    this._handlerRunning = true;
    try {
      const result = this.onStall();
      if (result instanceof Promise) {
        result
          .catch((err) => log.error("onStall async callback threw:", err))
          .finally(() => { this._handlerRunning = false; });
      } else {
        this._handlerRunning = false;
      }
    } catch (err) {
      this._handlerRunning = false;
      log.error("onStall callback threw:", err);
    }
  }
}
