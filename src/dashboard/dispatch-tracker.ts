import type { SessionLogWatcher } from "../agent/session-log-watcher.js";
import { createLogger } from "../logger.js";
import {
  insertDispatch,
  updateDispatch,
} from "./dispatches-db.js";
import {
  type Dispatch,
  type DispatchStatus,
  type DispatchTriggerMetadata,
  type RuntimeMode,
} from "./dispatches.js";
import { eventBus } from "./event-bus.js";

const log = createLogger("dispatch-tracker");

const UUID_REGEX =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function extractSessionUuidFromPath(filepath: string): string | null {
  const match = filepath.match(UUID_REGEX);
  return match ? match[1] : null;
}

/**
 * Count `tool_use` blocks and `Task` sub-agent invocations across an
 * already-captured AgentLogEntry stream. Used by the Slack listener which
 * gets the full log from `runAgent`'s response rather than via watcher
 * streaming.
 */
export function countToolCallsFromLog(
  entries: Array<{
    type: string;
    data: { content?: unknown };
  }>,
): { toolCallCount: number; subagentCount: number } {
  let toolCallCount = 0;
  let subagentCount = 0;
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const content = (entry.data.content ?? []) as Array<{
      type?: string;
      name?: string;
    }>;
    for (const block of content) {
      if (block.type === "tool_use") {
        toolCallCount++;
        if (block.name === "Task") subagentCount++;
      }
    }
  }
  return { toolCallCount, subagentCount };
}

export interface FinalizeTokens {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DispatchTracker {
  /** Finalize the dispatch row with terminal status, summary, usage totals. */
  finalize(
    status: DispatchStatus,
    fields: {
      summary?: string | null;
      error?: string | null;
      tokens: FinalizeTokens;
      nudgeCount?: number;
    },
  ): Promise<void>;
  /** Update the nudge count mid-run (called by stall detector). */
  recordNudge(count: number): Promise<void>;
}

export interface StartDispatchTrackingArgs {
  jobId: string;
  repoName: string;
  trigger: DispatchTriggerMetadata;
  runtimeMode: RuntimeMode;
  danxbotCommit: string | null;
  watcher: SessionLogWatcher;
  startedAtMs?: number;
  /**
   * Parent dispatch ID when this row is the child of a `POST /api/resume`.
   * Persisted in `parent_job_id` so the resume chain is queryable.
   */
  parentJobId?: string | null;
}

/**
 * Create the dispatch row, wire watcher callbacks that resolve the session
 * JSONL path and count tool/subagent usage, and return a tracker whose
 * `finalize` method writes the terminal status + totals when the agent exits.
 */
export async function startDispatchTracking(
  args: StartDispatchTrackingArgs,
): Promise<DispatchTracker> {
  const startedAt = args.startedAtMs ?? Date.now();

  // Denormalize slack thread + channel into dedicated indexable columns
  // for Slack-triggered dispatches. JSON metadata stays the source of
  // truth for audit; the columns exist so Phase 2's thread-continuity
  // lookup (`findLatestDispatchBySlackThread`) hits an index. The
  // `args.trigger.trigger === "slack"` check is the discriminator that
  // TypeScript uses to narrow `args.trigger.metadata` to
  // `SlackTriggerMetadata` — no cast needed.
  const slackMeta =
    args.trigger.trigger === "slack" ? args.trigger.metadata : null;

  const row: Dispatch = {
    id: args.jobId,
    repoName: args.repoName,
    trigger: args.trigger.trigger,
    triggerMetadata: args.trigger.metadata,
    slackThreadTs: slackMeta?.threadTs ?? null,
    slackChannelId: slackMeta?.channelId ?? null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: args.parentJobId ?? null,
    status: "running",
    startedAt,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: args.runtimeMode,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: args.danxbotCommit,
  };

  try {
    await insertDispatch(row);
    // Notify SSE clients immediately so they see the new dispatch without
    // waiting for the next DB change-detector poll cycle.
    eventBus.publish({ topic: "dispatch:created", data: row });
  } catch (err) {
    // Dispatch insertion must not block the agent spawn — the agent still runs
    // even if the DB is temporarily unavailable. Log and continue; subsequent
    // updateDispatch calls will also fail noisily if the problem persists.
    log.error(`[Job ${args.jobId}] Failed to insert dispatch row`, err);
  }

  let sessionResolved = false;
  let toolCallCount = 0;
  let subagentCount = 0;

  args.watcher.onEntry(async (entry) => {
    if (!sessionResolved) {
      const filePath = args.watcher.getSessionFilePath();
      if (filePath) {
        sessionResolved = true;
        const sessionUuid = extractSessionUuidFromPath(filePath);
        try {
          await updateDispatch(args.jobId, {
            sessionUuid,
            jsonlPath: filePath,
          });
        } catch (err) {
          log.error(
            `[Job ${args.jobId}] Failed to record session path`,
            err,
          );
        }
      }
    }

    if (entry.type === "assistant") {
      const content = (entry.data.content ?? []) as Array<{
        type?: string;
        name?: string;
      }>;
      for (const block of content) {
        if (block.type === "tool_use") {
          toolCallCount++;
          if (block.name === "Task") subagentCount++;
        }
      }
    }
  });

  return {
    async finalize(status, fields) {
      const total =
        fields.tokens.tokensIn +
        fields.tokens.tokensOut +
        fields.tokens.cacheRead +
        fields.tokens.cacheWrite;

      try {
        const completedAt = Date.now();
        await updateDispatch(args.jobId, {
          status,
          summary: fields.summary ?? null,
          error: fields.error ?? null,
          completedAt,
          tokensIn: fields.tokens.tokensIn,
          tokensOut: fields.tokens.tokensOut,
          cacheRead: fields.tokens.cacheRead,
          cacheWrite: fields.tokens.cacheWrite,
          tokensTotal: total,
          toolCallCount,
          subagentCount,
          nudgeCount: fields.nudgeCount ?? 0,
        });
        // Notify SSE clients immediately so they see the terminal state
        // without waiting for the next DB change-detector poll cycle.
        eventBus.publish({
          topic: "dispatch:updated",
          data: {
            id: args.jobId,
            status,
            summary: fields.summary ?? null,
            error: fields.error ?? null,
            completedAt,
            tokensTotal: total,
          },
        });
      } catch (err) {
        log.error(`[Job ${args.jobId}] Failed to finalize dispatch`, err);
      }
    },
    async recordNudge(count) {
      try {
        await updateDispatch(args.jobId, { nudgeCount: count });
      } catch (err) {
        log.error(`[Job ${args.jobId}] Failed to record nudge`, err);
      }
    },
  };
}
