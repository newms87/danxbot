import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  preflightSystemdRun,
  SystemdPreflightError,
} from "./systemd-preflight.js";

// `execFile` is awkward to spy on directly because it's a callback-style
// API. The preflight wraps it in a thin `runProbe(argv): {ok, stdout,
// stderr, code, errnoCode}` helper that the tests stub via the optional
// `runProbe` injection point. Production callers omit the parameter and
// the real implementation runs.
function makeStubRunner(
  responses: Record<
    string,
    { ok: boolean; stdout?: string; stderr?: string; code?: number; errnoCode?: string }
  >,
) {
  return vi.fn(async ([cmd, ...args]: string[]) => {
    const key = [cmd, ...args].join(" ");
    if (!(key in responses)) {
      throw new Error(`Test runner missing stub for: ${key}`);
    }
    return responses[key];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preflightSystemdRun", () => {
  describe("happy path", () => {
    it("returns {ok: true} when both probes succeed", async () => {
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: true,
          stdout: "running\n",
          code: 0,
        },
        "systemd-run --user --version": {
          ok: true,
          stdout: "systemd 255 (255.4-1ubuntu8.14)\n",
          code: 0,
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result).toEqual({ ok: true });
      expect(runProbe).toHaveBeenCalledTimes(2);
    });

    it("accepts is-system-running output of `degraded` (non-fatal — some units failed but the user instance is up)", async () => {
      // systemctl returns exit 1 for "degraded" but the user instance IS
      // running and we can still create scopes. Accept the degraded
      // state — refusing to boot would punish operators for an
      // unrelated stale-unit failure.
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: false,
          stdout: "degraded\n",
          code: 1,
        },
        "systemd-run --user --version": {
          ok: true,
          stdout: "systemd 255\n",
          code: 0,
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result).toEqual({ ok: true });
    });
  });

  describe("systemctl --user is-system-running fails", () => {
    it("returns {ok: false, reason: 'no-user-instance'} when systemctl reports `offline`", async () => {
      // `offline` = no user instance ever started. `loginctl enable-linger`
      // for the danxbot user is the operator's fix.
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: false,
          stdout: "offline\n",
          code: 1,
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.reason).toBe("no-user-instance");
      expect(result.summary).toMatch(/systemctl --user is-system-running/);
      expect(result.summary).toMatch(/offline/);
      expect(result.summary).toMatch(/loginctl enable-linger/);
    });

    it("returns {ok: false, reason: 'systemctl-missing'} when systemctl itself is not on PATH (ENOENT)", async () => {
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: false,
          code: -1,
          errnoCode: "ENOENT",
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.reason).toBe("systemctl-missing");
      expect(result.summary).toMatch(/systemctl/);
    });
  });

  describe("systemd-run --user --version fails", () => {
    it("returns {ok: false, reason: 'systemd-run-missing'} when binary not on PATH", async () => {
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: true,
          stdout: "running\n",
          code: 0,
        },
        "systemd-run --user --version": {
          ok: false,
          code: -1,
          errnoCode: "ENOENT",
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.reason).toBe("systemd-run-missing");
      expect(result.summary).toMatch(/systemd-run --user --version/);
    });

    it("returns {ok: false, reason: 'systemd-run-broken'} when binary runs but exits non-zero", async () => {
      // E.g. version probe blew up for a non-PATH reason (dbus unreachable,
      // user instance gone between the first and second probe).
      const runProbe = makeStubRunner({
        "systemctl --user is-system-running": {
          ok: true,
          stdout: "running\n",
          code: 0,
        },
        "systemd-run --user --version": {
          ok: false,
          stderr: "Failed to connect to bus: No such file or directory\n",
          code: 1,
        },
      });

      const result = await preflightSystemdRun({ runProbe });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.reason).toBe("systemd-run-broken");
      expect(result.summary).toMatch(/Failed to connect to bus/);
    });
  });

  describe("SystemdPreflightError", () => {
    it("wraps a failed result with summary + reason", () => {
      const err = new SystemdPreflightError({
        ok: false,
        reason: "systemd-run-missing",
        summary: "systemd-run --user --version not on PATH",
      });
      expect(err.message).toBe("systemd-run --user --version not on PATH");
      expect(err.reason).toBe("systemd-run-missing");
      expect(err.name).toBe("SystemdPreflightError");
    });
  });
});
