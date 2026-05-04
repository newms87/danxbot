/**
 * Host-mode spawn — the interactive Windows Terminal path.
 *
 * Writes the dispatch bash script, launches it in a Windows Terminal tab
 * via wt.exe, reads the claude PID the script emits, and wires a
 * PID-liveness watcher so the outer launcher lifecycle sees the exit.
 *
 * Does NOT spawn a second headless claude — that would defeat the
 * single-fork invariant (see `.claude/rules/agent-dispatch.md` and
 * `.claude/rules/host-mode-interactive.md`).
 *
 * The function only owns the spawn shape. Monitoring (SessionLogWatcher),
 * stall detection, heartbeat, and event forwarding are wired by
 * `spawnAgent` in `launcher.ts` BEFORE this function runs and live
 * unchanged across the runtime fork. This module exposes the runtime
 * branch as a small, focused unit so the launcher's `openTerminal` call
 * site stays a one-liner.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import {
  buildDispatchScript,
  getTerminalLogPath,
  spawnInTerminal,
} from "../terminal.js";
import { createHostHandle } from "./agent-handle.js";
import { createHostExitWatcher, readPidFileWithTimeout } from "./host-pid.js";
import { putStatus, notifyTerminalStatus } from "./agent-status.js";
import type { AgentJob, SpawnAgentOptions } from "./agent-types.js";

const log = createLogger("spawn-host-mode");

/** How long to wait for the host-mode bash script to write its PID file. */
const HOST_PID_FILE_TIMEOUT_MS = 2_000;
/** Polling cadence while waiting for the host-mode PID file to appear. */
const HOST_PID_FILE_POLL_MS = 50;
/** Polling cadence for the host-mode liveness check (SIGNAL 0 on the PID). */
const HOST_EXIT_POLL_MS = 500;

export interface SpawnHostModeOptions {
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

export async function spawnHostMode(
  opts: SpawnHostModeOptions,
): Promise<void> {
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
  log.info(`[Job ${jobId}] Host-mode dispatch PID: ${pid}`);

  const hostExitWatcher = createHostExitWatcher(pid, HOST_EXIT_POLL_MS);
  job.handle = createHostHandle(pid, hostExitWatcher);
  job.handle.onExit(onExit);
}

export interface RunHostModeForkOptions {
  job: AgentJob;
  jobId: string;
  options: SpawnAgentOptions;
  flags: string[];
  firstMessage: string;
  agentCwd: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
  /** Returns the most recent assistant text — used to classify the host exit. */
  getLastAssistantText: () => string;
  /** Share the temp settings dir with the outer cleanup closure. */
  registerTermDir: (dir: string) => void;
}

/**
 * Wraps `spawnHostMode` with the launcher-side wiring that's specific to the
 * host runtime branch:
 *   - the `onExit` closure (drains the watcher, classifies the exit as
 *     completed-with-output vs failed-empty, fires cleanup + terminal status)
 *   - the outer try/catch that fails the job loudly and runs cleanup if the
 *     bash script never wrote its PID file (wt.exe missing, MCP broken, etc.)
 *
 * Lives next to `spawnHostMode` (rather than inline in `launcher.ts`) so the
 * launcher's runtime-fork branch stays a single call. Mirrors what
 * `spawnDockerMode` already does for the docker branch.
 */
export async function runHostModeFork(
  opts: RunHostModeForkOptions,
): Promise<void> {
  const {
    job,
    jobId,
    options,
    flags,
    firstMessage,
    agentCwd,
    env,
    cleanup,
    getLastAssistantText,
    registerTermDir,
  } = opts;

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
      onExit: async () => {
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
        //
        // Same race + fix shape as the docker close handler in
        // `setupProcessHandlers` (process-utils.ts). drain() before
        // classifying so a final-turn-after-last-poll lands in
        // lastAssistantText; catch + log so a rejecting drain doesn't
        // strand the host job mid-transition.
        try {
          await job.watcher?.drain();
        } catch (err) {
          log.error(
            `[Job ${jobId}] watcher.drain() failed during host onExit — falling back to last observed assistant text`,
            err,
          );
        }

        const finalText = getLastAssistantText().trim();
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
      registerTermDir,
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
}
