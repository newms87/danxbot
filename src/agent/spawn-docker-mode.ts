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
import { config } from "../config.js";
import { setupProcessHandlers } from "./process-utils.js";
import { createDockerHandle } from "./agent-handle.js";
import { putStatus } from "./agent-status.js";
import { buildSystemdRunArgs } from "./scope.js";
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

  // DX-325: defense-in-depth scope wrap for direct `spawnAgent()`
  // callers on host runtime (tests, future non-TUI host paths). The
  // PRODUCTION host path never reaches here — `dispatch()` defaults
  // `openTerminal: config.isHost`, so on host the launcher routes to
  // `runHostModeFork` → `terminal.ts#buildDispatchScript` (which has
  // its own scope wrap). Docker production reaches this function with
  // `config.isHost === false` and stays naked because the container
  // boundary is already the cgroup. Boot preflight
  // (`systemd-preflight.ts`) has already proven `systemd-run --user
  // --version` runs on host; there is no naked-spawn fallback.
  // See `.claude/rules/agent-dispatch.md` "Single Fork Principle" for
  // the production-vs-test path map.
  const claudeArgs = [...flags, "-p", firstMessage];
  const [bin, args] = config.isHost
    ? [
        "systemd-run",
        buildSystemdRunArgs({
          dispatchId: job.id,
          claudePath: "claude",
          claudeArgs,
        }),
      ]
    : ["claude", claudeArgs];

  const child = spawn(bin, args, {
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
