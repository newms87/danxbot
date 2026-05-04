/**
 * Docker-mode spawn — the headless path.
 *
 * One claude child process per dispatch. stdin/stdout are intentionally
 * ignored (`SessionLogWatcher` reads the native JSONL session file from
 * disk — stdout is NOT a monitoring channel; see
 * `.claude/rules/agent-dispatch.md`'s "Forbidden Patterns"). Only stderr
 * is piped so we can surface failure messages in the job summary when
 * the process exits non-zero.
 *
 * Wired AFTER all observers (watcher subscriber, cleanup closure,
 * heartbeat, dispatch tracking) by `spawnAgent` in `launcher.ts`. Returns
 * nothing — `setupProcessHandlers` in `process-utils.ts` owns the close
 * handler that drives the terminal-state transition.
 */

import { spawn } from "node:child_process";
import { setupProcessHandlers } from "./process-utils.js";
import { createDockerHandle } from "./agent-handle.js";
import { putStatus } from "./agent-status.js";
import type { AgentJob } from "./agent-types.js";

export interface SpawnDockerModeOptions {
  job: AgentJob;
  /** Pre-built claude CLI flags (shared with the host path, byte-identical). */
  flags: string[];
  /** Pre-built first-user-message (shared with the host path, byte-identical). */
  firstMessage: string;
  agentCwd: string;
  env: Record<string, string>;
  /** Returns the most recent assistant text block — read at close time for the summary. */
  getLastAssistantText: () => string;
  cleanup: () => Promise<void>;
  statusUrl?: string;
  apiToken?: string;
  onComplete?: (job: AgentJob) => void;
}

export function spawnDockerMode(opts: SpawnDockerModeOptions): void {
  const {
    job,
    flags,
    firstMessage,
    agentCwd,
    env,
    getLastAssistantText,
    cleanup,
    statusUrl,
    apiToken,
    onComplete,
  } = opts;

  const child = spawn("claude", [...flags, "-p", firstMessage], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    cwd: agentCwd,
  });

  job.handle = createDockerHandle(child);

  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  setupProcessHandlers(
    child,
    job,
    getLastAssistantText,
    () => stderr,
    {
      onComplete: (j) => {
        if (statusUrl && apiToken) {
          const status = j.status === "completed" ? "completed" : "failed";
          putStatus(j, apiToken, status, j.summary);
        }
        onComplete?.(j);
      },
      cleanup,
    },
  );
}
