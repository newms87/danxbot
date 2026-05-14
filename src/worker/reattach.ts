/**
 * DB-driven full-stack reattach (Phase 2c, DX-209).
 *
 * Replaces `reconcileOrphanedDispatches`. Instead of just sweeping
 * dead-PID rows to `failed`, this pass scans every non-terminal
 * dispatch row at worker boot and:
 *
 *   - **Dead PID** (or null / non-positive PID) — mark `failed` with the
 *     legacy `ORPHAN_SUMMARY` and stamp `pid_terminated_at`. Same
 *     semantics as the prior reconcile; downstream poller / dashboard
 *     readers see no behavioral change.
 *   - **Alive PID + `jsonl_path` set** — full reattach:
 *       1. Optionally rewrite the per-dispatch MCP settings file
 *          (`mcp_settings_path` column from Phase 2a / DX-207) when the
 *          worker restarts on a DIFFERENT port. Same-port restart skips.
 *       2. Build an `AgentHandle` shim that wraps the existing PID
 *          (`createReattachHandle`).
 *       3. Construct a partially-populated `AgentJob` with the row's
 *          historical usage seeded onto `job.usage` so post-restart
 *          accumulation extends pre-restart counts (no double-count
 *          because the watcher is started with `fromEof: true`).
 *       4. Build a synthetic `DispatchTracker` that reuses the existing
 *          row (skips `insertDispatch`) and finalizes via
 *          `updateDispatch` when the cleanup chain fires.
 *       5. Call `attachMonitoringStack` with the tracker + sessionDir +
 *          `fromEof: true`. The helper wires watcher / inactivity timer
 *          / cleanup / stop in the same order as a fresh spawn.
 *       6. Register the job into `activeJobs` via `registerActiveJob`
 *          so `/api/status`, `/api/cancel`, `/api/stop`, `/api/jobs`
 *          all observe parity with newly-spawned jobs.
 *   - **Alive PID + jsonl_path null** — mark failed with summary
 *     "session log gone after worker restart". The watcher cannot
 *     attach without a session file; without a watcher we cannot
 *     observe completion or finalize the row, so the row is unsalvage-
 *     able and we surface that explicitly.
 *
 * Errors per row are logged and swallowed — the boot pass continues to
 * the next row. The DB is a side-channel relative to the worker's
 * primary mission (serving live dispatches).
 *
 * Heartbeat (`statusUrl` PUTs to a Laravel API) is NOT reattached:
 * `apiToken` is not persisted on the row (only `statusUrl` lives in
 * `triggerMetadata` for `api` triggers). Reattached dispatches whose
 * caller cared about heartbeats see stale status until terminal — the
 * row's `summary` + `status` still converge correctly via the cleanup
 * chain. This is a known limitation of the schema delta in Phase 2a;
 * full heartbeat resume would require persisting `apiToken` (a secret)
 * to the DB, which is out of scope for DX-209.
 *
 * StallDetector is attached for host-runtime workers when the watcher
 * is wired. Without `terminalLogPath` (the original `script -q -f` log
 * is not retained on the row) the detector falls back to its 7-minute
 * watcher-only threshold — slower but functional.
 *
 * Boot wiring: `src/index.ts` calls this in place of the legacy
 * `reconcileOrphanedDispatches`. The poller's `runStartupReattach` is
 * still invoked downstream as a defense-in-depth pass that drives the
 * per-card `activeDispatches` claim-token map.
 */

import { config } from "../config.js";
import { createLogger } from "../logger.js";
import {
  findNonTerminalDispatches,
  updateDispatch,
} from "../dashboard/dispatches-db.js";
import {
  isPidAlive,
} from "../agent/host-pid.js";
import { isDispatchOrphaned } from "../dashboard/dispatch-liveness.js";
import { attachMonitoringStack } from "../agent/attach-monitoring-stack.js";
import { StallDetector, type StallSnapshot } from "../agent/stall-detector.js";
import type { AgentJob, SpawnAgentOptions } from "../agent/agent-types.js";
import type { AgentLogEntry } from "../types.js";
import {
  applyStrike,
  type DispatchTracker,
  type FinalizeTokens,
} from "../dashboard/dispatch-tracker.js";
import type { Dispatch, DispatchStatus } from "../dashboard/dispatches.js";
import type { SessionLogWatcher } from "../agent/session-log-watcher.js";
import { registerActiveJob } from "../dispatch/core.js";
import { createReattachHandle } from "./reattach-handle.js";
import { readFileSync } from "node:fs";
import { rewriteMcpSettingsIfPortChanged } from "./mcp-settings-rewrite.js";
import { attemptAutoResume } from "./reattach-resume.js";
import { eventBus } from "../dashboard/event-bus.js";
import { dirname } from "node:path";

