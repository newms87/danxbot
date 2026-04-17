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
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { getReposBase } from "../poller/constants.js";
import {
  buildCleanEnv,
  logPromptToDisk,
  createInactivityTimer,
  setupProcessHandlers,
} from "./process-utils.js";
import {
  SessionLogWatcher,
  DISPATCH_TAG_PREFIX,
} from "./session-log-watcher.js";
import { createLaravelForwarder } from "./laravel-forwarder.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the danxbot MCP server script (src/mcp/danxbot-server.ts). */
const DANXBOT_MCP_SERVER_PATH = resolve(__dirname, "../mcp/danxbot-server.ts");

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
   * Path where `script -q -f` writes terminal output when openTerminal is true.
   * Used by TerminalOutputWatcher + StallDetector for thinking indicator detection.
   */
  terminalLogPath?: string;
  /** Internal cleanup callback — tears down watcher, forwarder, timers. Set by spawnAgent. */
  _cleanup?: () => void;
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
   */
  stop?: (status: "completed" | "failed", summary?: string) => Promise<void>;
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
  /** Repo name — used to resolve cwd to repos/<name> */
  repoName: string;
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
  /** Agent definitions forwarded as --agents JSON to Claude CLI */
  agents?: Array<Record<string, unknown>>;
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
}

export interface McpSettingsOptions {
  apiToken: string;
  apiUrl: string;
  schemaDefinitionId?: string;
  schemaRole?: string;
  /**
   * When set, adds the danxbot MCP server to the settings, providing the
   * danxbot_complete tool. The value is the full stop URL that the tool will POST to
   * (e.g., "http://localhost:5560/api/stop/:jobId").
   */
  danxbotStopUrl?: string;
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
 * Build the MCP settings JSON for a dispatch agent session.
 * Creates a temporary directory with settings.json that configures
 * the Schema MCP server and optionally the danxbot lifecycle tools.
 * Returns the temp directory path (caller must clean it up).
 */
export function buildMcpSettings(options: McpSettingsOptions): string {
  const tempDir = mkdtempSync(join(tmpdir(), "danxbot-mcp-"));

  const mcpServers: Record<string, unknown> = {
    schema: {
      command: "npx",
      args: ["@thehammer/schema-mcp-server"],
      env: {
        SCHEMA_API_URL: options.apiUrl,
        SCHEMA_API_TOKEN: options.apiToken,
        ...(options.schemaDefinitionId
          ? { SCHEMA_DEFINITION_ID: String(options.schemaDefinitionId) }
          : {}),
        ...(options.schemaRole ? { SCHEMA_ROLE: options.schemaRole } : {}),
      },
    },
  };

  if (options.danxbotStopUrl) {
    mcpServers["danxbot"] = {
      command: "npx",
      args: ["tsx", DANXBOT_MCP_SERVER_PATH],
      env: {
        DANXBOT_STOP_URL: options.danxbotStopUrl,
      },
    };
  }

  const settingsPath = join(tempDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ mcpServers }, null, 2));

  return tempDir;
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
export async function spawnAgent(options: SpawnAgentOptions): Promise<AgentJob> {
  const jobId = options.jobId ?? randomUUID();

  const job: AgentJob = {
    id: jobId,
    status: "running",
    summary: "",
    startedAt: new Date(),
    statusUrl: options.statusUrl,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  const env = buildCleanEnv(options.env);

  // Prepend dispatch tag so SessionLogWatcher finds the right JSONL file
  const taggedPrompt = `${DISPATCH_TAG_PREFIX}${jobId} -->\n\n${options.prompt}`;

  const args = [
    "--dangerously-skip-permissions",
    "--verbose",
  ];

  if (options.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  if (options.agents && options.agents.length > 0) {
    args.push("--agents", JSON.stringify(options.agents));
  }

  args.push("-p", taggedPrompt);

  const agentCwd = join(getReposBase(), options.repoName);

  log.info(`[Job ${jobId}] Launching agent`);
  log.info(`[Job ${jobId}] Prompt: ${options.prompt.substring(0, 200)}`);

  logPromptToDisk(config.logsDir, jobId, taggedPrompt, options.agents);

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
        job.usage.input_tokens += usage.input_tokens ?? 0;
        job.usage.output_tokens += usage.output_tokens ?? 0;
        job.usage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
        job.usage.cache_creation_input_tokens +=
          usage.cache_creation_input_tokens ?? 0;
      }
    }
  });

  // --- Optional event forwarding ---
  let forwarderFlush: (() => void) | undefined;
  if (options.eventForwarding) {
    const forwarder = createLaravelForwarder(
      options.eventForwarding.statusUrl,
      options.eventForwarding.apiToken,
    );
    watcher.onEntry(forwarder.consume);
    forwarderFlush = forwarder.flush;
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
      cleanup();
      options.onComplete?.(j);
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
        cleanup();
        options.onComplete?.(job);
      }
    }, options.maxRuntimeMs);
  }

  function cleanup(): void {
    watcher.stop();
    forwarderFlush?.();
    inactivityTimer.clear();
    stopHeartbeat(job);
    if (maxRuntimeHandle) clearTimeout(maxRuntimeHandle);
    if (job.hostExitWatcher) {
      job.hostExitWatcher.stop();
    }
    if (termSettingsDirToClean) {
      try {
        rmSync(termSettingsDirToClean, { recursive: true, force: true });
      } catch {
        // ENOENT acceptable — the dir may never have been created if
        // `spawnHostMode` failed before mkdtempSync. force:true already
        // handles missing paths, so any error here is nonfatal.
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
    (job._cleanup ?? cleanup)();

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
        taggedPrompt,
        agentCwd,
        mcpConfigPath: options.mcpConfigPath,
        agents: options.agents,
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
          cleanup();
          if (options.statusUrl && options.apiToken) {
            putStatus(job, options.apiToken, job.status, job.summary);
          }
          options.onComplete?.(job);
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
      cleanup();
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
    const child = spawn("claude", args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      cwd: agentCwd,
    });

    job.process = child;

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    setupProcessHandlers(child, job, () => lastAssistantText, () => stderr, {
      onComplete: (j) => {
        if (options.statusUrl && options.apiToken) {
          const status = j.status === "completed" ? "completed" : "failed";
          putStatus(j, options.apiToken!, status, j.summary);
        }
        options.onComplete?.(j);
      },
      cleanup,
    });
  }

  return job;
}

