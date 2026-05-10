/**
 * Reattach handle — `AgentHandle` wrapping an existing OS PID for the
 * Phase 2c (DX-209) DB-driven reattach pass.
 *
 * Sibling to `src/agent/agent-handle.ts`'s `createDockerHandle` /
 * `createHostHandle` factories. Lives under `src/worker/` because it is
 * called only from the worker boot reattach pass — the launcher's spawn
 * paths never use it.
 *
 * Lifecycle:
 *   - Construction does NOT verify the PID is alive. Callers may pass
 *     a freshly-stale PID (the host died between probe and reattach);
 *     downstream `isAlive()` will return false and the cleanup chain
 *     fires `onExit` immediately on the next watcher tick.
 *   - The shim creates its own `HostExitWatcher` and owns its lifetime.
 *     `dispose()` stops the watcher; idempotent (the watcher's own
 *     `stop()` tolerates duplicate calls).
 *   - `kill` is ESRCH-tolerant via `killHostPid` — the same semantics
 *     `createHostHandle` provides for host-mode dispatches that race
 *     their own `danxbot_complete` exit.
 *
 * Why a sibling and not just `createHostHandle(pid, watcher)`: the
 * caller would have to construct the watcher itself and wire its
 * stop() into the dispose contract. The reattach pass would replicate
 * that boilerplate for every alive row. Centralizing it here lets the
 * pass call `createReattachHandle(pid)` and forget about the watcher.
 */

import {
  createHostExitWatcher,
  isPidAlive,
  killHostPid,
} from "../agent/host-pid.js";
import type { AgentHandle } from "../agent/agent-handle.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface CreateReattachHandleOptions {
  /** How often to poll the PID for liveness. Defaults to 1000ms. */
  pollIntervalMs?: number;
}

/**
 * Build an `AgentHandle` that wraps an already-running OS PID. The
 * returned handle is shape-compatible with both `createDockerHandle`
 * and `createHostHandle`, so the rest of the lifecycle stack
 * (`attachMonitoringStack`, `cancelJob`, `terminateWithGrace`,
 * `agent-stop`, `agent-cleanup`) treats it identically to a freshly-
 * spawned dispatch.
 */
export function createReattachHandle(
  pid: number,
  opts: CreateReattachHandleOptions = {},
): AgentHandle {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const watcher = createHostExitWatcher(pid, pollIntervalMs);

  return {
    pid,
    kill(signal) {
      killHostPid(pid, signal);
    },
    isAlive() {
      return isPidAlive(pid);
    },
    onExit(cb) {
      watcher.onExit(cb);
    },
    dispose() {
      watcher.stop();
    },
  };
}