const log = createLogger("worker-reattach");

const ORPHAN_SUMMARY =
  "Worker restarted while dispatch was running — agent process orphaned";
const SESSION_LOG_GONE_SUMMARY =
  "Worker restarted; session log gone after restart — cannot reattach";

/**
 * Names Claude Code emits when a sub-agent is invoked. Mirrored from
 * `dispatch-tracker.ts` so the reattach tracker counts sub-agents the
 * same way the fresh-spawn tracker does. Drift here would silently
 * undercount post-restart sub-agent invocations on reattached rows.
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

export interface ReattachResult {
  /** Total non-terminal rows scanned. */
  scanned: number;
  /** Row IDs whose PID was found dead/null and marked `failed`. */
  orphaned: string[];
  /** Row IDs whose PID was alive — superset of `reattached + failedReattach`. */
  alive: string[];
  /** Row IDs successfully reattached into activeJobs (subset of `alive`). */
  reattached: string[];
  /** Row IDs alive but unable to reattach (e.g. session log gone). */
  failedReattach: string[];
  /**
   * Parent row IDs whose dead-PID dispatch was auto-resumed via
   * `claude --resume`. A separate child dispatch row was spawned with
   * `parent_job_id` pointing back at the entry's id. The parent ends up
   * `cancelled` (see `reattach-resume.ts` for the status choice
   * rationale) rather than `failed` — distinct from `orphaned`.
   */
  autoResumed: string[];
}

export interface ReattachOptions {
  /** The current worker's listening port. Used to decide whether to rewrite mcp_settings. */
  currentWorkerPort: number;
  /** Inactivity timeout for the watcher in milliseconds. Defaults to the dispatch core's value. */
  timeoutMs?: number;
  /**
   * Full RepoContext. Required for the dead-PID auto-resume branch
   * (`attemptAutoResume`) — dispatch() needs the repo's localPath,
   * trello config, settings, etc. When omitted, the dead-PID branch
   * falls back to the legacy orphan-mark path (no auto-resume). Tests
   * that only care about alive-PID reattach can keep omitting this.
   */
  repo?: import("../types.js").RepoContext;
}

async function markOrphaned(rowId: string): Promise<void> {
  const terminatedAt = Date.now();
  await updateDispatch(rowId, {
    status: "failed",
    summary: ORPHAN_SUMMARY,
    completedAt: terminatedAt,
    pidTerminatedAt: terminatedAt,
  });
}

async function markSessionLogGone(rowId: string): Promise<void> {
  const terminatedAt = Date.now();
  await updateDispatch(rowId, {
    status: "failed",
    summary: SESSION_LOG_GONE_SUMMARY,
    completedAt: terminatedAt,
    pidTerminatedAt: terminatedAt,
  });
}

/**
 * Build the partial `AgentJob` used by the reattach pass. The fresh-
 * spawn skeleton normally lives in `runSpawnPreflight`; that helper
 * runs auth / projects-dir / MCP probes that don't apply to a
 * reattached job (the original spawn already passed them). Inlining
 * the minimum here keeps the fresh-spawn path untouched.
 */
function buildPartialJob(
  row: Dispatch,
  pid: number,
  pollIntervalMs?: number,
): AgentJob {
  const handle = createReattachHandle(pid, {
    pollIntervalMs: pollIntervalMs ?? 1_000,
  });

  // `stop` is stamped by attachMonitoringStack — but `AgentJob.stop` is
  // typed as required (no undefined). Provide a placeholder that throws
  // so a misuse before attachMonitoringStack runs is loud, not silent.
  const unstamped: AgentJob["stop"] = async () => {
    throw new Error(
      `Job ${row.id}: stop() called before attachMonitoringStack stamped it`,
    );
  };

  return {
    id: row.id,
    status: "running",
    summary: row.summary ?? "",
    startedAt: new Date(row.startedAt),
    handle,
    // Seed usage from the row so the post-restart accumulator extends
    // the pre-restart totals. The watcher is started with fromEof:true
    // → only NEW entries flow in, so this seeding is the only path that
    // preserves history into the eventual finalize.
    usage: {
      input_tokens: row.tokensIn,
      output_tokens: row.tokensOut,
      cache_read_input_tokens: row.cacheRead,
      cache_creation_input_tokens: row.cacheWrite,
    },
    // DX-260 (Phase 2 of DX-246) — seed from the row's existing count
    // so the API-error recover handler's cap check picks up where the
    // pre-restart run left off. New synthetic-error fires after
    // reattach increment correctly on top of the persisted counter
    // (re-running the chain from zero would silently double-allow
    // the recover budget).
    recoverCount: row.recoverCount,
    stop: unstamped,
  };
}

