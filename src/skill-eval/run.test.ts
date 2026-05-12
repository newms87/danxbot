import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  RunnerArgsError,
  dispatchTagFor,
  findJsonlByTag,
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

describe("dispatchTagFor", () => {
  it("renders the canonical dispatch-tag shape", () => {
    expect(dispatchTagFor("abc-123")).toBe(
      "<!-- danxbot-dispatch:abc-123 -->",
    );
  });
});

describe("findJsonlByTag", () => {
  /**
   * The runner derives the JSONL search dir via `deriveSessionDir(cwd)`
   * which lives at `~/.claude/projects/<encoded-cwd>`. To exercise that
   * code path under a tmp cwd we use a fake homedir... but `deriveSessionDir`
   * imports `homedir()` directly. Instead, we set up a real `<homedir>/.claude/projects/<encoded>` for
   * a synthetic workspace path and clean up after. The "encoded" form is
   * `<cwd>.replace(/\//g, '-')` — see `encodeClaudeProjectsCwd` in
   * `src/agent/session-log-watcher.ts`.
   */
  function setup(): { cwd: string; encDir: string; cleanup: () => void } {
    const probeRoot = mkdtempSync(join(tmpdir(), "skill-eval-test-"));
    const fakeWorkspaceCwd = join(probeRoot, "workspace");
    mkdirSync(fakeWorkspaceCwd, { recursive: true });
    // deriveSessionDir encodes the realpath of `cwd`; we mkdir the encoded
    // directory under the real `~/.claude/projects/` and clean up after.
    const encDir = join(
      homedir(),
      ".claude",
      "projects",
      fakeWorkspaceCwd.replace(/\//g, "-"),
    );
    mkdirSync(encDir, { recursive: true });
    return {
      cwd: fakeWorkspaceCwd,
      encDir,
      cleanup: () => {
        rmSync(encDir, { recursive: true, force: true });
        rmSync(probeRoot, { recursive: true, force: true });
      },
    };
  }

  it("reason=dir-missing when projects dir was never created", () => {
    const probeRoot = mkdtempSync(join(tmpdir(), "skill-eval-test-"));
    const fakeCwd = join(probeRoot, "never-attached-workspace");
    mkdirSync(fakeCwd, { recursive: true });
    try {
      // Intentionally DO NOT create the encoded dir.
      const result = findJsonlByTag(fakeCwd, "<!-- danxbot-dispatch:x -->");
      expect(result.reason).toBe("dir-missing");
      expect(result.path).toBe(null);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it("reason=no-files when the projects dir is empty", () => {
    const { cwd, cleanup } = setup();
    try {
      const result = findJsonlByTag(cwd, "<!-- danxbot-dispatch:x -->");
      expect(result.reason).toBe("no-files");
      expect(result.scannedFiles).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("reason=tag-not-in-any-file when tag is absent from every JSONL", () => {
    const { cwd, encDir, cleanup } = setup();
    try {
      writeFileSync(
        join(encDir, "session-a.jsonl"),
        JSON.stringify({ type: "user", message: { content: "no tag here" } }) + "\n",
      );
      writeFileSync(
        join(encDir, "session-b.jsonl"),
        JSON.stringify({ type: "assistant" }) + "\n",
      );
      const result = findJsonlByTag(cwd, "<!-- danxbot-dispatch:missing -->");
      expect(result.reason).toBe("tag-not-in-any-file");
      expect(result.scannedFiles).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("reason=found returns the matching path", () => {
    const { cwd, encDir, cleanup } = setup();
    try {
      writeFileSync(
        join(encDir, "session-a.jsonl"),
        JSON.stringify({ type: "user", message: { content: "no tag" } }) + "\n",
      );
      const target = join(encDir, "session-b.jsonl");
      const tag = "<!-- danxbot-dispatch:abc-123 -->";
      writeFileSync(
        target,
        JSON.stringify({
          type: "user",
          message: { content: `prefix ${tag} suffix` },
        }) + "\n",
      );
      const result = findJsonlByTag(cwd, tag);
      expect(result.reason).toBe("found");
      expect(result.path).toBe(resolve(target));
    } finally {
      cleanup();
    }
  });
});
