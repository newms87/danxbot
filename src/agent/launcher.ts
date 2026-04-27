/**
 * Agent Launcher — Spawns Claude Code agents via a single spawnAgent() entrypoint.
 *
 * Every agent process is monitored by a SessionLogWatcher that reads Claude Code's
 * native JSONL session files from disk. This works identically for piped mode
 * (headless) and terminal mode (interactive) because Claude Code writes JSONL
 * regardless of how it's invoked.
 *
 * Callers opt into features via SpawnAgentOptions:
 * - eventForwarding: batched event POSTs to Laravel API
 * - heartbeat: periodic status PUTs (dispatch API)
 * - openTerminal: also opens an interactive Windows Terminal tab
 * - mcpConfigPath: MCP server config for dispatch agents
 * - maxRuntimeMs: hard runtime cap
 */

import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { workspacePath } from "../workspace/generate.js";
import {
  buildCleanEnv,
  logPromptToDisk,
  createInactivityTimer,
  setupProcessHandlers,
} from "./process-utils.js";
import { SessionLogWatcher } from "./session-log-watcher.js";
import { buildClaudeInvocation } from "./claude-invocation.js";
import { probeAllMcpServers } from "./mcp-server-probe.js";
import {
  preflightClaudeAuth,
  ClaudeAuthError,
} from "./claude-auth-preflight.js";
import {
  preflightProjectsDir,
  ProjectsDirError,
} from "./projects-dir-preflight.js";
import {
  createLaravelForwarder,
  deriveQueuePath,
} from "./laravel-forwarder.js";
import { EventQueue } from "./event-queue.js";
import { getDanxbotCommit } from "./danxbot-commit.js";
import {
  startDispatchTracking,
  type DispatchTracker,
} from "../dashboard/dispatch-tracker.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";
import {
  buildDispatchScript,
  getTerminalLogPath,
  spawnInTerminal,
} from "../terminal.js";
import {
  readPidFileWithTimeout,
  createHostExitWatcher,
  killHostPid,
  isPidAlive,
  type HostExitWatcher,
} from "./host-pid.js";

const log = createLogger("launcher");

const HEARTBEAT_INTERVAL_MS = 10_000;
const TERMINAL_STATUS_RETRIES = 3;
const TERMINAL_STATUS_RETRY_DELAY_MS = 2_000;

/** How long to wait for the host-mode bash script to write its PID file. */
const HOST_PID_FILE_TIMEOUT_MS = 2_000;
/** Polling cadence while waiting for the host-mode PID file to appear. */
const HOST_PID_FILE_POLL_MS = 50;
/** Polling cadence for the host-mode liveness check (SIGNAL 0 on the PID). */
const HOST_EXIT_POLL_MS = 500;

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AgentJob {
  id: string;
  status: "running" | "completed" | "failed" | "timeout" | "canceled";
  summary: string;
  startedAt: Date;
  completedAt?: Date;
  statusUrl?: string;
  /**
   * Running totals accumulated from every assistant entry's `message.usage`
   * in the single dispatch JSONL. Claude Code emits per-turn usage on each
   * assistant entry; total = sum across entries. One JSONL per dispatch
   * (see `.claude/rules/agent-dispatch.md`) means no double-counting.
   */
  usage: AgentUsage;
  /**
   * Docker runtime: the headless claude ChildProcess. Undefined in host runtime —
   * host mode does not spawn claude as a direct child of this node process
   * (it runs inside a detached Windows Terminal tab). Use `claudePid` instead.
   */
  process?: ChildProcess;
  /**
   * Host runtime: PID of the `script -q -f` process wrapping the claude TUI.
   * The bash dispatch script writes `$$` to a file and immediately `exec`s
   * `script`, which preserves the PID — so this value IS the `script` PID,
   * and its direct child is claude. SIGTERM to this PID propagates through
   * `script` to claude's pty and the terminal tab closes on exit. See
   * `.claude/rules/agent-dispatch.md` and `src/terminal.ts` for the cascade.
   */
  claudePid?: number;
  /**
   * Host runtime: watcher that polls `process.kill(pid, 0)` to detect when
   * the dispatched claude has exited, so the launcher can transition the job
   * to a terminal state. Not set in docker runtime.
   */
  hostExitWatcher?: HostExitWatcher;
  heartbeatInterval?: ReturnType<typeof setInterval>;
  /** The SessionLogWatcher monitoring this job's JSONL session file. */
  watcher?: SessionLogWatcher;
  /**
   * Dispatch row tracker. Set when `options.dispatch` is passed to spawnAgent.
   * Undefined for runs that should not appear in the dispatch history.
   */
  dispatchTracker?: DispatchTracker;
  /**
   * Path where `script -q -f` writes terminal output when openTerminal is true.
   * Used by TerminalOutputWatcher + StallDetector for thinking indicator detection.
   */
  terminalLogPath?: string;
  /**
   * Internal cleanup callback — tears down watcher, forwarder, timers, and
   * awaits `dispatchTracker.finalize` so the dispatches DB row reflects the
   * full token + counter totals from the JSONL. Returns a promise so call
   * sites that issue terminal-state HTTP PUTs (cancelJob, job.stop) can
   * sequence the PUT after the final DB write. Fire-and-forget callers
   * (inactivity / max-runtime timers, defensive re-runs from
   * setupProcessHandlers) drop the promise — the launcher caches the
   * in-flight cleanup promise so concurrent callers observe the same chain.
   */
  _cleanup?: () => Promise<void>;
  /**
   * Fires options.onComplete with the job when a terminal state is reached
   * outside of the close/exit handler flow (i.e. from cancelJob). Lets
   * dispatch-layer teardown such as cleanupMcpSettings run on cancel — the
   * close handler would otherwise early-return because status is pre-set.
   */
  _onComplete?: () => void;
  /**
   * Agent-initiated stop — signals that the agent completed or failed gracefully.
   * Sends SIGTERM, waits 5s, then SIGKILL if needed, then fires onComplete.
   * Use for lifecycle tool callbacks (dispatch agents). For user cancellations, use cancelJob().
   *
   * Always set by `spawnAgent()` before the job is returned to the caller — required,
   * not optional, so call sites don't have to silently no-op on a missing handler.
   */
  stop: (status: "completed" | "failed", summary?: string) => Promise<void>;
}