/**
 * Build the SpawnAgentOptions skeleton attachMonitoringStack reads.
 * Most fields are unused on the reattach path (no event forwarding —
 * apiToken not on the row; no heartbeat for the same reason; no
 * dispatch metadata — we pass `existingDispatchTracker` instead).
 * `repoName` + `cwd` + `prompt` + `timeoutMs` are the load-bearing
 * fields the helper actually reads.
 */
function buildSpawnOptionsForReattach(
  row: Dispatch,
  timeoutMs: number,
): SpawnAgentOptions {
  return {
    prompt: "", // unused — the agent is already running
    repoName: row.repoName,
    cwd: "", // unused — sessionDir override is supplied to attachMonitoringStack
    timeoutMs,
    onComplete: undefined,
  };
}

/**
 * Conditionally rewrite the per-dispatch MCP settings file when the
 * worker restarts on a different port. The rewrite is best-effort: a
 * failure to rewrite (parse error, missing file, EBUSY) is logged and
 * the reattach proceeds. Same-port restart (the production-pinned
 * case) is a no-op.
 */
async function maybeRewriteMcpSettings(
  row: Dispatch,
  currentWorkerPort: number,
): Promise<void> {
  if (!row.mcpSettingsPath) return;
  try {
    const result = await rewriteMcpSettingsIfPortChanged(
      row.mcpSettingsPath,
      currentWorkerPort,
    );
    if (result.rewritten) {
      log.info(
        `[Dispatch ${row.id}] rewrote ${row.mcpSettingsPath} (${result.oldPort} → ${result.newPort})`,
      );
    }
  } catch (err) {
    log.error(
      `[Dispatch ${row.id}] failed to rewrite ${row.mcpSettingsPath}; reattach proceeds`,
      err,
    );
  }
}

/**
 * Wire StallDetector for the reattached job — host-mode only, watcher-
 * required, terminalWatcher absent (the original `script -q -f` log
 * path is not stamped on the row). Falls back to the 7-minute watcher-
 * only threshold. On detected stall, calls `job.stop("failed", ...)` —
 * the same recovery path the dispatch core uses.
 *
 * Seed snapshot: `attachMonitoringStack` starts the watcher with
 * `fromEof:true` so the post-restart counters don't double-count
 * historical entries. That leaves `watcher.getEntries()` empty until
 * the next live JSONL write — and if the agent froze BEFORE the
 * worker died (operator Ctrl-D in the host TUI, permission deny,
 * OOM, etc.), no live writes will ever come and the detector would
 * sit on `"waiting"` forever. The seed is a one-shot read of the
 * on-disk JSONL at attach time; the detector uses it while the live
 * buffer is empty, then transparently switches to live data the
 * moment any new entry arrives.
 */
function attachStallDetectorForReattach(
  job: AgentJob,
  jsonlPath: string,
): void {
  if (!config.isHost) return;
  if (!job.watcher) return;
  const seedSnapshot = buildStallSnapshotFromJsonl(jsonlPath);
  const detector = new StallDetector({
    watcher: job.watcher,
    seedSnapshot,
    onStall: async () => {
      if (job.status !== "running") return;
      detector.stop();
      log.warn(
        `[Dispatch ${job.id}] reattached job stalled — stopping`,
      );
      await job.stop("failed", "Reattached agent stalled and did not recover");
    },
    maxNudges: 1,
  });
  detector.start();
  // Wrap cleanup so the detector stops on terminal state.
  const originalCleanup = job._cleanup;
  job._cleanup = async () => {
    detector.stop();
    await originalCleanup?.();
  };
}

