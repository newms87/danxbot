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

/**
 * Tool names Claude Code emits for sub-agent invocations. `Agent` is the
 * current emit; `Task` is the legacy name still present in older captures.
 * `.claude/rules/agent-dispatch.md` requires every sub-agent reader to
 * accept BOTH — counting only one of them silently undercounts every
 * dispatch row's `subagent_count`.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

const UUID_REGEX =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function extractSessionUuidFromPath(filepath: string): string | null {
  const match = filepath.match(UUID_REGEX);
  return match ? match[1] : null;
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
  /**
   * Local issue id (`<PREFIX>-N`) when the dispatch is bound to a per-card
   * YAML. The poller threads this through from `dispatchStamp.issueId`;
   * non-card dispatches (Slack, ideator, board-chat, external launch)
   * leave it unset and the column is stamped NULL.
   */
  issueId?: string | null;
  /**
   * Resolved persona name (`AGENT_NAME_SHAPE`) when the multi-worker pick
   * algorithm chose this agent for the dispatch (DX-200). Stamped onto the
   * `dispatches.agent_name` column so the next tick's `busyAgents()` query
   * can see the slot is taken without walking issue YAMLs. NULL for every
   * non-agent dispatch (Slack, ideator, external launch, pre-Phase-5
   * issue-worker rows).
   */
  agentName?: string | null;
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
    issueId: args.issueId ?? null,
    status: "running",
    startedAt,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: args.runtimeMode,
    // Stamped to NULL at insert time. The agent's PID is not yet
    // resolved at this point (the runtime fork hasn't run); `spawnAgent`
    // calls `pairedWriteHostPid` AFTER the runtime fork resolves the PID
    // so the DB row's `host_pid` and the YAML's `dispatch.pid` carry the
    // same value. See DX-140 — the prior "stamp worker PID at insert"
    // semantics gave divergent reconcile/reattach verdicts when the
    // worker died but the agent script (parented to PID 1) survived.
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: args.danxbotCommit,
    agentName: args.agentName ?? null,
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
          if (block.name && SUBAGENT_TOOL_NAMES.has(block.name)) {
            subagentCount++;
          }
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
          // The `host_pid` value is preserved as historical context;
          // `pid_terminated_at` records WHEN that PID stopped owning the
          // dispatch. Single source of truth for "what process used to
          // run this row" + "when did it die." See DX-140.
          pidTerminatedAt: completedAt,
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
        // `repoName` is included so per-repo subscribers (e.g. the
        // Agents tab roster — DX-164 Phase 6) can filter without a
        // DB lookup; the value is already in `args.repoName` from the
        // initial insert.
        eventBus.publish({
          topic: "dispatch:updated",
          data: {
            id: args.jobId,
            repoName: args.repoName,
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
