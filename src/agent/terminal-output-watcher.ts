/**
 * TerminalOutputWatcher — Tails the terminal output log file captured by `script -q -f`.
 *
 * The dispatch script runs claude inside `script -q -f <logPath>`, which writes raw
 * terminal output (including ANSI escape sequences) to a log file. This watcher polls
 * that file, strips ANSI codes, and detects the Claude thinking indicator (✻) character.
 *
 * Used by StallDetector to distinguish "actively thinking" (✻ visible) from
 * "frozen" (no activity for stallThresholdMs), since both look identical in the
 * JSONL file — JSONL only records completed thoughts, not in-progress ones.
 */

import { open, stat } from "node:fs/promises";
import { createLogger } from "../logger.js";

const log = createLogger("terminal-output-watcher");

/** ANSI escape sequence pattern — strips color codes, cursor movements, etc. */
const ANSI_ESCAPE_RE =
  /\x1b(?:\[[0-9;]*[A-Za-z]|[@-_][0-9;]*[A-Za-z~]?|[0-9;]*[A-Za-z])/g;

/** Claude's thinking indicator character */
export const THINKING_CHAR = "✻";

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class TerminalOutputWatcher {
  public lastThinkingAt: number | null = null;
  public lastTextAt: number | null = null;
  public lastActivityAt: number | null = null;

  private readonly logPath: string;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private byteOffset = 0;
  private running = false;

  constructor(logPath: string, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.logPath = logPath;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Start polling the terminal log file. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => log.error("Poll error:", err));
    }, this.pollIntervalMs);
    this.poll().catch((err) => log.error("Initial poll error:", err));
  }

  /** Stop polling. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Process a raw text chunk, updating activity timestamps. Exposed for testing. */
  processChunk(raw: string): void {
    const cleaned = raw.replace(ANSI_ESCAPE_RE, "");
    const now = Date.now();

    if (cleaned.includes(THINKING_CHAR)) {
      this.lastThinkingAt = now;
      this.lastActivityAt = now;
    } else if (cleaned.trim().length > 0) {
      this.lastTextAt = now;
      this.lastActivityAt = now;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const fileStats = await stat(this.logPath);
      if (fileStats.size <= this.byteOffset) return;

      const fd = await open(this.logPath, "r");
      try {
        const bytesToRead = fileStats.size - this.byteOffset;
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fd.read(buffer, 0, bytesToRead, this.byteOffset);
        if (bytesRead === 0) return;
        this.byteOffset += bytesRead;
        this.processChunk(buffer.toString("utf-8", 0, bytesRead));
      } finally {
        await fd.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("TerminalOutputWatcher poll error:", err);
      }
    }
  }
}
