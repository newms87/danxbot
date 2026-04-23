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

/**
 * Snapshot of every job currently tracked — running and recently-finished
 * (still within the TTL grace window). Returns a fresh array so callers can
 * iterate safely without worrying about concurrent eviction.
 *
 * Used by `src/shutdown.ts` to drain in-flight dispatches on SIGTERM.
 * Callers that only care about live work should filter by
 * `job.status === "running"` themselves.
 */
export function listActiveJobs(): AgentJob[] {
  return Array.from(activeJobs.values());
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
 * body into this; the poller constructs one from a Trello trigger; the Slack
 * listener constructs one for every deep-agent reply. All three paths share
 * the same `allowTools` input via `resolveDispatchTools`.
 */
export interface DispatchInput {
  repo: RepoContext;
  task: string;
  /**
   * External API token for status/heartbeat PUTs and schema MCP calls.
   * Required when `statusUrl` is set (heartbeat) or when the allowlist
   * enables `mcp__schema__*` (schema MCP envs). Absent for the poller and
   * any dispatch with no schema or status callback.
   */
  apiToken?: string;
  /**
   * External API URL for the schema MCP server env. Required only when the
   * allowlist enables `mcp__schema__*`. Absent for the poller and any
   * dispatch that doesn't touch schema tools.
   */
  apiUrl?: string;
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
  /**
   * Inactivity timeout (ms) forwarded to spawnAgent. Defaults to
   * `config.dispatch.agentTimeoutMs`. The poller overrides this with its
   * own `pollerIntervalMs * 60` budget; HTTP handlers rely on the default.
   */
  timeoutMs?: number;
  /**
   * Open an interactive Windows Terminal tab alongside the headless claude.
   * Defaults to `config.isHost`. Callers rarely override — only scenarios
   * that need docker headless behavior inside host mode (tests) do.
   */
  openTerminal?: boolean;
  /**
   * Additional env overrides merged on top of the dispatch's base env.
   *
   * The dispatch always injects `DANXBOT_REPO_NAME=input.repo.name` into
   * the spawned agent's environment — callers never need to supply that.
   * This field is for everything else (test hooks, future integrations
   * that need custom env), and most callers can leave it undefined.
   *
   * Precedence when both are set: `input.env` wins over the auto-injected
   * invariants, which allows tests to override `DANXBOT_REPO_NAME` for
   * isolation. Don't rely on that in production callers — the auto-inject
   * is the contract.
   */
  env?: Record<string, string>;
  /**
   * Fired once the agent reaches a terminal state.
   *
   * Ordering guarantee (enforced inside `dispatch()`):
   *   1. Internal MCP-settings cleanup runs FIRST so the callback observes
   *      a fully disposed slot (no leftover temp dir).
   *   2. `onComplete(job)` runs SECOND with the final `AgentJob`.
   *   3. Any `statusUrl` PUT (fired by the Laravel forwarder and
   *      `putStatus` inside the launcher) is independent and may land
   *      before, during, or after this callback — they are NOT mutually
   *      exclusive. A caller that wants both a local callback AND an
   *      external PUT can set both fields.
   *
   * Today's consumer: the poller, for card-progress checks, stuck-card
   * recovery, and consecutive-failure backoff. HTTP handlers typically
   * omit this and rely on the dispatch-row stop endpoint instead — but
   * that's a choice, not an exclusion.
   */
  onComplete?: (job: AgentJob) => void;
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
  dispatchId: string,
): ResolveDispatchToolsOptions {
  const opts: ResolveDispatchToolsOptions = {
    allowTools: input.allowTools,
    danxbotStopUrl,
  };
  if (input.schemaDefinitionId || input.schemaRole) {
    // Normalize missing fields to empty strings so the schema registry's
    // explicit "missing apiUrl / apiToken / definitionId" `McpResolveError`
    // fires at resolve time (a loud, specific failure) — not an ambiguous
    // undefined read downstream. The `??` here is NOT a fallback; it's a
    // channeling step that keeps the fail-loud invariant.
    opts.schema = {
      apiUrl: input.apiUrl ?? "",
      apiToken: input.apiToken ?? "",
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
  // Slack-triggered dispatches get per-dispatch reply + update URLs that
  // resolve back to the worker's `/api/slack/{reply,update}/:id`
  // endpoints. The resolver injects these into the danxbot MCP server's
  // env and adds the Slack tools to `allowedTools`; any other dispatch
  // trigger gets neither — see `.claude/rules/agent-dispatch.md` and the
  // Phase 1 card `cJahgqlF` for the full enforcement contract.
  if (input.apiDispatchMeta.trigger === "slack") {
    opts.slack = {
      replyUrl: `http://localhost:${input.repo.workerPort}/api/slack/reply/${dispatchId}`,
      updateUrl: `http://localhost:${input.repo.workerPort}/api/slack/update/${dispatchId}`,
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
  const resolveOptions = buildResolveOptions(input, workerStopUrl, dispatchId);
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
      // eventForwarding needs BOTH statusUrl and apiToken — skip the callback
      // entirely when apiToken is absent (poller-style dispatches) even if
      // statusUrl happens to be set, since Laravel PUTs require bearer auth.
      // See `DispatchInput.apiToken` docstring for the required-when rules.
      const eventForwarding =
        input.statusUrl && input.apiToken
          ? { statusUrl: input.statusUrl, apiToken: input.apiToken }
          : undefined;
      // Dispatch-level env invariants. Every dispatched agent ALWAYS gets
      // `DANXBOT_REPO_NAME` set from `input.repo.name`; the caller never
      // has to remember. Caller-supplied `input.env` merges on top, so
      // tests can override for isolation without changing production
      // callers. See the `DispatchInput.env` docstring for the contract.
      const env: Record<string, string> = {
        DANXBOT_REPO_NAME: input.repo.name,
        ...input.env,
      };
      job = await spawnAgent({
        jobId,
        prompt,
        title: input.title,
        repoName: input.repo.name,
        timeoutMs: input.timeoutMs ?? config.dispatch.agentTimeoutMs,
        env,
        mcpConfigPath: settingsPath,
        allowedTools: resolved.allowedTools,
        agents: input.agents,
        statusUrl: input.statusUrl,
        apiToken: input.apiToken,
        maxRuntimeMs: input.maxRuntimeMs,
        eventForwarding,
        openTerminal: input.openTerminal ?? config.isHost,
        // Only the initial spawn records the dispatch row — stall-recovery
        // respawns reuse the same dispatchId in `activeJobs` and must NOT
        // create a second row for the same conceptual run.
        dispatch: isRespawn ? undefined : input.apiDispatchMeta,
        resumeSessionId: input.resumeSessionId,
        parentJobId: input.parentJobId,
        onComplete: (completedJob) => {
          // See `DispatchInput.onComplete` — cleanup runs before the
          // caller callback (the ordering guarantee is load-bearing).
          cleanupMcpSettings(settingsDir);
          input.onComplete?.(completedJob);
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
          await currentJob.stop(
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
