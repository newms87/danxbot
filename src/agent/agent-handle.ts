/**
 * Runtime handle abstraction for a dispatched claude process.
 *
 * Every dispatch spawns ONE claude process. Docker mode owns it as a
 * ChildProcess; host mode tracks it by PID inside a Windows Terminal tab
 * (see `.claude/rules/agent-dispatch.md`, "Single Fork Principle").
 * Before this module the rest of the launcher branched on
 * `if (job.process) ... else if (job.claudePid) ...` at every lifecycle
 * site (kill, isAlive, onExit, cleanup, cancelJob preflight). Every new
 * feature that needed to reach the process repeated the branching.
 *
 * `AgentHandle` collapses that — the runtime branches at fork time inside
 * `spawnAgent` (creating a `DockerHandle` or `HostHandle`), and every
 * downstream caller works through this one interface.
 *
 * Invariant: instances do NOT own the watcher or child they wrap. They
 * only delegate. `dispose()` releases per-runtime resources we created
 * ourselves (the host liveness-poll interval) and is idempotent + safe
 * after exit.
 */

import type { ChildProcess } from "node:child_process";
import { isPidAlive, killHostPid, type HostExitWatcher } from "./host-pid.js";

export interface AgentHandle {
  /**
   * OS PID of the spawned claude process. Set at fork time and never
   * mutated. Docker mode = `child.pid`; host mode = the `script -q -f`
   * wrapper PID (its direct child is claude). Consumers stamp this onto
   * the per-issue YAML's `dispatch.pid` for cross-restart liveness checks
   * (ISS-92, Phase 2 of the poller-triage rework).
   *
   * Docker's `child.pid` is `number | undefined` per Node's typings —
   * undefined only for spawn failures (which throw before we wrap the
   * handle), so we coerce to `number` here and fail-loud at the spawn
   * site if the wrap is ever attempted on a child that never started.
   */
  readonly pid: number;
  /** Send a POSIX signal. Safe to call after exit (per-runtime ESRCH handling). */
  kill(signal: NodeJS.Signals): void;
  /** True iff the process is still running. */
  isAlive(): boolean;
  /** Register a callback fired exactly once when the process exits. */
  onExit(cb: () => void): void;
  /**
   * Tear down per-runtime resources (e.g. the host liveness-poll interval).
   * Docker handles have nothing to release — Node owns the ChildProcess
   * lifecycle. Idempotent. Safe to call after exit.
   */
  dispose(): void;
}

/**
 * Wrap a docker-runtime ChildProcess.
 *
 * `kill` and `isAlive` are property lookups at call time, so tests that
 * replace `child.kill` after construction still observe the new mock.
 */
export function createDockerHandle(child: ChildProcess): AgentHandle {
  // Spawn-failure paths throw inside `child_process.spawn` before this
  // wrapper is constructed, so a missing `pid` here would mean the
  // contract was breached upstream. Fail loud — propagating an undefined
  // pid through `AgentHandle.pid` would corrupt the YAML stamp.
  //
  // `0` is rejected even though it's `typeof number`: POSIX uses pid 0
  // for "the current process group" in `kill(2)`, so propagating it
  // would broadcast every kill to ourselves and falsely report alive on
  // every liveness probe. Same fail-loud reasoning as `undefined`.
  if (typeof child.pid !== "number" || child.pid <= 0) {
    throw new Error(
      `createDockerHandle: ChildProcess has invalid pid (${String(child.pid)}) — spawn must have failed`,
    );
  }
  const pid = child.pid;
  return {
    pid,
    kill(signal) {
      child.kill(signal);
    },
    isAlive() {
      // Per Node docs, exitCode is null while the process is still running.
      // `.killed` flips true the moment a signal dispatches even if the
      // process hasn't exited, so it's intentionally NOT consulted here.
      return child.exitCode == null;
    },
    onExit(cb) {
      // Use once-semantics to match the existing job.stop wiring — close can
      // fire multiple times during teardown.
      child.once("close", () => cb());
    },
    dispose() {
      // No-op: Node closes the ChildProcess on exit; we don't own anything.
    },
  };
}

/**
 * Wrap a host-runtime PID + its liveness-poll watcher.
 *
 * The `pid` is the `script -q -f` wrapper PID — its direct child is
 * claude, and SIGTERM cascades through the pty so the terminal tab
 * closes on exit (see `src/terminal.ts`).
 */
export function createHostHandle(
  pid: number,
  watcher: HostExitWatcher,
): AgentHandle {
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
