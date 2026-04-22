import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { generateWorkspace, workspacePath, WORKSPACE_SUBDIR } from "./generate.js";

/**
 * Make a fresh temp dir to use as `repo.localPath`. The workspace generator
 * writes under `<repo.localPath>/.danxbot/workspace/` so each test gets an
 * isolated on-disk tree.
 */
function setupRepo(): string {
  return mkdtempSync(resolve(tmpdir(), "danxbot-workspace-test-"));
}

/**
 * Recursively list every file under `root` as a set of paths relative to
 * `root`. Used for snapshot-style assertions that no write escapes the
 * expected subtree.
 */
function listFilesRecursive(root: string): Set<string> {
  const files = new Set<string>();
  function walk(dir: string, rel: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(dir, entry.name), next);
      else files.add(next);
    }
  }
  if (existsSync(root)) walk(root, "");
  return files;
}

describe("generateWorkspace", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = setupRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("directory layout", () => {
    it("creates .danxbot/workspace/ with the .claude subtree", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      const result = generateWorkspace(repo);

      const expectedPath = resolve(repoDir, ".danxbot", WORKSPACE_SUBDIR);
      expect(result.path).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);

      // .claude subdirectories the agent's project scope needs.
      for (const sub of ["rules", "skills", "agents", "tools"]) {
        const dir = resolve(expectedPath, ".claude", sub);
        expect(existsSync(dir), `expected ${dir} to exist`).toBe(true);
        expect(statSync(dir).isDirectory()).toBe(true);
      }
    });

    it("workspacePath() resolves to <repo>/.danxbot/workspace/", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      expect(workspacePath(repo)).toBe(
        resolve(repoDir, ".danxbot", "workspace"),
      );
    });
  });

  describe("owner-owned files", () => {
    it("writes CLAUDE.md, .gitignore, .mcp.json, and .claude/settings.json", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      const result = generateWorkspace(repo);

      const claudeMd = resolve(result.path, "CLAUDE.md");
      expect(readFileSync(claudeMd, "utf-8")).toMatch(/Danxbot Workspace/);

      const gitignore = resolve(result.path, ".gitignore");
      const ignoreContent = readFileSync(gitignore, "utf-8");
      expect(ignoreContent).toMatch(/^\*$/m);
      expect(ignoreContent).toMatch(/^!\.gitignore$/m);

      const mcp = resolve(result.path, ".mcp.json");
      const mcpJson = JSON.parse(readFileSync(mcp, "utf-8"));
      expect(mcpJson).toEqual({ mcpServers: {} });

      const settings = resolve(result.path, ".claude", "settings.json");
      const settingsJson = JSON.parse(readFileSync(settings, "utf-8"));
      expect(settingsJson).toEqual({
        env: { DANXBOT_WORKER_PORT: "5562" },
      });
    });

    it("settings.json reflects the repo's workerPort", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 9999 });
      const result = generateWorkspace(repo);

      const settings = JSON.parse(
        readFileSync(resolve(result.path, ".claude", "settings.json"), "utf-8"),
      );
      expect(settings.env.DANXBOT_WORKER_PORT).toBe("9999");
    });

  });

  describe("idempotency", () => {
    it("reports all files changed on first call", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      const result = generateWorkspace(repo);

      expect(result.changedFiles.sort()).toEqual(
        [".claude/settings.json", ".gitignore", ".mcp.json", "CLAUDE.md"].sort(),
      );
    });

    it("reports no changes on a second call with identical inputs", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      generateWorkspace(repo);
      const second = generateWorkspace(repo);

      expect(second.changedFiles).toEqual([]);
    });

    it("rewrites CLAUDE.md and reports it changed when stale content is present", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      const { path } = generateWorkspace(repo);

      // Simulate a user / previous-version edit to an owner-owned file.
      // The generator MUST rewrite it — this is the fail-loud contract,
      // not a "preserve user edits" branch.
      const claudeMd = resolve(path, "CLAUDE.md");
      writeFileSync(claudeMd, "# stale edit\n");

      const second = generateWorkspace(repo);
      expect(second.changedFiles).toEqual(["CLAUDE.md"]);
      expect(readFileSync(claudeMd, "utf-8")).toMatch(/Danxbot Workspace/);
    });

    it("reports only settings.json changed when the worker port changes", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      generateWorkspace(repo);

      const repo2 = makeRepoContext({ localPath: repoDir, workerPort: 5999 });
      const result = generateWorkspace(repo2);

      expect(result.changedFiles).toEqual([".claude/settings.json"]);
    });

    it("preserves poller-owned content in .claude/rules/ between runs", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      const { path } = generateWorkspace(repo);

      // Simulate the poller dropping a rule file. The generator is NOT
      // allowed to touch these — that's the poller's inject pipeline.
      const ruleFile = resolve(path, ".claude", "rules", "danx-halt-flag.md");
      writeFileSync(ruleFile, "# injected rule");

      generateWorkspace(repo);
      expect(readFileSync(ruleFile, "utf-8")).toBe("# injected rule");
    });
  });

  describe("guardrails", () => {
    it("does not write anything inside <repo>/.claude/", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      generateWorkspace(repo);

      // Nothing outside `.danxbot/` should have been touched — AC #8 (and
      // the core design premise) says the repo root stays the developer's.
      expect(existsSync(resolve(repoDir, ".claude"))).toBe(false);
    });

    it("does not write anything inside <repo>/.danxbot/config/ or .danxbot/.env", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });
      generateWorkspace(repo);

      expect(existsSync(resolve(repoDir, ".danxbot", "config"))).toBe(false);
      expect(existsSync(resolve(repoDir, ".danxbot", ".env"))).toBe(false);
    });

    it("every written file lands under .danxbot/workspace/ (snapshot)", () => {
      const repo = makeRepoContext({ localPath: repoDir, workerPort: 5562 });

      // Baseline: an empty repo dir has no files.
      expect(listFilesRecursive(repoDir)).toEqual(new Set<string>());

      generateWorkspace(repo);

      // Every new file must live under the workspace subdir. This is a
      // stronger guarantee than the two targeted guardrail tests — it
      // covers the whole filesystem surface under repoDir.
      const after = listFilesRecursive(repoDir);
      for (const file of after) {
        expect(
          file.startsWith(".danxbot/workspace/"),
          `unexpected write outside workspace: ${file}`,
        ).toBe(true);
      }
    });
  });
});