/**
 * Send `signal` to the agent process using whichever handle the runtime gave
 * us — the ChildProcess in docker mode or the tracked PID in host mode.
 * Safe to call when no handle is attached (e.g. after cleanup).
 *
 * Exported so callers outside the launcher (dispatch stall recovery, future
 * lifecycle tools) can drive cancellation without duplicating the runtime
 * fork — see `.claude/rules/agent-dispatch.md`, "Single Fork Principle".
 */
export function killAgentProcess(job: AgentJob, signal: NodeJS.Signals): void {
  if (job.process) {
    job.process.kill(signal);
    return;
  }
  if (job.claudePid !== undefined) {
    killHostPid(job.claudePid, signal);
  }
}

/**
 * Returns true when the runtime handle indicates the process is still running.
 * Docker: the ChildProcess `exitCode` is nullish (per Node docs, exitCode is
 * null for a running process). Host: the tracked PID still exists.
 * `.killed` is intentionally NOT checked — it flips true as soon as `.kill()`
 * dispatches a signal, even if the process hasn't yet exited.
 */
export function isAgentProcessAlive(job: AgentJob): boolean {
  if (job.process) {
    return job.process.exitCode == null;
  }
  if (job.claudePid !== undefined) {
    return isPidAlive(job.claudePid);
  }
  return false;
}

/**
 * Send SIGTERM, wait `graceMs`, then SIGKILL if the process is still alive.
 * The two-phase pattern gives the agent a chance to flush state (final
 * assistant message, usage totals) before forceful termination. Works
 * identically in docker and host mode via the runtime-aware helpers.
 */
