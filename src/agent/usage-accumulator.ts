/**
 * Per-dispatch usage accumulator + last-assistant-text tracker.
 *
 * Wires the SessionLogWatcher subscriber that:
 *   1. Resets the inactivity timer on every entry
 *   2. Captures the most recent assistant text block as the running summary
 *   3. Accumulates per-turn `message.usage` totals onto `job.usage`
 *
 * Usage dedup is the load-bearing detail: Claude Code writes one JSONL
 * entry per content block in a multi-block assistant turn (text +
 * tool_use, thinking + text + tool_use, etc.) but stamps the IDENTICAL
 * response-level `message.usage` on every entry. Without dedup the
 * accumulator counts that single API response 2-5× — verified in
 * production (gpt-manager job 830cbd99: real usage in=6/out=110/
 * cache_creation=100,362, accumulator reported double).
 *
 * We dedup by `message.id` inside this closure. Entries without an id
 * (malformed; never seen in real Claude Code output) still accumulate
 * so a single bad line never silently zeroes billable usage — we log
 * the anomaly once per dispatch.
 *
 * Returns a `getLastAssistantText()` accessor so the docker/host forks
 * (which run AFTER the subscriber is wired) can read the running
 * summary without sharing a `let` binding with the launcher closure.
 */

import { createLogger } from "../logger.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { AgentJob, AgentUsage } from "./agent-types.js";

const log = createLogger("usage-accumulator");

export interface UsageAccumulatorDeps {
  job: AgentJob;
  watcher: SessionLogWatcher;
  /**
   * Called on every JSONL entry — wired to `inactivityTimer.reset()` so a
   * heartbeat-shaped agent (long tool-use streams, no assistant text) still
   * counts as alive.
   */
  onActivity: () => void;
}

export interface UsageAccumulator {
  /** Most recent text block from any assistant entry seen so far. */
  getLastAssistantText: () => string;
}

export function attachUsageAccumulator(
  deps: UsageAccumulatorDeps,
): UsageAccumulator {
  const { job, watcher, onActivity } = deps;
  let lastAssistantText = "";
  const seenUsageMessageIds = new Set<string>();
  let warnedMissingMessageId = false;

  watcher.onEntry((entry) => {
    onActivity();

    if (entry.type !== "assistant") return;

    const content = (entry.data.content ?? []) as Record<string, unknown>[];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        lastAssistantText = block.text as string;
      }
    }

    const usage = entry.data.usage as Partial<AgentUsage> | undefined;
    if (!usage) return;

    const messageId = entry.data.messageId as string | undefined;
    if (messageId) {
      if (seenUsageMessageIds.has(messageId)) return;
      seenUsageMessageIds.add(messageId);
    } else if (!warnedMissingMessageId) {
      warnedMissingMessageId = true;
      log.warn(
        `[Job ${job.id}] Assistant entry has usage but no message.id — accumulating defensively. If this is a new Claude Code release, the dedup contract may need updating.`,
      );
    }

    job.usage.input_tokens += usage.input_tokens ?? 0;
    job.usage.output_tokens += usage.output_tokens ?? 0;
    job.usage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    job.usage.cache_creation_input_tokens +=
      usage.cache_creation_input_tokens ?? 0;
  });

  return {
    getLastAssistantText: () => lastAssistantText,
  };
}
