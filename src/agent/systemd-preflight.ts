/**
 * Worker-boot preflight for the systemd user-scope dispatch wrapper
 * (DX-325 / DX-323).
 *
 * Every host-mode dispatch runs inside a transient `--user --scope` unit
 * (see `src/agent/scope.ts`). If systemd-run is unavailable or the user
 * instance is offline, every dispatch would fail at spawn time — but
 * the failure would surface as a confusing "execvp: systemd-run: No
 * such file or directory" deep inside the launcher, with `claude` never
 * starting, the watcher never attaching, and the operator chasing
 * stall-detector tuning instead of the real cause.
 *
 * This preflight runs ONCE at worker boot (in host runtime mode only —
 * docker workers are already cgroup-confined by the container boundary,
 * see `.claude/rules/agent-dispatch.md` "Anti-goals") and fails loud
 * if either probe fails. The runtime invariant is "every dispatch is
 * scoped or the worker doesn't run" — no fallback path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SystemdPreflightFailureReason =
  | "systemctl-missing"
  | "no-user-instance"
  | "systemd-run-missing"
  | "systemd-run-broken";

export type SystemdPreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: SystemdPreflightFailureReason;
      summary: string;
    };

export interface ProbeResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  code?: number;
  /** `err.code` from Node's execFile callback (e.g. `"ENOENT"`). */
  errnoCode?: string;
}

export interface PreflightOptions {
  /**
   * Probe runner — runs `argv[0]` with `argv[1..]` and returns the
   * captured result. Default uses `execFile`. Tests inject a stub so
   * each branch can be asserted without actually calling out to
   * systemd.
   */
  runProbe?: (argv: string[]) => Promise<ProbeResult>;
}

/**
 * Verify the dispatcher's systemd dependency at worker boot.
 *
 * Two sequential probes:
 *   1. `systemctl --user is-system-running` — proves the user systemd
 *      instance is up. Output `running` is success; `degraded` is also
 *      accepted (some unrelated unit failed; we can still create
 *      scopes). Anything else (`offline`, `stopping`, `starting`,
 *      `unknown`) fails the preflight with `no-user-instance`.
 *   2. `systemd-run --user --version` — proves the binary itself is
 *      installed and can talk to the user bus. ENOENT → the binary is
 *      absent (`systemd-run-missing`); non-zero exit → the binary
 *      runs but cannot complete a version probe (e.g. dbus race;
 *      `systemd-run-broken`).
 *
 * Returns `{ok: true}` on success; otherwise a result with a specific
 * `reason` and an operator-readable `summary` pointing at the fix.
 *
 * The function never throws on probe failure — callers decide whether
 * to wrap in `SystemdPreflightError` for `throw` semantics or branch
 * on the result.
 */
export async function preflightSystemdRun(
  opts: PreflightOptions = {},
): Promise<SystemdPreflightResult> {
  const runProbe = opts.runProbe ?? defaultRunProbe;

  const userInstance = await runProbe([
    "systemctl",
    "--user",
    "is-system-running",
  ]);
  // systemctl returns exit 1 for `degraded` even though the user
  // instance IS running. Treat `running` and `degraded` as success —
  // operator fixes for unrelated unit failures should not block the
  // dispatcher from booting.
  if (userInstance.ok || isDegradedAcceptable(userInstance.stdout)) {
    // proceed to second probe
  } else if (userInstance.errnoCode === "ENOENT") {
    return {
      ok: false,
      reason: "systemctl-missing",
      summary:
        "systemctl is not on PATH — every dispatched agent runs inside a `systemd-run --user --scope` unit (DX-323), so a missing systemctl means the dispatcher has no way to verify the user instance is up. Install systemd, or run the worker inside a docker container (which the cgroup-boundary path handles separately).",
    };
  } else {
    const state = userInstance.stdout?.trim() || "unknown";
    return {
      ok: false,
      reason: "no-user-instance",
      summary: `systemctl --user is-system-running reported '${state}' — the user systemd instance is not running, so the dispatcher cannot register per-dispatch scopes. Run \`loginctl enable-linger <user>\` so the user instance survives logout, then restart the worker. (DX-323 requires every dispatch to be scope-confined; there is no naked-spawn fallback.)`,
    };
  }

  const versionProbe = await runProbe([
    "systemd-run",
    "--user",
    "--version",
  ]);
  if (versionProbe.ok) {
    return { ok: true };
  }
  if (versionProbe.errnoCode === "ENOENT") {
    return {
      ok: false,
      reason: "systemd-run-missing",
      summary:
        "systemd-run --user --version did not run — the systemd-run binary is not on PATH. Install systemd (which ships systemd-run as part of its core) and restart the worker. The dispatcher has no fallback path; per DX-323 every dispatch must run inside a scope unit.",
    };
  }
  const stderr = (versionProbe.stderr || "").trim();
  return {
    ok: false,
    reason: "systemd-run-broken",
    summary: `systemd-run --user --version exited code=${versionProbe.code ?? "?"} stderr=${stderr || "<empty>"} — the binary is installed but cannot complete a version probe. Common causes: user dbus socket missing, XDG_RUNTIME_DIR unset for this user, lingering disabled. Restart the user systemd instance and retry.`,
  };
}

function isDegradedAcceptable(stdout: string | undefined): boolean {
  // systemctl `is-system-running` outputs the state on stdout AND exits
  // non-zero for `degraded`. The state-on-stdout is the signal we trust.
  return (stdout ?? "").trim() === "degraded";
}

async function defaultRunProbe(argv: string[]): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1));
    return { ok: true, stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    // Node's execFile rejects with the underlying error code on
    // ENOENT/EACCES, and with a numeric exit code on non-zero
    // termination. Disambiguate by string vs number.
    const numericCode =
      typeof e.code === "number" ? e.code : Number(e.code) || -1;
    const errnoCode = typeof e.code === "string" ? e.code : undefined;
    return {
      ok: false,
      stdout: e.stdout,
      stderr: e.stderr,
      code: numericCode,
      errnoCode,
    };
  }
}

/**
 * Throw-shaped wrapper. Use at the call site that wants to fail-fast
 * (worker boot in `src/index.ts`); preserve the typed `reason` for
 * structured logging.
 */
export class SystemdPreflightError extends Error {
  readonly reason: SystemdPreflightFailureReason;
  constructor(result: Extract<SystemdPreflightResult, { ok: false }>) {
    super(result.summary);
    this.name = "SystemdPreflightError";
    this.reason = result.reason;
  }
}
