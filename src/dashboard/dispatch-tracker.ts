import type { SessionLogWatcher } from "../agent/session-log-watcher.js";
import { createLogger } from "../logger.js";
import {
  isStrikeEligible,
  recordStrike,
  resetStrikes,
} from "../agent/strikes.js";
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
import { writeFlag } from "../critical-failure.js";

/**
 * DX-365 — `error` slice cap for `agent.strikes.history[].raw_error`.
 * Keeps the strike entry small so the on-disk JSONB stays bounded
 * while still carrying enough signal for the Phase 4 evaluator to
 * triage. ~200 chars per `agent-types.ts#AgentStrikeEntry`.
 */
const STRIKE_RAW_ERROR_MAX = 200;

/**
 * DX-365 — shared strike-recording wrapper. Used by both the live-
 * spawn `DispatchTracker.finalize` here AND the reattach tracker in
 * `worker/reattach.ts#buildReattachTracker.finalize` so the strike
 * decision tree (eligibility + caller guards + error swallow) lives
 * in ONE place.
 *
 * Skip conditions (every one returns `null` without invoking
 * `recordStrike`):
 *   - `repoLocalPath` unset (test fixture / ad-hoc spawn).
 *   - `agentName === null` (Slack / ideator / external launch).
 *   - `issueId === null` (defensive — agent-bound dispatches always
 *     carry one, but a future opt-out path would surface here).
 *   - Status not in `STRIKE_ELIGIBLE` (`completed` / `cancelled`).
 *
 * Errors thrown by `recordStrike` are caught + logged. The dispatch
 * row finalize already committed by the time this helper runs, so a
 * strike write failure does NOT roll back the terminal status.
 */
export interface ApplyStrikeArgs {
  status: DispatchStatus;
  repoLocalPath: string | null;
  repoName: string;
  agentName: string | null;
  dispatchId: string;
  issueId: string | null;
  rawError: string | null;
  timestampIso: string;
}

