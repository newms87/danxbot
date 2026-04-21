/**
 * Unified dispatch core — the one `dispatch()` function every dispatch
 * entry-point calls. Owns MCP resolution, the per-dispatch settings.json
 * file, the single spawnAgent call, dispatch row creation, stall recovery,
 * activeJobs registration, and TTL-based eviction.
 *
 * Today's callers:
 *   - `handleLaunch` / `handleResume` in `src/worker/dispatch.ts`
 *
 * Later callers (planned in the XCptaJ34 card):
 *   - Poller `spawnClaude` (Phase 4) — migrates off direct `spawnAgent`
 *
 * Runs identically for launches and resumes — the only differences are
 * `input.resumeSessionId` (appended to the claude invocation via `spawnAgent`)
 * and `input.parentJobId` (persisted on the dispatch row).
 *
 * See `.claude/rules/agent-dispatch.md` for the full contract.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";
import {
  spawnAgent,
  buildCompletionInstruction,
  terminateWithGrace,
  type AgentJob,
} from "../agent/launcher.js";
import { TerminalOutputWatcher } from "../agent/terminal-output-watcher.js";
import { StallDetector } from "../agent/stall-detector.js";
import { resolveDispatchTools } from "../agent/resolve-dispatch-tools.js";
import type { ResolveDispatchToolsOptions } from "../agent/mcp-types.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import { updateDispatch } from "../dashboard/dispatches-db.js";

const log = createLogger("dispatch-core");

/** Maximum number of stall-recovery respawns before giving up and marking failed. */
const MAX_STALL_RESUMES = 3;

/** How long an evicted-but-finished job lingers in `activeJobs` for late pollers. */
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_POLL_INTERVAL_MS = 60_000;

/**
 * All dispatched jobs keyed by their stable `dispatchId`. Reused across stall-
 * recovery respawns (each respawn is a fresh claude process under a fresh
 * internal UUID, but `activeJobs` remains keyed by the first `dispatchId` so
 * external pollers see one conceptual run).
 *
 * Module-scoped singleton — worker HTTP handlers (`handleCancel`, `handleStop`,
 * `handleStatus`) read through `getActiveJob(jobId)`. Worker shutdown calls
 * `clearJobCleanupIntervals()` to drain the TTL timers.
 */
const activeJobs = new Map<string, AgentJob>();

/** TTL timers — one per dispatch — that evict finished jobs after the grace window. */
const jobCleanupIntervals = new Set<NodeJS.Timeout>();

/** Lookup a currently-tracked job (running or recently finished). */
export function getActiveJob(jobId: string): AgentJob | undefined {
  return activeJobs.get(jobId);
}

/** Drain all TTL eviction timers; call during worker shutdown. */
export function clearJobCleanupIntervals(): void {
  for (const interval of jobCleanupIntervals) {
    clearInterval(interval);
  }
  jobCleanupIntervals.clear();
}

/**
 * Everything a dispatch needs. Caller-facing shape — HTTP handlers map their
 * body into this; the poller (Phase 4) will construct one from a Trello
 * trigger; Slack `runAgent` (Phase 5) will share the same `allowTools` input
 * via `resolveDispatchTools`.
 */
export interface DispatchInput {
  repo: RepoContext;
  task: string;
  apiToken: string;
  apiUrl: string;
  /**
   * Explicit tool allowlist — REQUIRED. Built-ins bare (`Read`, `Bash`), MCP
   * tools as `mcp__<server>__<tool>` with optional `mcp__<server>__*` wildcards.
   * Empty array is valid and means "only `mcp__danxbot__danxbot_complete`."
   */
  allowTools: readonly string[];
  statusUrl?: string;
  schemaDefinitionId?: string;
  schemaRole?: string;
  title?: string;
  agents?: Record<string, Record<string, unknown>>;
  maxRuntimeMs?: number;
  /** Dispatch metadata persisted on the new row. */
  apiDispatchMeta: DispatchTriggerMetadata;
  /** Claude session UUID to resume. Undefined for fresh launches. */
  resumeSessionId?: string;
  /** Parent dispatch ID. Present when this slot is a resume child. */
  parentJobId?: string;
}