/**
 * Read the JSONL once and derive the structural facts the stall
 * detector needs while the live watcher buffer is empty:
 *
 *  - `hasReceivedToolResult` — has the agent ever finished a tool call?
 *    Pre-tool-result, "waiting" is the correct state regardless of
 *    elapsed time.
 *  - `isToolCallPending` — is there an outstanding `tool_use` with no
 *    matching `tool_result`? Agent is waiting on a tool — "waiting".
 *  - `lastToolResultTimestamp` — when did the last tool_result land?
 *    `Date.now() - this` compared against the stall threshold gives
 *    the "frozen N minutes ago" verdict.
 *
 * Returns `undefined` (NOT an empty snapshot) when the JSONL is gone
 * or unreadable — caller treats undefined as "no seed available"
 * → pre-fix behavior (waiting until live entries arrive). The
 * watcher's own missing-file handling stays authoritative for the
 * absence-of-session-log error path.
 *
 * Exported for direct unit testing — the path through
 * `attachStallDetectorForReattach` is hard to exercise without
 * spinning up a full reattach flow.
 */
export function buildStallSnapshotFromJsonl(
  jsonlPath: string,
): StallSnapshot | undefined {
  let text: string;
  try {
    text = readFileSync(jsonlPath, "utf-8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  const pendingToolUseIds = new Set<string>();
  let hasReceivedToolResult = false;
  let lastToolResultTimestamp: number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as {
      type?: unknown;
      message?: { content?: unknown };
      timestamp?: unknown;
    };
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === "assistant") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          pendingToolUseIds.add(block.id);
        }
      }
      continue;
    }
    if (obj.type === "user") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          pendingToolUseIds.delete(block.tool_use_id);
          hasReceivedToolResult = true;
          if (typeof obj.timestamp === "string") {
            const ms = Date.parse(obj.timestamp);
            if (!Number.isNaN(ms)) lastToolResultTimestamp = ms;
          }
        }
      }
    }
  }
  return {
    hasReceivedToolResult,
    isToolCallPending: pendingToolUseIds.size > 0,
    lastToolResultTimestamp,
  };
}

/**
 * Build a watcher subscriber that increments tool / sub-agent counters
 * each time an assistant entry contains a `tool_use` block. Counters are
 * seeded from `initial` (the dispatch row's pre-restart totals) so
 * `getCounts()` always reflects pre-restart + post-restart accumulation.
 *
 * Exported for testability — the closure-based wiring inside
 * `reattachAlive` is the most subtle code in this module, and direct
 * unit tests prevent silent undercounts on reattached rows.
 */
export function buildToolCounterSubscriber(initial: {
  toolCallCount: number;
  subagentCount: number;
}): {
  subscriber: (entry: AgentLogEntry) => void;
  getCounts: () => { toolCallCount: number; subagentCount: number };
} {
  let toolCallCount = initial.toolCallCount;
  let subagentCount = initial.subagentCount;

  return {
    subscriber(entry: AgentLogEntry) {
      if (entry.type !== "assistant") return;
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
    },
    getCounts: () => ({ toolCallCount, subagentCount }),
  };
}

/**
 * Build a synthetic DispatchTracker that reuses an existing dispatch row.
 * Skips `insertDispatch` (the row already exists from the prior worker
 * incarnation) and finalizes via `updateDispatch` + an `eventBus.publish`
 * mirroring `startDispatchTracking`'s SSE shape so the dashboard observes
 * reattached terminal states without waiting for the next DB-change poll
 * cycle.
 *
 * `getCounters` is invoked at finalize time so the latest in-flight
 * `toolCallCount` / `subagentCount` are persisted — wire it to a
 * `buildToolCounterSubscriber()`'s `getCounts` for production use.
 *
 * Exported for testability.
 */