export async function terminateWithGrace(
  job: AgentJob,
  graceMs: number,
): Promise<void> {
  killAgentProcess(job, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (isAgentProcessAlive(job)) {
    killAgentProcess(job, "SIGKILL");
  }
}

export interface SpawnAgentOptions {
  /** The prompt/command to pass to claude CLI */
  prompt: string;
  /** Short title shown in the agent's initial message alongside the prompt file reference.
   *  Typically includes tracking IDs (e.g. "AgentDispatch #AGD-359, SchemaDefinition #SD-176")
   *  so humans can identify the dispatch in session logs and thread UIs. */
  title?: string;
  /** Repo name — used to resolve cwd to repos/<name> */
  repoName: string;
  /**
   * Override the spawned agent's working directory. When set, replaces the
   * default `workspacePath(options.repoName)` resolution. Used by the
   * workspace-dispatch path (`dispatchWithWorkspace`) to point claude at the
   * resolved `<repo>/.danxbot/workspaces/<name>/` workspace dir instead of
   * the singular legacy `<repo>/.danxbot/workspace/`. Absent for legacy
   * dispatches, which keep the singular path until P5 retires it.
   */
  cwd?: string;
  /** Optional pre-generated job ID. If not set, a UUID is generated. Used to keep
   *  the activeJobs key stable across stall-recovery respawns. */
  jobId?: string;
  /** Inactivity timeout in milliseconds */
  timeoutMs: number;
  /** Additional env vars to merge into the spawned process environment */
  env?: Record<string, string>;
  /** Called when the agent finishes (success, failure, or timeout) */
  onComplete?: (job: AgentJob) => void;
  /** Path to MCP settings JSON. When set, adds --mcp-config to CLI args. */
  mcpConfigPath?: string;
  /**
   * Agent definitions forwarded to Claude CLI's `--agents <json>` flag.
   * Must be an object keyed by agent name (the shape Claude CLI requires) —
   * a list silently falls back to built-in agents and makes
   * `Agent(subagent_type: "<name>")` fail with "Agent type not found".
   * See `.claude/rules/agent-dispatch.md`.
   */
  agents?: Record<string, Record<string, unknown>>;
  /** Status URL for heartbeat/putStatus (stored on AgentJob for startHeartbeat) */
  statusUrl?: string;
  /** API token for heartbeat and event forwarding */
  apiToken?: string;
  /** When set, starts batched event forwarding to the Laravel API */
  eventForwarding?: {
    statusUrl: string;
    apiToken: string;
  };
  /** Hard runtime cap in milliseconds (does NOT reset on activity) */
  maxRuntimeMs?: number;
  /** If true, also opens an interactive Windows Terminal tab for the agent */
  openTerminal?: boolean;
  /**
   * When set, a `dispatches` row is created for this spawn and finalized when
   * the agent reaches a terminal state. Omit for runs that should not appear
   * in the dispatch history (e.g., Slack router-only responses).
   */
  dispatch?: DispatchTriggerMetadata;
  /**
   * Claude session UUID to resume via `claude --resume`. Passed through to
   * `buildClaudeInvocation`. When set, claude loads the prior session's
   * history; a fresh dispatch tag is still prepended so SessionLogWatcher can
   * disambiguate this spawn's slice inside the shared JSONL.
   */
  resumeSessionId?: string;
  /**
   * Parent dispatch ID when this spawn is a resume child. Forwarded to the
   * dispatches row so the resume chain is queryable. Requires `dispatch` to
   * also be set — a non-tracked run with a parent would silently drop the
   * lineage, so spawnAgent throws when parentJobId is set without dispatch.
   */
  parentJobId?: string | null;
}

/**
 * PUT status update to the dispatch's status_url.
 * Terminal statuses (completed, failed, canceled) retry up to 3 times.
 */
export async function putStatus(
  job: AgentJob,
  apiToken: string,
  status: string,
  message?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!job.statusUrl) return;

  const body = JSON.stringify({
    status,
    message: message || undefined,
    data: data || undefined,
  });

  const isTerminal = status !== "running";
  const maxAttempts = isTerminal ? TERMINAL_STATUS_RETRIES : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(job.statusUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body,
      });

      if (response.ok) return;

      log.error(
        `[Job ${job.id}] Status PUT failed (attempt ${attempt}/${maxAttempts}): HTTP ${response.status}`,
      );
    } catch (err) {
      log.error(
        `[Job ${job.id}] Status PUT error (attempt ${attempt}/${maxAttempts}):`,
        err,
      );
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, TERMINAL_STATUS_RETRY_DELAY_MS),
      );
    }
  }

  if (isTerminal) {
    log.error(
      `[Job ${job.id}] All ${maxAttempts} status PUT attempts failed for terminal status '${status}'.`,
    );
  }
}

/**
 * Start the heartbeat loop for a running job.
 * Sends PUT {status_url} with { status: "running" } every 10 seconds.
 */
