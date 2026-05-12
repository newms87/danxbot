/**
 * Lifecycle stop primitive for a dispatched agent's process tree
 * (DX-326 / DX-323). Single entry point for every terminal stop —
 * agent self-stop (`job.stop`), user `cancelJob`, future lifecycle
 * hooks all route through here. Branches once on `scopeName`:
 *
 * - **Host runtime** (scopeName set): `systemctl --user stop
 *   <scope>.scope` — systemd walks the cgroup and SIGTERMs every PID
 *   atomically (with TimeoutStopSec SIGKILL escalation). Backgrounded
 *   grandchildren (`yes &`, double-forks, daemons the Bash tool
 *   spawned) inherit the cgroup, so they die with the parent instead
 *   of reparenting to PID 1 — the DX-262 orphan class.
 *
 * - **Docker runtime** (scopeName unset): SIGTERM + grace + SIGKILL on
 *   the tracked PID via `terminateWithGrace`. Container PID namespace
 *   IS the cgroup; no scope wrap exists in docker mode (DX-325
 *   anti-goal).
 *
 * **No fallback to `kill(pid)` after a systemctl error.** Boot
 * preflight asserts `systemd-run --user` works before the worker
 * accepts dispatches; signaling individual PIDs after a stop-time
 * failure would re-introduce the orphan-grandchildren bug. Exit 5
 * ("unit not found") = scope already collected via `--collect` =
 * idempotent success.
 */

import { spawn } from "node:child_process";
import { createLogger } from "../logger.js";
import { terminateWithGrace } from "./agent-types.js";
import type { AgentJob } from "./agent-types.js";

const log = createLogger("job-stop");

/** Docker-runtime SIGTERM → SIGKILL window. Host path ignores this — systemd's TimeoutStopSec owns escalation. */
const DOCKER_GRACE_MS = 5_000;

export interface StopAgentTreeOptions {
  job: AgentJob;
  /** `danxbot-dispatch-<id>` on host runtime, undefined on docker. Stamped by `spawn-preflight.ts`. */
  scopeName?: string;
}

export async function stopAgentTree(
  opts: StopAgentTreeOptions,
): Promise<void> {
  const { job, scopeName } = opts;
  if (scopeName) {
    await stopViaScope(job, scopeName);
    return;
  }
  await terminateWithGrace(job, DOCKER_GRACE_MS);
}

function stopViaScope(job: AgentJob, scopeName: string): Promise<void> {
  const unit = `${scopeName}.scope`;
  log.info(`[Job ${job.id}] systemctl --user stop ${unit}`);
  return new Promise<void>((resolve) => {
    const child = spawn("systemctl", ["--user", "stop", unit], {
      stdio: "ignore",
    });
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", (code: number | null) => {
      if (code === 0) {
        log.info(`[Job ${job.id}] scope stopped cleanly: ${unit}`);
      } else if (code === 5) {
        // systemctl exit 5 = unit not found. With --collect on the
        // scope wrap, an already-stopped unit IS the success case.
        log.info(`[Job ${job.id}] scope already gone: ${unit}`);
      } else {
        // Falling back to kill(pid) here would only reap the script
        // wrapper and re-orphan backgrounded children, defeating the
        // scope wrap. Log loud and let cleanup run.
        log.warn(
          `[Job ${job.id}] systemctl --user stop ${unit} exited with code ${code}`,
        );
      }
      settle();
    });
    child.once("error", (err: Error) => {
      log.error(`[Job ${job.id}] systemctl spawn failed for ${unit}`, err);
      settle();
    });
  });
}
