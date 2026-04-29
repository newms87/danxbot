import { describe, it, expect, afterEach } from "vitest";
import { run, tryRun, awsCmd, runStreaming, setDryRun, isDryRun } from "./exec.js";

describe("exec", () => {
  it("run returns trimmed stdout", () => {
    expect(run("echo hello")).toBe("hello");
  });

  it("run throws on non-zero exit", () => {
    expect(() => run("false")).toThrow();
  });

  it("tryRun returns null on failure", () => {
    expect(tryRun("false")).toBeNull();
  });

  it("tryRun returns stdout on success", () => {
    expect(tryRun("echo world")).toBe("world");
  });

  it("awsCmd prepends --profile when profile is non-empty", () => {
    expect(awsCmd("prod", "s3 ls")).toBe("aws --profile prod s3 ls");
  });

  it("awsCmd omits --profile when profile is empty string", () => {
    expect(awsCmd("", "sts get-caller-identity")).toBe(
      "aws sts get-caller-identity",
    );
  });

  it("awsCmd collapses multiple spaces", () => {
    expect(awsCmd("", "  s3    ls  ")).toBe("aws s3 ls");
  });

  it("run honors options.cwd", () => {
    expect(run("pwd", { cwd: "/tmp" })).toBe("/tmp");
  });

  it("tryRun honors options.cwd", () => {
    expect(tryRun("pwd", { cwd: "/tmp" })).toBe("/tmp");
  });

  it("runStreaming with logLabel does not echo the raw command (secret redaction)", () => {
    // Spy on console.log to catch what gets printed. Use a harmless echo as
    // the real cmd; the "secret" is in argv but logLabel must replace it.
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      runStreaming("echo harmless", { logLabel: "echo <REDACTED>" });
    } finally {
      console.log = originalLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("<REDACTED>");
    expect(joined).not.toContain("harmless");
  });
});

describe("dry-run mode", () => {
  // Dry-run is module-level state — every test must reset to avoid leaking
  // into the next case (especially the live `run("echo hello")` tests above
  // which would silently start returning "" if a prior dry-run case forgot
  // to clear the flag).
  afterEach(() => {
    setDryRun(false);
  });

  it("isDryRun() defaults to false", () => {
    expect(isDryRun()).toBe(false);
  });

  it("setDryRun toggles the flag", () => {
    setDryRun(true);
    expect(isDryRun()).toBe(true);
    setDryRun(false);
    expect(isDryRun()).toBe(false);
  });

  it("run() in dry-run prints the command and returns an empty string without executing", () => {
    const logs = captureLogs(() => {
      setDryRun(true);
      // Use a command that would FAIL if actually executed — the test proves
      // execSync was not called. `false` exits 1; non-dry-run path would throw.
      const result = run("false");
      expect(result).toBe("");
    });
    expect(logs.join("\n")).toContain("[dry-run] $ false");
  });

  it("runStreaming() in dry-run prints the command (or logLabel) without executing", () => {
    const logs = captureLogs(() => {
      setDryRun(true);
      // `false` would throw if executed.
      runStreaming("false");
    });
    expect(logs.join("\n")).toContain("[dry-run] $ false");
  });

  it("runStreaming() in dry-run honors logLabel for secret redaction", () => {
    const logs = captureLogs(() => {
      setDryRun(true);
      runStreaming("aws ssm put-parameter --value 'super-secret'", {
        logLabel: "aws ssm put-parameter /path/to/key",
      });
    });
    const joined = logs.join("\n");
    expect(joined).toContain("[dry-run] $ aws ssm put-parameter /path/to/key");
    expect(joined).not.toContain("super-secret");
  });

  it("tryRun() in dry-run prints and returns null (not the empty-string success result)", () => {
    // Returning null in dry-run preserves the "command failed" semantics that
    // bootstrapBackend's head-bucket / describe-table probes rely on — so
    // dry-run output walks INTO the would-create branch instead of stopping
    // at the probe.
    const logs = captureLogs(() => {
      setDryRun(true);
      const result = tryRun("echo would-have-printed-this");
      expect(result).toBeNull();
    });
    expect(logs.join("\n")).toContain(
      "[dry-run] $ echo would-have-printed-this",
    );
  });

  it("turning dry-run off restores normal execution", () => {
    setDryRun(true);
    expect(run("false")).toBe("");
    setDryRun(false);
    expect(run("echo back-to-real")).toBe("back-to-real");
  });
});

function captureLogs(fn: () => void): string[] {
  const original = console.log;
  const captured: string[] = [];
  console.log = (msg: string) => {
    captured.push(msg);
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return captured;
}
