/**
 * EventQueue — per-dispatch on-disk FIFO queue of event batches.
 *
 * Backs the Laravel forwarder's durable delivery: every batch is persisted to
 * `<dir>/<dispatchId>.jsonl` before a send attempt, so transient gpt-manager
 * outages and danxbot worker restarts do not drop usage events. One JSONL line
 * per batch; each line is `JSON.stringify(events: EventPayload[])`.
 *
 * Pure data structure — retry logic lives in the forwarder. Worker-boot drain
 * orchestration lives in the launcher.
 */

import { mkdirSync } from "node:fs";
import {
  appendFile,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../logger.js";
import type { EventPayload } from "./laravel-forwarder.js";

const log = createLogger("event-queue");

export class EventQueue {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /** Append a batch to the queue. No-op when the batch is empty. */
  async enqueue(events: EventPayload[]): Promise<void> {
    if (events.length === 0) return;
    await appendFile(this.filePath, JSON.stringify(events) + "\n");
  }

  /**
   * Read all pending batches WITHOUT removing them. Returns `[]` when the
   * queue file is absent. Malformed lines are logged at WARN and skipped so a
   * corrupt write cannot permanently block drainage.
   */
  async peekAll(): Promise<EventPayload[][]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const batches: EventPayload[][] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        batches.push(JSON.parse(trimmed) as EventPayload[]);
      } catch {
        log.warn(
          `Skipping malformed queue line in ${this.filePath}: ${trimmed.slice(0, 80)}`,
        );
      }
    }
    return batches;
  }

  /**
   * Rewrite the queue with exactly the given batches. Called after a partial
   * drain when some batches were delivered but others must be retried. Empty
   * input clears the queue (file is removed).
   */
  async retain(batches: EventPayload[][]): Promise<void> {
    if (batches.length === 0) {
      await this.clear();
      return;
    }
    const text = batches.map((b) => JSON.stringify(b)).join("\n") + "\n";
    await writeFile(this.filePath, text);
  }

  /** Remove the queue file. Idempotent. */
  async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** True when the queue has at least one byte on disk. */
  async hasPending(): Promise<boolean> {
    try {
      const stats = await stat(this.filePath);
      return stats.size > 0;
    } catch {
      return false;
    }
  }
}