export interface DispatchResult {
  dispatchId: string;
  job: AgentJob;
}

/**
 * Write the per-dispatch MCP settings file to a fresh temp directory and
 * return its absolute path. Called by `dispatch()` after the resolver has
 * produced `{mcpServers, allowedTools}`. Caller is responsible for the
 * temp-dir cleanup (wired through `onComplete` below).
 */
function writeMcpSettingsFile(
  mcpServers: Record<string, unknown>,
): { settingsDir: string; settingsPath: string } {
  const settingsDir = mkdtempSync(join(tmpdir(), "danxbot-mcp-"));
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ mcpServers }, null, 2));
  return { settingsDir, settingsPath };
}

function cleanupMcpSettings(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch (err) {
    log.error(
      `Failed to clean up MCP settings dir ${settingsDir}:`,
      err,
    );
  }
}

/**
 * Build the `ResolveDispatchToolsOptions` from a `DispatchInput`. Sources
 * trello credentials from `input.repo.trello` when present so any dispatch
 * that includes `mcp__trello__*` in its allowlist just works.
 */
function buildResolveOptions(
  input: DispatchInput,
  danxbotStopUrl: string,
): ResolveDispatchToolsOptions {
  const opts: ResolveDispatchToolsOptions = {
    allowTools: input.allowTools,
    danxbotStopUrl,
  };
  if (input.schemaDefinitionId || input.schemaRole) {
    opts.schema = {
      apiUrl: input.apiUrl,
      apiToken: input.apiToken,
      definitionId: input.schemaDefinitionId ?? "",
      role: input.schemaRole,
    };
  }
  if (
    input.repo.trello?.apiKey &&
    input.repo.trello?.apiToken &&
    input.repo.trello?.boardId
  ) {
    opts.trello = {
      apiKey: input.repo.trello.apiKey,
      apiToken: input.repo.trello.apiToken,
      boardId: input.repo.trello.boardId,
    };
  }
  return opts;
}

