import { describe, it, expect } from "vitest";
import { run, tryRun, awsCmd, runStreaming } from "./exec.js";

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