export async function applyStrike(args: ApplyStrikeArgs): Promise<void> {
  if (!args.repoLocalPath) return;
  if (!args.agentName) return;
  if (!args.issueId) return;
  // DX-604 — successful completions reset the durable strike counter
  // (count + history). Branches BEFORE `isStrikeEligible` because
  // `completed` is not strike-eligible (it does not increment) but it
  // IS the only status that clears. `cancelled` (operator interrupt)
  // stays a true no-op — neither strike nor reset.
  if (args.status === "completed") {
    try {
      await resetStrikes({
        localPath: args.repoLocalPath,
        agentName: args.agentName,
        timestamp: args.timestampIso,
      });
    } catch (err) {
      log.error(
        `[Dispatch ${args.dispatchId}] strike reset failed for agent="${args.agentName}"`,
        err,
      );
    }
    return;
  }
  if (!isStrikeEligible(args.status)) return;
  try {
    await recordStrike(
      {
        dispatchId: args.dispatchId,
        issueId: args.issueId,
        terminalStatus: args.status,
        rawError: (args.rawError ?? "").slice(0, STRIKE_RAW_ERROR_MAX),
        timestamp: args.timestampIso,
      },
      {
        localPath: args.repoLocalPath,
        repoName: args.repoName,
        agentName: args.agentName,
      },
    );
  } catch (err) {
    log.error(
      `[Dispatch ${args.dispatchId}] strike record failed for agent="${args.agentName}"`,
      err,
    );
  }
}

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
  /**
   * Persist the current recover count to the dispatches row. Called by
   * the API-error recover handler in `attach-monitoring-stack.ts` BEFORE
   * `job.stop` runs, so the row carries the post-increment count even
   * when the worker dies between this update and the row's finalize
   * (DX-260 / Phase 2 of DX-246). Independent from `finalize` so the
   * cap-exhausted path AND the recover-ok path both write the same
   * column the same way.
   */
  recordRecoverCount(count: number): Promise<void>;
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
  /**
   * Absolute path to the per-dispatch MCP settings JSON written by
   * `dispatch()` (`src/dispatch/core.ts#writeMcpSettingsFile`) at spawn
   * time. Persisted on the row so Phase 2c (DX-209) can rewrite the
   * embedded `DANXBOT_STOP_URL` if the worker restarts on a different
   * port. NULL for callsites that bypass the standard `dispatch()` path
   * — none today, but the column tolerates legacy / no-MCP rows.
   */
  mcpSettingsPath?: string | null;
  /**
   * DX-260 (Phase 2 of DX-246) — initial recover count for THIS
   * dispatch row. Defaults to 0 on a fresh launch; the recover-spawn
   * path through `/api/resume` threads the parent's post-increment
   * count here so the chain's count is monotonic across rows. The
   * `MAX_RECOVERS = 3` cap reads from the row + the in-memory
   * `AgentJob.recoverCount` seeded from this value.
   */
  recoverCount?: number;
  /**
   * DX-260 — parent dispatch ID when this row is a recover-child.
   * Defaults to null on a fresh launch. The dashboard's "show recover
   * chain" view walks the column to render the lineage; the
   * `parent_job_id` column (set on resume via the same row) is the
   * complementary view of the same lineage from the resume-chain
   * angle.
   */
  parentRecoverId?: string | null;
  /**
   * DX-365 — repo `localPath` (`<repo>/.danxbot` parent). Required for
   * the strike accumulator's `mutateAgents` call; threaded through
   * `attachMonitoringStack` from `SpawnAgentOptions.repoLocalPath`.
   * When unset, strike recording is SKIPPED for this dispatch — fresh
   * tests + ad-hoc spawns that never set up a settings file would
   * otherwise throw on `recordStrike` even when no agent is bound.
   */
  repoLocalPath?: string | null;
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
    mcpSettingsPath: args.mcpSettingsPath ?? null,
    // DX-259 Phase 1: foundation columns. Defaults to 0 / null so every
    // fresh launch starts at the chain's origin. DX-260 Phase 2 threads
    // these through `StartDispatchTrackingArgs` so the new row written
    // by /api/resume when the API-error recover handler fires inherits
    // the parent's count and references the parent's id via
    // `parent_recover_id`.
    recoverCount: args.recoverCount ?? 0,
    parentRecoverId: args.parentRecoverId ?? null,
  };

  try {
    await insertDispatch(row);
    // Notify SSE clients immediately so they see the new dispatch without
    // waiting for the next DB change-detector poll cycle.
    eventBus.publish({ topic: "dispatch:created", data: row });
  } catch (err) {
    // FAIL LOUDLY. A missing dispatch row is not "transient DB
    // unavailable" — the orphan-reaper joins live scope units with the
    // dispatches table and SIGTERMs every PID whose row is absent, so a
    // swallowed insert error guarantees the spawned claude is killed
    // before its first turn AND the picker re-picks the same card every
    // tick (infinite spawn/reap loop, observed in prod 2026-05-16 with
    // a malformed card id that violated the VARCHAR(32) column width).
    // Write the per-repo CRITICAL_FAILURE flag so the poller halts, then
    // re-throw so the spawn aborts at the source.
    log.error(`[Job ${args.jobId}] Failed to insert dispatch row`, err);
    if (args.repoLocalPath) {
      try {
        writeFlag(args.repoLocalPath, {
          source: "agent",
          dispatchId: args.jobId,
          reason: "Failed to insert dispatch row — agent spawn aborted to avoid orphan-reaper/picker infinite loop",
          cardId: args.issueId ?? undefined,
          detail: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
        });
      } catch (flagErr) {
        log.error(`[Job ${args.jobId}] Failed to write CRITICAL_FAILURE flag`, flagErr);
      }
    }
    throw err;
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
        // DX-365 — strike accumulator. Runs immediately after the row
        // terminal write so the count reflects the same DispatchStatus
        // that just landed in the DB. Skipped for non-agent dispatches
        // (`agent_name === null`) and non-strike statuses (`completed`
        // / `cancelled`). Per-call try/catch keeps the SSE publish
        // (operator visibility) on the happy path even if the strike
        // write fails — a missed strike is recoverable; a missed SSE
        // event silently freezes the dashboard.
        await applyStrike({
          status,
          repoLocalPath: args.repoLocalPath ?? null,
          repoName: args.repoName,
          agentName: args.agentName ?? null,
          dispatchId: args.jobId,
          issueId: args.issueId ?? null,
          rawError: fields.error ?? null,
          timestampIso: new Date(completedAt).toISOString(),
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
    async recordRecoverCount(count) {
      try {
        await updateDispatch(args.jobId, { recoverCount: count });
      } catch (err) {
        log.error(`[Job ${args.jobId}] Failed to record recover count`, err);
      }
    },
  };
}