export function buildReattachTracker(
  row: Dispatch,
  getCounters: () => { toolCallCount: number; subagentCount: number },
  /**
   * DX-365 — repo `localPath` so the strike accumulator can read +
   * mutate `<repo>/.danxbot/settings.json`. Optional for
   * back-compat with existing tests that build the tracker without a
   * `RepoContext` — when null, `applyStrike` short-circuits before
   * touching disk so the reattach tracker still works in fixtures
   * without a settings file.
   */
  repoLocalPath: string | null = null,
): DispatchTracker {
  return {
    async finalize(
      status: DispatchStatus,
      fields: {
        summary?: string | null;
        error?: string | null;
        tokens: FinalizeTokens;
        nudgeCount?: number;
      },
    ): Promise<void> {
      const total =
        fields.tokens.tokensIn +
        fields.tokens.tokensOut +
        fields.tokens.cacheRead +
        fields.tokens.cacheWrite;
      const { toolCallCount, subagentCount } = getCounters();
      try {
        const completedAt = Date.now();
        await updateDispatch(row.id, {
          status,
          summary: fields.summary ?? null,
          error: fields.error ?? null,
          completedAt,
          pidTerminatedAt: completedAt,
          tokensIn: fields.tokens.tokensIn,
          tokensOut: fields.tokens.tokensOut,
          cacheRead: fields.tokens.cacheRead,
          cacheWrite: fields.tokens.cacheWrite,
          tokensTotal: total,
          toolCallCount,
          subagentCount,
          nudgeCount: fields.nudgeCount ?? row.nudgeCount,
        });
        // DX-365 — strike accumulator. Skipped when `repoLocalPath`
        // is null (test harness without a settings file), the row
        // carries no `agent_name` (Slack / ideator / external), or
        // the status is non-strike (`completed` / `cancelled`).
        await applyStrike({
          status,
          repoLocalPath,
          repoName: row.repoName,
          agentName: row.agentName,
          dispatchId: row.id,
          issueId: row.issueId,
          rawError: fields.error ?? null,
          timestampIso: new Date(completedAt).toISOString(),
        });
        // Mirror `startDispatchTracking`'s SSE publish so reattached
        // terminal states reach the dashboard immediately. Without
        // this, `dispatch:updated` only fires on the next DB-change
        // poll cycle (cadence-bound) — a regression vs fresh-spawn
        // observability. The Agents tab listens on this exact topic
        // (DX-164 Phase 6 / DX-218).
        eventBus.publish({
          topic: "dispatch:updated",
          data: {
            id: row.id,
            repoName: row.repoName,
            status,
            summary: fields.summary ?? null,
            error: fields.error ?? null,
            completedAt,
            tokensTotal: total,
          },
        });
      } catch (err) {
        log.error(
          `[Dispatch ${row.id}] reattach tracker finalize failed`,
          err,
        );
      }
    },
    async recordNudge(count: number): Promise<void> {
      try {
        await updateDispatch(row.id, { nudgeCount: count });
      } catch (err) {
        log.error(
          `[Dispatch ${row.id}] reattach tracker recordNudge failed`,
          err,
        );
      }
    },
    async recordRecoverCount(count: number): Promise<void> {
      try {
        await updateDispatch(row.id, { recoverCount: count });
      } catch (err) {
        log.error(
          `[Dispatch ${row.id}] reattach tracker recordRecoverCount failed`,
          err,
        );
      }
    },
  };
}

async function reattachAlive(
  row: Dispatch,
  pid: number,
  opts: ReattachOptions,
): Promise<
  { kind: "reattached"; job: AgentJob } | { kind: "failed"; reason: string }
> {
  if (!row.jsonlPath) {
    return { kind: "failed", reason: "session log gone" };
  }

  await maybeRewriteMcpSettings(row, opts.currentWorkerPort);

  const sessionDir = dirname(row.jsonlPath);
  const job = buildPartialJob(row, pid);

  // Tool / sub-agent counters: subscriber is wired through
  // `attachMonitoringStack`'s `extraOnEntry` slot — registered BEFORE
  // `watcher.start()` so the very first poll cycle's entries are
  // observed. Registering after the helper returns would miss every
  // tool_use emitted in that first cycle and silently undercount the
  // row at finalize time.
  const counters = buildToolCounterSubscriber({
    toolCallCount: row.toolCallCount,
    subagentCount: row.subagentCount,
  });
  const tracker = buildReattachTracker(
    row,
    counters.getCounts,
    opts.repo?.localPath ?? null,
  );

  const options = buildSpawnOptionsForReattach(
    row,
    opts.timeoutMs ?? config.dispatch.agentTimeoutMs,
  );

  await attachMonitoringStack({
    job,
    jobId: row.id,
    agentCwd: "", // unused — sessionDir wins
    sessionDir,
    fromEof: true,
    promptDir: null,
    options,
    existingDispatchTracker: tracker,
    extraOnEntry: [counters.subscriber],
  });

  attachStallDetectorForReattach(job, row.jsonlPath);

  return { kind: "reattached", job };
}

