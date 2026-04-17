/**
 * Host-mode process tracking.
 *
 * In host runtime, the claude process runs inside a Windows Terminal tab
 * launched via wt.exe. The tab is detached from our node process so we
 * cannot observe it through a ChildProcess handle. Instead, the dispatch
 * bash script writes its own PID to a file; the launcher reads that PID
 * here and uses POSIX signals + liveness polling to track the process.
 *
 * See `.claude/rules/agent-dispatch.md` for why single-PID tracking is the
 * required host-mode mechanism (the alternative would re-introduce a second
 * claude spawn, which Phase 2 deliberately collapsed).
 */

import { readFileSync, existsSync } from "node:fs";
import { createLogger } from "../logger.js";

const log = createLogger("host-pid");

/**
 * Poll a PID file until it exists and contains a valid numeric PID, or
 * the timeout expires. Returns the parsed PID on success; throws on timeout
 * or malformed contents — a missing PID means the bash script never launched
 * and the dispatch is unrecoverable.
 */
export async function readPidFileWithTimeout(
  pidFilePath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(pidFilePath)) {
      const raw = readFileSync(pidFilePath, "utf-8").trim();
      if (raw.length > 0) {
        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0) {
          throw new Error(
            `Invalid PID file contents at ${pidFilePath}: "${raw}"`,
          );
        }
        return pid;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for PID file: ${pidFilePath}`,
  );
}

/**
 * Returns true if the kernel reports the PID as existing. Uses signal 0, the
 * POSIX idiom for a liveness check: no signal is delivered, but the kernel
 * performs target lookup and permission checks.
 *
 * Error mapping:
 *   - ESRCH  → process is gone (return false)
 *   - EPERM  → process exists but we lack permission to signal it (return true,
 *              because the PID is still live — the caller's concern is
 *              "is there something at that PID?", not "can we kill it?")
 *   - other  → propagate via the caller — this function treats them as dead
 *              to keep liveness polling simple; unusual errors should have
 *              already surfaced via killHostPid.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export interface HostExitWatcher {
  /** Register a callback fired exactly once when the PID goes away. */
  onExit(cb: () => void): void;
  /** Stop polling and drop all callbacks. Idempotent. */
  stop(): void;
}

/**
 * Watch a PID for exit by polling `process.kill(pid, 0)`. Fires onExit
 * exactly once when the PID is no longer alive, then stops polling.
 */
export function createHostExitWatcher(
  pid: number,
  pollIntervalMs: number,
): HostExitWatcher {
  const callbacks: Array<() => void> = [];
  let fired = false;
  let handle: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    if (fired) return;
    if (!isPidAlive(pid)) {
      fired = true;
      if (handle) {
        clearInterval(handle);
        handle = undefined;
      }
      for (const cb of callbacks) {
        try {
          cb();
        } catch (err) {
          log.error(`Host exit callback for pid ${pid} threw:`, err);
        }
      }
      callbacks.length = 0;
    }
  }, pollIntervalMs);

  return {
    onExit(cb: () => void): void {
      if (fired) {
        cb();
        return;
      }
      callbacks.push(cb);
    },
    stop(): void {
      if (handle) {
        clearInterval(handle);
        handle = undefined;
      }
      callbacks.length = 0;
    },
  };
}

/**
 * Send a signal to a host-mode claude by PID. Swallows ESRCH (process already
 * exited) — that's the expected race between our kill and the process dying
 * on its own (e.g., danxbot_complete).
 */
export function killHostPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    throw err;
  }
}
