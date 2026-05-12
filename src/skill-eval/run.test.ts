import { describe, expect, it } from "vitest";
import {
  RunnerArgsError,
  parseArgs,
  parsePositiveInt,
  pickArg,
} from "./run.js";

describe("pickArg", () => {
  it("returns value for `--flag value` form", () => {
    expect(pickArg(["--query", "hello"], "query")).toBe("hello");
  });
  it("returns value for `--flag=value` form", () => {
    expect(pickArg(["--query=hello"], "query")).toBe("hello");
  });
  it("returns null when flag is absent", () => {
    expect(pickArg(["--other", "x"], "query")).toBe(null);
  });
  it("returns null when `--flag` is the last arg (no value)", () => {
    expect(pickArg(["--query"], "query")).toBe(null);
  });
});

describe("parsePositiveInt", () => {
  it("parses a valid positive integer", () => {
    expect(parsePositiveInt("port", "5563")).toBe(5563);
  });
  it("rejects trailing non-digits (parseInt prefix gotcha)", () => {
    expect(() => parsePositiveInt("port", "5563abc")).toThrow(RunnerArgsError);
  });
  it("rejects empty / whitespace", () => {
    expect(() => parsePositiveInt("port", "")).toThrow(RunnerArgsError);
    expect(() => parsePositiveInt("port", "   ")).toThrow(RunnerArgsError);
  });
  it("rejects zero and negatives", () => {
    expect(() => parsePositiveInt("port", "0")).toThrow(RunnerArgsError);
    expect(() => parsePositiveInt("port", "-1")).toThrow(RunnerArgsError);
  });
  it("rejects non-numeric input", () => {
    expect(() => parsePositiveInt("timeout-ms", "foo")).toThrow(RunnerArgsError);
  });
});

describe("parseArgs", () => {
  const baseEnv = { DANXBOT_REPO_ROOT: "/tmp/some/repo", DANXBOT_WORKER_PORT: "5563" };

  it("happy path: --query + --expect-skill from explicit flags, env for repo-root and worker-port", () => {
    const args = parseArgs(
      ["--query", "hello", "--expect-skill", "dev:debugging"],
      baseEnv,
    );
    expect(args.query).toBe("hello");
    expect(args.expectSkill).toBe("dev:debugging");
    expect(args.workspace).toBe("skill-eval");
    expect(args.workerPort).toBe(5563);
    expect(args.repoName).toBe("danxbot");
    expect(args.workspaceCwd).toBe(
      "/tmp/some/repo/.danxbot/workspaces/skill-eval",
    );
  });

  it("--workspace / --repo / --repo-root flags override env defaults", () => {
    const args = parseArgs(
      [
        "--query=q",
        "--expect-skill=dev:debugging",
        "--workspace=custom",
        "--repo=other",
        "--repo-root=/srv/other",
      ],
      baseEnv,
    );
    expect(args.workspace).toBe("custom");
    expect(args.repoName).toBe("other");
    expect(args.workspaceCwd).toBe(
      "/srv/other/.danxbot/workspaces/custom",
    );
  });

  it("throws on missing --query", () => {
    expect(() => parseArgs(["--expect-skill=x"], baseEnv)).toThrow(/missing --query/);
  });
  it("throws on missing --expect-skill", () => {
    expect(() => parseArgs(["--query=q"], baseEnv)).toThrow(/missing --expect-skill/);
  });
  it("throws when neither --repo-root nor DANXBOT_REPO_ROOT is set", () => {
    expect(() =>
      parseArgs(
        ["--query=q", "--expect-skill=x"],
        { DANXBOT_WORKER_PORT: "5563" },
      ),
    ).toThrow(/missing --repo-root/);
  });
  it("throws when neither --worker-port nor DANXBOT_WORKER_PORT is set", () => {
    expect(() =>
      parseArgs(
        ["--query=q", "--expect-skill=x"],
        { DANXBOT_REPO_ROOT: "/tmp/r" },
      ),
    ).toThrow(/missing --worker-port/);
  });
  it("rejects malformed --timeout-ms (NaN trap)", () => {
    expect(() =>
      parseArgs(
        ["--query=q", "--expect-skill=x", "--timeout-ms=foo"],
        baseEnv,
      ),
    ).toThrow(/timeout-ms/);
  });
});