export async function reattachOrResolveDispatches(
  repoName: string,
  opts: ReattachOptions,
): Promise<ReattachResult> {
  const rows = await findNonTerminalDispatches(repoName);
  const result: ReattachResult = {
    scanned: rows.length,
    orphaned: [],
    alive: [],
    reattached: [],
    failedReattach: [],
    autoResumed: [],
  };
  if (rows.length === 0) {
    log.info(`[${repoName}] No non-terminal dispatches to reattach`);
    return result;
  }

  for (const row of rows) {
    const pid = row.hostPid;
    if (isDispatchOrphaned(row, isPidAlive)) {
      // Try auto-resume first — when the row has a recoverable session
      // (`sessionUuid` + `jsonlPath`) and an In Progress YAML still
      // points at this dispatch, we spawn a fresh dispatch with
      // `claude --resume <sessionId>` so the new agent inherits the
      // dead session's full conversation history. The parent row is
      // marked `cancelled` with a summary linking the child's id.
      //
      // On any refusal (no session, no YAML, dispatch throw) fall
      // through to the legacy orphan-mark behavior. The DB side-channel
      // contract (errors per row are logged + swallowed) extends to
      // the auto-resume path too — boot scan never blocks on a single
      // bad row.
      if (opts.repo) {
        try {
          const resumeOutcome = await attemptAutoResume(row, opts.repo);
          if (resumeOutcome.resumed) {
            result.autoResumed.push(row.id);
            log.info(
              `[${repoName}] reattach: ${row.id} dead (host_pid=${pid ?? "null"}) → auto-resumed as ${resumeOutcome.childDispatchId}`,
            );
            continue;
          }
          log.info(
            `[${repoName}] reattach: ${row.id} dead (host_pid=${pid ?? "null"}); auto-resume refused (${resumeOutcome.refusalReason}) → marking failed`,
          );
        } catch (err) {
          log.error(
            `[${repoName}] reattach: ${row.id} auto-resume threw; falling back to orphan-mark`,
            err,
          );
        }
      }

      try {
        await markOrphaned(row.id);
        result.orphaned.push(row.id);
        log.info(
          `[${repoName}] reattach: ${row.id} dead (host_pid=${pid ?? "null"}) → marked failed`,
        );
      } catch (err) {
        log.error(
          `[${repoName}] reattach: failed to mark dispatch ${row.id} as orphaned`,
          err,
        );
      }
      continue;
    }

    // Alive PID — full reattach attempt.
    result.alive.push(row.id);
    if (typeof pid !== "number") {
      // Defensive — `isDispatchOrphaned` should have caught a non-positive
      // pid, but isolate the cast so a contract drift fails loud here
      // instead of inside `process.kill`.
      log.error(
        `[${repoName}] reattach: row ${row.id} reported alive but hostPid is non-numeric (${pid}) — marking failed`,
      );
      try {
        await markOrphaned(row.id);
        result.failedReattach.push(row.id);
      } catch (err) {
        log.error(
          `[${repoName}] reattach: failed to mark non-numeric-pid row ${row.id} as orphaned`,
          err,
        );
      }
      continue;
    }
    try {
      const outcome = await reattachAlive(row, pid, opts);
      if (outcome.kind === "reattached") {
        registerActiveJob(row.id, outcome.job);
        result.reattached.push(row.id);
        log.info(
          `[${repoName}] reattach: ${row.id} alive (pid=${pid}) → monitoring stack attached`,
        );
      } else {
        await markSessionLogGone(row.id);
        result.failedReattach.push(row.id);
        log.warn(
          `[${repoName}] reattach: ${row.id} failed (${outcome.reason}) → marked failed`,
        );
      }
    } catch (err) {
      log.error(
        `[${repoName}] reattach: ${row.id} threw during alive-reattach; marking failed`,
        err,
      );
      try {
        await markSessionLogGone(row.id);
      } catch (innerErr) {
        log.error(
          `[${repoName}] reattach: also failed to mark ${row.id} as failed-reattach`,
          innerErr,
        );
      }
      result.failedReattach.push(row.id);
    }
  }

  return result;
}