interface SpawnHostModeOptions {
  job: AgentJob;
  jobId: string;
  repoName: string;
  taggedPrompt: string;
  agentCwd: string;
  mcpConfigPath?: string;
  agents?: Array<Record<string, unknown>>;
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
  const { job, jobId, repoName, taggedPrompt, agentCwd, env, onExit } = opts;

  // Paired: a statusUrl without an apiToken would bake an empty Bearer token
  // into the bash curl (malformed auth header). Fail loud at the call site
  // instead of pretending to post unauthenticated — per "fallbacks are bugs".
  if (opts.statusUrl && !opts.apiToken) {
    throw new Error(
      `[Job ${jobId}] spawnAgent({openTerminal: true}) requires apiToken when statusUrl is set`,
    );
  }

  const termLogPath = getTerminalLogPath(jobId);
  job.terminalLogPath = termLogPath;

  const termSettingsDir = mkdtempSync(join(tmpdir(), "danxbot-term-"));
  opts.registerTermDir(termSettingsDir);

  const pidFilePath = join(termSettingsDir, "claude.pid");

  const scriptPath = buildDispatchScript(termSettingsDir, {
    prompt: taggedPrompt,
    jobId,
    mcpConfigPath: opts.mcpConfigPath,
    agentsJson:
      opts.agents && opts.agents.length > 0
        ? JSON.stringify(opts.agents)
        : undefined,
    statusUrl: opts.statusUrl,
    // apiToken is guaranteed defined if statusUrl is set (guard above). If no
    // statusUrl, the bash `report_status` guard short-circuits on empty URL,
    // so the empty-string default here never reaches curl.
    apiToken: opts.apiToken ?? "",
    terminalLogPath: termLogPath,
    pidFilePath,
  });

  log.info(`[Job ${jobId}] Opening terminal viewer (log: ${termLogPath})`);
  spawnInTerminal({
    title: `danxbot: ${repoName} [${jobId.slice(0, 8)}]`,
    script: scriptPath,
    cwd: agentCwd,
    env: env as Record<string, string | undefined>,
  });

  const pid = await readPidFileWithTimeout(
    pidFilePath,
    HOST_PID_FILE_TIMEOUT_MS,
    HOST_PID_FILE_POLL_MS,
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

  job._cleanup?.();
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

/**
 * Clean up a temp directory created by buildMcpSettings.
 */
export function cleanupMcpSettings(settingsDir: string): void {
  try {
    rmSync(settingsDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