/**
 * The one function every dispatch path calls. Owns the full per-dispatch
 * lifecycle (settings-file write, MCP resolution, agent spawn, stall
 * recovery, completion callback, activeJobs registration, TTL eviction).
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const dispatchId = randomUUID();
  const workerStopUrl = `http://localhost:${input.repo.workerPort}/api/stop/${dispatchId}`;

  // Resolve ONCE; reused on every stall-recovery respawn so the tool surface
  // stays identical across the lifetime of the dispatch slot.
  const resolveOptions = buildResolveOptions(input, workerStopUrl);
  const resolved = resolveDispatchTools(resolveOptions);

  // Append completion instruction to every dispatched task (keeps the agent
  // signalling completion via `danxbot_complete` instead of going silent).
  const taskWithInstruction = input.task + buildCompletionInstruction();

  let resumeCount = 0;

  /**
   * Spawn a new agent for this dispatch slot.
   * On initial spawn: uses the stable dispatchId.
   * On respawn: generates a fresh internal UUID for JSONL disambiguation,
   * but keeps dispatchId as the activeJobs key.
   */
  async function spawnForDispatch(
    prompt: string,
    isRespawn: boolean,
  ): Promise<AgentJob> {
    const jobId = isRespawn ? randomUUID() : dispatchId;
    const { settingsDir, settingsPath } = writeMcpSettingsFile(
      resolved.mcpServers,
    );

    let job: AgentJob;
    try {
      job = await spawnAgent({
        jobId,
        prompt,
        title: input.title,
        repoName: input.repo.name,
        timeoutMs: config.dispatch.agentTimeoutMs,
        mcpConfigPath: settingsPath,
        allowedTools: resolved.allowedTools,
        agents: input.agents,
        statusUrl: input.statusUrl,
        apiToken: input.apiToken,
        maxRuntimeMs: input.maxRuntimeMs,
        eventForwarding: input.statusUrl
          ? { statusUrl: input.statusUrl, apiToken: input.apiToken }
          : undefined,
        openTerminal: config.isHost,
        // Only the initial spawn records the dispatch row — stall-recovery
        // respawns reuse the same dispatchId in `activeJobs` and must NOT
        // create a second row for the same conceptual run.
        dispatch: isRespawn ? undefined : input.apiDispatchMeta,
        resumeSessionId: input.resumeSessionId,
        parentJobId: input.parentJobId,
        onComplete: () => {
          cleanupMcpSettings(settingsDir);
        },
      });
    } catch (spawnErr) {
      cleanupMcpSettings(settingsDir);
      throw spawnErr;
    }

    // Index under the stable dispatchId so callers can still poll.
    activeJobs.set(dispatchId, job);
    return job;
  }

  /**
   * Wire stall detection for a job. When a stall fires:
   *   - If resumeCount < MAX_STALL_RESUMES: kill + respawn with nudge prompt.
   *   - Otherwise: mark job as failed.
   */
  function setupStallDetection(job: AgentJob): void {
    if (
      !config.isHost ||
      !input.statusUrl ||
      !job.watcher ||
      !job.terminalLogPath
    )
      return;

    const termWatcher = new TerminalOutputWatcher(job.terminalLogPath);
    const stallDetector = new StallDetector({
      watcher: job.watcher,
      terminalWatcher: termWatcher,
      maxNudges: 1, // Each detector fires once; resumeCount tracks the total.
      onStall: async () => {
        resumeCount++;
        const currentJob = activeJobs.get(dispatchId);
        if (!currentJob || currentJob.status !== "running") return;

        termWatcher.stop();
        stallDetector.stop();

        if (resumeCount >= MAX_STALL_RESUMES) {
          log.warn(
            `[Dispatch ${dispatchId}] Max stall resumes (${MAX_STALL_RESUMES}) reached — marking job failed`,
          );
          await currentJob.stop?.(
            "failed",
            "Agent stalled repeatedly and did not recover",
          );
          return;
        }

        log.warn(
          `[Dispatch ${dispatchId}] Stall detected (resume ${resumeCount}/${MAX_STALL_RESUMES}) — killing and resuming`,
        );

        updateDispatch(dispatchId, { nudgeCount: resumeCount }).catch((err) =>
          log.error(
            `[Dispatch ${dispatchId}] Failed to record nudge count`,
            err,
          ),
        );

        await terminateWithGrace(currentJob, 5_000);

        // Use the original task (not taskWithInstruction) as the base so the
        // completion instruction appears exactly once, followed by the stall note.
        const nudgePrompt =
          input.task +
          buildCompletionInstruction() +
          `\n\n---\nNOTE: Your previous session appeared to stall after receiving ` +
          `a tool result (resume ${resumeCount}/${MAX_STALL_RESUMES}). ` +
          `Continue your work from where it was left off.`;

        try {
          const newJob = await spawnForDispatch(nudgePrompt, true);
          setupStallDetection(newJob);
        } catch (err) {
          log.error(
            `[Dispatch ${dispatchId}] Failed to respawn after stall:`,
            err,
          );
        }
      },
    });

    termWatcher.start();
    stallDetector.start();

    // Tear down when the job completes.
    const originalCleanup = job._cleanup;
    job._cleanup = () => {
      termWatcher.stop();
      stallDetector.stop();
      originalCleanup?.();
    };
  }

  const job = await spawnForDispatch(taskWithInstruction, false);
  setupStallDetection(job);

  // TTL eviction — keep finished jobs in `activeJobs` for an hour after
  // completion so late `/api/status` polls still succeed, then drop them.
  const cleanupInterval = setInterval(() => {
    const currentJob = activeJobs.get(dispatchId);
    if (
      currentJob &&
      currentJob.status !== "running" &&
      Date.now() - (currentJob.completedAt?.getTime() ?? 0) >
        COMPLETED_JOB_TTL_MS
    ) {
      activeJobs.delete(dispatchId);
      clearInterval(cleanupInterval);
      jobCleanupIntervals.delete(cleanupInterval);
    }
  }, CLEANUP_POLL_INTERVAL_MS);
  jobCleanupIntervals.add(cleanupInterval);

  return { dispatchId, job };
}
