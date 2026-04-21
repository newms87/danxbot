import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeSync, fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SpawnArgs = [string, string[], Record<string, unknown>];
const spawnCalls: SpawnArgs[] = [];
const spawnMock = vi.fn<(...args: SpawnArgs) => unknown>(() => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: (...args: SpawnArgs) => {
      spawnCalls.push(args);
      return spawnMock(...args);
    },
  };
});

// Import AFTER vi.mock so terminal.ts picks up the mocked spawn.
const { spawnInTerminal } = await import("./terminal.js");

describe("spawnInTerminal — wt.exe output capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terminal-spawn-test-"));
    spawnCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the wt.exe output log file at the provided path before spawning", () => {
    const wtLogPath = join(dir, "wt-stderr.log");

    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
      wtLogPath,
    });

    // File must exist on disk synchronously — this is what the operator will
    // read after a timeout. `openSync` happens BEFORE spawn() so the path is
    // guaranteed to exist even if wt.exe never executes.
    expect(existsSync(wtLogPath)).toBe(true);
  });

  it("wires wt.exe stdout+stderr to the provided log file via file descriptor", () => {
    const wtLogPath = join(dir, "wt-stderr.log");

    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
      wtLogPath,
    });

    expect(spawnCalls).toHaveLength(1);
    const [cmd, , opts] = spawnCalls[0]!;
    expect(cmd).toBe("wt.exe");

    // stdio must be ['ignore', <fd>, <fd>] (or ['ignore', <fd>, <same-fd>]).
    // Array form is required — "ignore" string would silently discard output.
    const stdio = opts.stdio as unknown as
      | ["ignore", number, number]
      | string
      | undefined;
    expect(Array.isArray(stdio)).toBe(true);
    const [stdin, stdout, stderr] = stdio as ["ignore", number, number];
    expect(stdin).toBe("ignore");
    expect(typeof stdout).toBe("number");
    expect(typeof stderr).toBe("number");
    // FDs must refer to valid open file descriptors (positive integers).
    expect(stdout).toBeGreaterThan(2);
    expect(stderr).toBeGreaterThan(2);

    // Writing to the FD must land in the log file on disk — proves the FD
    // points at the right place. We write a probe byte, close nothing
    // (Node owns the FD lifecycle once it's passed to spawn), and read back.
    writeSync(stdout, "probe-from-test\n");
    expect(readFileSync(wtLogPath, "utf-8")).toContain("probe-from-test");
  });

  it("preserves detached:true + unref() so wt.exe outlives the node dispatch", () => {
    const wtLogPath = join(dir, "wt-stderr.log");

    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
      wtLogPath,
    });

    const [, , opts] = spawnCalls[0]!;
    // detached:true is load-bearing — without it, wt.exe is a child of
    // node and gets killed when the dispatch request handler returns.
    expect(opts.detached).toBe(true);
  });

  it("falls back to stdio:'ignore' when wtLogPath is omitted (unchanged legacy behavior)", () => {
    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
    });

    const [, , opts] = spawnCalls[0]!;
    // No path → no file opened → the prior silent-discard behavior stands.
    // This branch exists only so callers that don't care about diagnostics
    // aren't forced to manage a log file.
    expect(opts.stdio).toBe("ignore");
  });

  it("closes the wt.exe log FD when spawn emits 'error' (no leak on ENOENT)", () => {
    const wtLogPath = join(dir, "wt-stderr.log");

    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
      wtLogPath,
    });

    const [, , opts] = spawnCalls[0]!;
    const [, stdout] = opts.stdio as ["ignore", number, number];

    // Mock spawn returns a plain EventEmitter — emit 'error' to trigger the
    // handler that must close the FD. Without the handler, the FD would
    // leak for the worker's lifetime on every failed dispatch (the exact
    // diagnostic case this feature was built for).
    const child = spawnMock.mock.results[0]!.value as EventEmitter;
    child.emit("error", Object.assign(new Error("ENOENT: wt.exe"), {
      code: "ENOENT",
    }));

    // fstatSync on a closed FD throws EBADF — that's our "FD is closed"
    // signal. The alternative (reading /proc/self/fd/N) is linux-only.
    expect(() => fstatSync(stdout)).toThrow(/EBADF|bad file/i);
  });

  it("strips CLAUDECODE* env vars before launching wt.exe (regression guard)", () => {
    const wtLogPath = join(dir, "wt-stderr.log");

    spawnInTerminal({
      title: "danxbot test tab",
      script: join(dir, "run-agent.sh"),
      cwd: dir,
      wtLogPath,
      env: {
        PATH: "/usr/bin",
        CLAUDECODE_ENTRYPOINT: "claude",
        CLAUDECODE_SOMETHING: "x",
      },
    });

    const [, , opts] = spawnCalls[0]!;
    const env = opts.env as Record<string, string | undefined>;
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CLAUDECODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDECODE_SOMETHING).toBeUndefined();
  });
});