export function startHeartbeat(job: AgentJob, apiToken: string): void {
  if (!job.statusUrl) return;

  job.heartbeatInterval = setInterval(() => {
    if (job.status !== "running") {
      stopHeartbeat(job);
      return;
    }
    putStatus(job, apiToken, "running");
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(job: AgentJob): void {
  if (job.heartbeatInterval) {
    clearInterval(job.heartbeatInterval);
    job.heartbeatInterval = undefined;
  }
}

/**
 * Fire-and-forget terminal notification: PUT the external dispatcher (if
 * configured) then invoke the caller's onComplete. Used by every sync-context
 * terminal transition (inactivity timer, max-runtime timer, host onExit).
 *
 * The await-variants (job.stop, cancelJob, spawnHostMode spawn-error catch)
 * compose this pattern inline because they need await for other reasons
 * (5s grace wait, error propagation via rethrow). The docker close-handler
 * wrapper has its own shape because it coerces status via exit-code mapping
 * inside setupProcessHandlers. See the follow-up Action Items card
 * `[Danxbot] Extract finalizeTerminalState helper` for the broader unification.
 */
function notifyTerminalStatus(
  job: AgentJob,
  options: {
    statusUrl?: string;
    apiToken?: string;
    onComplete?: (j: AgentJob) => void;
  },
  status: string,
  summary?: string,
): void {
  if (options.statusUrl && options.apiToken) {
    putStatus(job, options.apiToken, status, summary);
  }
  options.onComplete?.(job);
}

/**
 * Returns the system instruction appended to dispatch agent prompts when the
 * danxbot_complete MCP tool is available. Tells the agent to call the tool
 * instead of silently stopping output.
 */
export function buildCompletionInstruction(): string {
  return (
    "\n\n---\nIMPORTANT: When you have finished all work, you MUST call the " +
    "`danxbot_complete` tool with status 'completed' and a brief summary. " +
    "Do not simply stop producing output — always call the completion tool to " +
    "signal that you are done. If you encounter a fatal error, call it with " +
    "status 'failed' and a description of the error."
  );
}

/**
 * Spawn a Claude Code agent process.
 *
 * Always starts a SessionLogWatcher to monitor Claude's native JSONL session
 * files from disk. The watcher provides: inactivity timeout reset, job summary
 * extraction (last assistant text), and optional event forwarding.
 *
 * The dispatch tag (`<!-- danxbot-dispatch:jobId -->`) is prepended to the prompt
 * so the watcher can deterministically find the correct JSONL file.
 */
export async function spawnAgent(
  options: SpawnAgentOptions,
): Promise<AgentJob> {
  // Fail loud: a parent lineage without a dispatch row is a silent drop of
  // resume context — callers that want resume MUST opt into tracking.
  if (options.parentJobId && !options.dispatch) {
    throw new Error(
      "spawnAgent: parentJobId requires dispatch metadata — a resume without a dispatch row silently drops lineage",
    );
  }

  // Claude-auth preflight (Trello 3l2d7i46). RO bind / expired token / missing
  // credentials all surface as silent dispatch timeouts — `claude -p` exits
  // 0 with empty stdout, the watcher never attaches, and the worker reports
  // "Agent timed out after N seconds of inactivity" pointing at network
  // instead of at the actual broken auth chain. Run this BEFORE
  // `buildClaudeInvocation` (which writes a prompt temp dir) so the early
  // failure path needs no cleanup. Cheap — single stat + read on the bind.
  const authPreflight = await preflightClaudeAuth();
  if (!authPreflight.ok) {
    throw new ClaudeAuthError(authPreflight);
  }

  // Trello cjAyJpgr-followup: parallel silent-failure mode on the projects
  // dir bind. If `~/.claude/projects/` is owned by root (Docker auto-create
  // when the OLD `${CLAUDE_PROJECTS_DIR:?...}` mount resolved to a
  // non-existent path on first compose-up), claude `-p` silently fails
  // to write JSONL, the watcher never attaches, and the dispatch times
  // out with no useful summary. Same pattern as auth-preflight: fail
  // loud at spawn so the operator sees the actionable chown command.
  const projectsPreflight = await preflightProjectsDir();
  if (!projectsPreflight.ok) {
    throw new ProjectsDirError(projectsPreflight);
  }

  const jobId = options.jobId ?? randomUUID();

  // `stop` is assigned below (line ~661) once the cleanup closure is built. Use
  // a throwing placeholder so the type contract stays non-optional — calling
  // stop() before the real handler is wired would be a construction bug, not
  // a legitimate race we need to tolerate.
  const job: AgentJob = {
    id: jobId,
    status: "running",
    summary: "",
    startedAt: new Date(),
    statusUrl: options.statusUrl,
    stop: async () => {
      throw new Error(`spawnAgent: job.stop called before initialization (jobId=${jobId})`);
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  const env = buildCleanEnv(options.env);

  // Single builder — docker and host paths share the exact flags + firstMessage.
  // Runtime only decides whether firstMessage is appended via `-p` (docker
  // headless) or passed as a positional argument inside the bash wrapper
  // (host interactive). See `.claude/rules/agent-dispatch.md`.
  const invocation = buildClaudeInvocation({
    prompt: options.prompt,
    jobId,
    title: options.title,
    mcpConfigPath: options.mcpConfigPath,
    agents: options.agents,
    resumeSessionId: options.resumeSessionId,
  });
  const { flags, firstMessage, promptDir } = invocation;

  // Dispatched agents cwd into the generated workspace, NOT the repo root.
  // The workspace (`<repo>/.danxbot/workspace/`) is owned entirely by
  // danxbot and holds the `.mcp.json` stub, `.claude/settings.json`,
  // `CLAUDE.md`, and the dual-written rules/skills/tools the poller
  // injects. The repo root belongs to the developer's interactive claude
  // session (use case #1). This isolation is the point of the
  // agent-isolation epic — see Trello card `7ha2CSpc` and
  // `.claude/rules/agent-dispatch.md`. Any future change to what
  // dispatched agents see from their cwd lands inside `workspacePath` /
  // `generateWorkspace`, NOT here.
  const agentCwd = options.cwd ?? workspacePath(options.repoName);

  log.info(`[Job ${jobId}] Launching agent`);
  log.info(`[Job ${jobId}] Prompt: ${options.prompt.substring(0, 200)}`);

  logPromptToDisk(config.logsDir, jobId, options.prompt, options.agents);

  // Pre-launch MCP probe — verify every configured MCP server can actually
  // start and respond to an `initialize` request before claude is spawned.
  // Claude launches happily even when an MCP server crashes on startup; the
  // tools silently disappear from the agent's tool set and the agent either
  // burns credits before noticing or never notices at all. Failing loudly
  // here preserves the "fallbacks are bugs" invariant (see
  // `.claude/rules/code-quality.md`).
  //
  // Cleanup on failure: we must rmSync `promptDir` ourselves because the
  // internal `cleanup()` closure (defined below, which would normally handle
  // it) isn't in scope yet. The caller-side catch in `dispatch()` (see
  // `src/dispatch/core.ts`'s `spawnForDispatch`) handles the MCP settings
  // temp dir but does NOT know about `promptDir`. Skipping this would leak
  // a /tmp/danxbot-prompt-* dir on every broken dispatch.
  if (options.mcpConfigPath) {
    const probeResult = await probeAllMcpServers(
      options.mcpConfigPath,
      config.dispatch.mcpProbeTimeoutMs,
    );
    if (!probeResult.ok) {
      rmSync(promptDir, { recursive: true, force: true });
      const names = probeResult.failures.map((f) => f.serverName).join(", ");
      const details = probeResult.failures
        .map((f) => `  - ${f.message}`)
        .join("\n");
      throw new Error(
        `MCP server probe failed for [${names}] before launching agent:\n${details}`,
      );
    }
  }

  // --- SessionLogWatcher: the single monitoring mechanism, runs identically in
  //     both docker and host modes (see `.claude/rules/agent-dispatch.md`). ---
  let lastAssistantText = "";

  const watcher = new SessionLogWatcher({
    cwd: agentCwd,
    pollIntervalMs: 5_000,
    dispatchId: jobId,
  });
  job.watcher = watcher;

  // Track last assistant text for job summary + accumulate per-turn usage
  // totals + reset inactivity timeout.
  //
  // Usage dedup: Claude Code writes one JSONL entry per content block in a
  // multi-block assistant turn (text + tool_use, thinking + text + tool_use,
  // etc.) but stamps the IDENTICAL response-level `message.usage` on every
  // entry. Without dedup the accumulator counted that single API response
  // 2-5× — verified in production (gpt-manager job 830cbd99: real usage
  // in=6/out=110/cache_creation=100,362, accumulator reported double).
  // Track seen `message.id`s in this closure and accumulate at most once
  // per id. Entries without an id (malformed; never seen in real Claude
  // Code output) still accumulate so a single bad line never silently
  // zeroes billable usage.
  const seenUsageMessageIds = new Set<string>();
  let warnedMissingMessageId = false;
  watcher.onEntry((entry) => {
    inactivityTimer.reset();

    if (entry.type === "assistant") {
      const content = (entry.data.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          lastAssistantText = block.text as string;
        }
      }

      const usage = entry.data.usage as Partial<AgentUsage> | undefined;
      if (usage) {
        const messageId = entry.data.messageId as string | undefined;
        if (messageId) {
          if (seenUsageMessageIds.has(messageId)) return;
          seenUsageMessageIds.add(messageId);
        } else if (!warnedMissingMessageId) {
          warnedMissingMessageId = true;
          log.warn(
            `[Job ${jobId}] Assistant entry has usage but no message.id — accumulating defensively. If this is a new Claude Code release, the dedup contract may need updating.`,
          );
        }
        job.usage.input_tokens += usage.input_tokens ?? 0;
        job.usage.output_tokens += usage.output_tokens ?? 0;
        job.usage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
        job.usage.cache_creation_input_tokens +=
          usage.cache_creation_input_tokens ?? 0;
      }
    }
  });

  // --- Optional event forwarding ---
  let forwarderFlush: (() => Promise<void>) | undefined;
  if (options.eventForwarding) {
    const queue = new EventQueue(
      deriveQueuePath(join(config.logsDir, "event-queue"), jobId),
    );
    const forwarder = createLaravelForwarder(
      options.eventForwarding.statusUrl,
      options.eventForwarding.apiToken,
      { queue },
    );
    watcher.onEntry(forwarder.consume);
    forwarderFlush = forwarder.flush;
  }

  // --- Optional dispatch tracking: create a dispatches row and finalize it
  //     when a terminal state is reached. Callers that should not appear in
  //     dispatch history (e.g., Slack router-only) omit options.dispatch. ---
  let dispatchTracker: DispatchTracker | undefined;
  if (options.dispatch) {
    dispatchTracker = await startDispatchTracking({
      jobId,
      repoName: options.repoName,
      trigger: options.dispatch,
      runtimeMode: config.isHost ? "host" : "docker",
      danxbotCommit: getDanxbotCommit(),
      watcher,
      startedAtMs: job.startedAt.getTime(),
      parentJobId: options.parentJobId ?? null,
    });
    job.dispatchTracker = dispatchTracker;
  }

  watcher.start();

  let stderr = "";
  let termSettingsDirToClean: string | undefined;

  // --- Inactivity timer: resets on watcher entries, kills via the runtime-
  //     aware handle (docker: child.kill; host: process.kill(pid, sig)). ---
  const inactivityTimer = createInactivityTimer(
    (signal) => killAgentProcess(job, signal),
    options.timeoutMs,
    (j) => {
      // Fire-and-forget: cleanup awaits drain + finalize internally so the
      // dispatch row converges on its own. The external Laravel PUT is a
      // separate store; a brief order skew vs. the local DB is acceptable.
      void cleanup();
      // The docker close-handler wrapper only PUTs when job.status === "running"
      // at close time; by the time the child exits here it will not issue a
      // terminal PUT. notifyTerminalStatus is the only signal the dispatcher
      // receives for an inactivity timeout.
      notifyTerminalStatus(j, options, "timeout", j.summary);
    },
    job,
  );

  // --- Optional heartbeat ---
  if (options.statusUrl && options.apiToken) {
    startHeartbeat(job, options.apiToken);
  }

  // --- Optional max runtime ---
  let maxRuntimeHandle: ReturnType<typeof setTimeout> | undefined;
  if (options.maxRuntimeMs) {
    maxRuntimeHandle = setTimeout(() => {
      if (job.status === "running") {
        log.info(
          `[Job ${jobId}] Max runtime exceeded — ${options.maxRuntimeMs! / 1000}s — killing process`,
        );
        killAgentProcess(job, "SIGTERM");
        job.status = "timeout";
        job.summary = `Agent exceeded max runtime of ${Math.round(options.maxRuntimeMs! / 1000 / 60)} minutes`;
        job.completedAt = new Date();
        // See inactivity-timer comment — fire-and-forget; cleanup awaits
        // drain + finalize internally.
        void cleanup();
        // See the inactivity-timer comment above — docker close-handler will
        // not issue a terminal PUT once job.status !== "running".
        notifyTerminalStatus(job, options, "timeout", job.summary);
      }
    }, options.maxRuntimeMs);
  }

  // Cache the in-flight cleanup promise so concurrent callers (e.g. the
  // close handler's `void cleanup()` racing cancelJob's `await
  // job._cleanup()`) all observe the SAME drain + finalize chain, instead of
  // the second caller short-circuiting on a flag and resolving its await
  // before the first chain has actually finished. A bare boolean flag would
  // satisfy idempotency but defeat the only reason cancelJob and job.stop
  // await the cleanup at all (sequencing the external `putStatus` PUT after
  // the dispatch row's finalize commit).
  let cleanupPromise: Promise<void> | undefined;

  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    // Catch so fire-and-forget callers (close handler, inactivity timer,
    // host onExit) never raise an unhandled rejection if drain/finalize
    // throw. Errors are logged via the inner try/catch around
    // `dispatchTracker.finalize`; this outer .catch is a defense-in-depth
    // net for everything else (drain itself, watcher.stop, forwarderFlush).
    cleanupPromise = runCleanup().catch((err) => {
      log.error(`[Job ${jobId}] Cleanup failed`, err);
    });
    return cleanupPromise;
  }

  async function runCleanup(): Promise<void> {
    // Synchronous teardown FIRST — stops external observers (heartbeat
    // PUTs, host exit watcher, inactivity + max-runtime timers) before the
    // first await yields control. Callers that fire-and-forget cleanup and
    // then immediately read job state (existing tests, the dispatch
    // pipeline's onComplete) see a fully-quiesced job. Async work (drain,
    // finalize, forwarder flush) runs afterward — those write to external
    // stores (JSONL, dispatches DB, Laravel API) the synchronous reader
    // doesn't depend on.
    inactivityTimer.clear();
    stopHeartbeat(job);
    if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
    if (job.hostExitWatcher) {
      job.hostExitWatcher.stop();
    }

    // Observer teardown is wrapped in try/finally so a synchronous throw from
    // any observer (watcher.stop, dispatchTracker.finalize, forwarder.flush)
    // cannot strand the temp dirs. Temp-dir cleanup MUST run.
    try {
      // Drain any JSONL bytes written between the last scheduled poll and
      // now BEFORE stopping the watcher. Without this, the agent's final
      // assistant entry — which carries the closing `usage` block + the
      // `tool_use` for `danxbot_complete` — lands in the JSONL after the
      // last tick fired, the watcher halts before reading it, and
      // `dispatchTracker.finalize` snapshots stale `job.usage`. Manifests
      // as every token + counter field undercounting the on-disk JSONL by
      // exactly what was appended in the trailing <pollIntervalMs window.
      await watcher.drain();
      watcher.stop();
      void forwarderFlush?.();
      if (dispatchTracker && job.status !== "running") {
        const dispatchStatus =
          job.status === "completed"
            ? "completed"
            : job.status === "canceled"
              ? "cancelled"
              : "failed";
        try {
          await dispatchTracker.finalize(dispatchStatus, {
            summary: job.summary || null,
            error: dispatchStatus === "failed" ? job.summary || null : null,
            tokens: {
              tokensIn: job.usage.input_tokens,
              tokensOut: job.usage.output_tokens,
              cacheRead: job.usage.cache_read_input_tokens,
              cacheWrite: job.usage.cache_creation_input_tokens,
            },
          });
        } catch (err) {
          log.error(`[Job ${jobId}] Dispatch finalize failed`, err);
        }
      }
    } finally {
      // rmSync with force:true is no-op on missing paths, so we don't need
      // existence guards — only a promptDir sentinel for docker mode before
      // buildClaudeInvocation ran would warrant one, and that cannot happen:
      // `promptDir` is assigned before any spawn work.
      rmSync(promptDir, { recursive: true, force: true });
      if (termSettingsDirToClean) {
        rmSync(termSettingsDirToClean, { recursive: true, force: true });
      }
    }
  }

  job._cleanup = cleanup;
  job._onComplete = () => options.onComplete?.(job);

  // --- Agent-initiated stop mechanism ---
  // The agent calls stop() via the HTTP /api/stop/:jobId endpoint when lifecycle
  // tools signal completion. This is distinct from cancelJob() (user-initiated).
  job.stop = async (
    status: "completed" | "failed",
    summary?: string,
  ): Promise<void> => {
    if (job.status !== "running") return;
    if (!job.process && job.claudePid === undefined) return;

    log.info(`[Job ${jobId}] Agent self-stop (${status}) — sending SIGTERM`);

    // Set terminal status BEFORE killing to prevent the close handler from overriding it
    job.status = status;
    if (summary) job.summary = summary;
    job.completedAt = new Date();

    // Register exit listener BEFORE kill to avoid missing a fast exit. Docker
    // uses the ChildProcess close event; host uses the liveness-poll watcher.
    let processExited = false;
    if (job.process) {
      job.process.once("close", () => {
        processExited = true;
      });
    } else if (job.hostExitWatcher) {
      job.hostExitWatcher.onExit(() => {
        processExited = true;
      });
    }

    killAgentProcess(job, "SIGTERM");

    // Wait 5s for graceful shutdown, then SIGKILL if still alive
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    if (!processExited && isAgentProcessAlive(job)) {
      log.info(`[Job ${jobId}] Still alive after 5s — sending SIGKILL`);
      killAgentProcess(job, "SIGKILL");
    }

    // Use job._cleanup rather than the internal closure so any wrappers registered
    // after spawn (e.g. stall detection teardown from setupStallDetection) are honored.
    // Awaited so the dispatch row's final token totals land BEFORE the
    // external putStatus PUT — see cleanup() comment for the race fix.
    await (job._cleanup ?? cleanup)();

    if (options.statusUrl && options.apiToken) {
      await putStatus(job, options.apiToken, status, job.summary);
    }
    options.onComplete?.(job);
  };

  // ============================================================================
  // Runtime fork — ONLY the spawn shape differs. Monitoring, heartbeat, stall
  // detection, event forwarding, completion signaling, and cancellation are all
  // identical across docker and host modes (see agent-dispatch.md).
  // ============================================================================
  if (options.openTerminal) {
    try {
      await spawnHostMode({
        job,
        jobId,
        repoName: options.repoName,
        flags,
        firstMessage,
        agentCwd,
        statusUrl: options.statusUrl,
        apiToken: options.apiToken,
        env,
        onExit: () => {
          if (job.status !== "running") return;

          // In host mode the PID died without going through job.stop()
          // (which sets job.status before killing). Two paths land here:
          //   1. The agent produced assistant output then exited — treat as
          //      completed (e.g., user closed the tab after seeing results).
          //   2. The agent produced NO output before dying — treat as failed.
          //      Empty output means either the watcher never attached (bad
          //      cwd / missing dispatch tag) or the claude process crashed at
          //      startup. Reporting "completed" for that case is a silent
          //      fallback — see `.claude/rules/code-quality.md` "fallbacks
          //      are bugs". Fail loud so the caller can retry.
          const finalText = lastAssistantText.trim();
          if (finalText) {
            job.status = "completed";
            job.summary = finalText;
            log.info(`[Job ${jobId}] Host-mode claude exited with output`);
          } else {
            job.status = "failed";
            job.summary =
              "Host-mode claude exited without producing any assistant output — watcher may not have attached or agent crashed at startup";
            log.warn(`[Job ${jobId}] ${job.summary}`);
          }
          job.completedAt = new Date();
          void cleanup();
          notifyTerminalStatus(job, options, job.status, job.summary);
        },
        registerTermDir: (dir) => {
          termSettingsDirToClean = dir;
        },
      });
    } catch (err) {
      // spawnHostMode can fail when the bash script never writes its PID file
      // (wt.exe missing, script crashed, MCP config broken, etc.). If we let
      // the exception escape without running cleanup, the watcher, heartbeat,
      // max-runtime timer, and termSettingsDir all leak. Fail the job loudly
      // so callers see the error, run cleanup so nothing is left dangling.
      log.error(`[Job ${jobId}] Host-mode spawn failed:`, err);
      job.status = "failed";
      job.summary = `Host-mode spawn failed: ${(err as Error).message}`;
      job.completedAt = new Date();
      void cleanup();
      if (options.statusUrl && options.apiToken) {
        await putStatus(job, options.apiToken, "failed", job.summary);
      }
      options.onComplete?.(job);
      throw err;
    }
  } else {
    // stdio: stdin ignore (no interactive input in docker mode), stdout ignore
    // (SessionLogWatcher reads the JSONL session file from disk — stdout is
    // not a monitoring channel), stderr pipe so we can surface failure messages
    // in the job summary when the process exits non-zero.
    const child = spawn("claude", [...flags, "-p", firstMessage], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: agentCwd,
    });

    job.process = child;

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    setupProcessHandlers(
      child,
      job,
      () => lastAssistantText,
      () => stderr,
      {
        onComplete: (j) => {
          if (options.statusUrl && options.apiToken) {
            const status = j.status === "completed" ? "completed" : "failed";
            putStatus(j, options.apiToken!, status, j.summary);
          }
          options.onComplete?.(j);
        },
        cleanup,
      },
    );
  }

  return job;
}

interface SpawnHostModeOptions {
  job: AgentJob;
  jobId: string;
  repoName: string;
  /** Pre-built claude CLI flags (shared with the docker path, byte-identical). */
  flags: string[];
  /** Pre-built first-user-message (shared with the docker path, byte-identical). */
  firstMessage: string;
  agentCwd: string;
  statusUrl?: string;
  apiToken?: string;
  env: Record<string, string>;
  /** Called exactly once when the host claude PID is observed to have exited. */
  onExit: () => void;
  /** Share the temp settings dir with the outer cleanup closure. */
  registerTermDir: (dir: string) => void;
}

/**
 * Host-mode spawn: writes the dispatch bash script, launches it in a Windows
 * Terminal tab via wt.exe, reads the claude PID the script emits, and wires
 * a PID-liveness watcher so the outer lifecycle sees the exit. Does NOT spawn
 * a second headless claude — that would defeat the single-fork invariant (see
 * `.claude/rules/agent-dispatch.md`).
 */
async function spawnHostMode(opts: SpawnHostModeOptions): Promise<void> {
  const {
    job,
    jobId,
    repoName,
    flags,
    firstMessage,
    agentCwd,
    env,
    onExit,
    statusUrl,
    apiToken,
    registerTermDir,
  } = opts;

  // Paired: a statusUrl without an apiToken would bake an empty Bearer token
  // into the bash curl (malformed auth header). Fail loud at the call site
  // instead of pretending to post unauthenticated — per "fallbacks are bugs".
  if (statusUrl && !apiToken) {
    throw new Error(
      `[Job ${jobId}] spawnAgent({openTerminal: true}) requires apiToken when statusUrl is set`,
    );
  }

  const termLogPath = getTerminalLogPath(jobId);
  job.terminalLogPath = termLogPath;

  const termSettingsDir = mkdtempSync(join(tmpdir(), "danxbot-term-"));
  registerTermDir(termSettingsDir);

  const pidFilePath = join(termSettingsDir, "claude.pid");
  // wt.exe's stdout+stderr land here. Read this file when diagnosing a
  // host-mode PID-file timeout — it's the only window into what happened
  // between `spawnInTerminal()` and the bash wrapper writing its PID.
  const wtLogPath = join(termSettingsDir, "wt-stderr.log");

  const scriptPath = buildDispatchScript(termSettingsDir, {
    flags,
    firstMessage,
    jobId,
    statusUrl,
    // apiToken is guaranteed defined if statusUrl is set (guard above). If no
    // statusUrl, the bash `report_status` guard short-circuits on empty URL,
    // so the empty-string default here never reaches curl.
    apiToken: apiToken ?? "",
    terminalLogPath: termLogPath,
    pidFilePath,
  });

  log.info(`[Job ${jobId}] Opening terminal viewer (log: ${termLogPath})`);
  spawnInTerminal({
    title: `danxbot: ${repoName} [${jobId.slice(0, 8)}]`,
    script: scriptPath,
    cwd: agentCwd,
    env: env as Record<string, string | undefined>,
    wtLogPath,
  });

  const pid = await readPidFileWithTimeout(
    pidFilePath,
    HOST_PID_FILE_TIMEOUT_MS,
    HOST_PID_FILE_POLL_MS,
    wtLogPath,
  );
  job.claudePid = pid;
  log.info(`[Job ${jobId}] Host-mode dispatch PID: ${pid}`);

  const hostExitWatcher = createHostExitWatcher(pid, HOST_EXIT_POLL_MS);
  job.hostExitWatcher = hostExitWatcher;
  hostExitWatcher.onExit(onExit);
}

/**
 * Cancel a running job by sending SIGTERM, then SIGKILL after 5 seconds.
 * Works identically in docker (ChildProcess handle) and host (tracked PID) modes.
 *
 * Sets job.status="canceled" BEFORE sending SIGTERM so the close/exit handlers
 * (setupProcessHandlers in docker mode, spawnHostMode.onExit in host mode)
 * see a non-running status and early-return via their `job.status === "running"`
 * guards. Mirrors the pattern in job.stop() — the prior `_canceling` flag
 * only covered the docker path, leaving a host-mode race where onExit
 * overwrote status to "completed"/"failed" during the 5s grace wait.
 */
export async function cancelJob(
  job: AgentJob,
  apiToken: string,
): Promise<void> {
  if (job.status !== "running") return;
  if (!job.process && job.claudePid === undefined) return;

  log.info(`[Job ${job.id}] Cancel requested — sending SIGTERM`);

  job.status = "canceled";
  job.summary = "Agent was canceled by user request";
  job.completedAt = new Date();

  await terminateWithGrace(job, 5_000);

  // Awaited so dispatchTracker.finalize commits the cancelled-state row with
  // any drained JSONL totals BEFORE the external putStatus PUT. Without this
  // the dispatch row is "running" when the PUT lands, then flips to
  // "cancelled" later, racing any reader keying off the PUT.
  await job._cleanup?.();
  await putStatus(job, apiToken, "canceled", job.summary);
  job._onComplete?.();
}

/**
 * Get the status of a job for the API response.
 */
export function getJobStatus(job: AgentJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    summary: job.summary,
    started_at: job.startedAt.toISOString(),
    completed_at: job.completedAt?.toISOString() || null,
    elapsed_seconds: Math.round(
      ((job.completedAt?.getTime() || Date.now()) - job.startedAt.getTime()) /
        1000,
    ),
    input_tokens: job.usage.input_tokens,
    output_tokens: job.usage.output_tokens,
    cache_read_input_tokens: job.usage.cache_read_input_tokens,
    cache_creation_input_tokens: job.usage.cache_creation_input_tokens,
  };
}

