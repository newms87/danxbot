/**
 * DX-340 — verify the gitignore extension that stops two-writer
 * contention on `<repo>/.danxbot/workspaces/<templated>/*`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { injectDir } from "./_shared/inject-utils.js";
import { ensureWorkspaceGitignoreEntries } from "./gitignore-workspaces.js";

function readGitignoreLines(repoRoot: string): string[] {
  const content = readFileSync(
    resolve(repoRoot, ".danxbot/.gitignore"),
    "utf-8",
  );
  return content.split("\n");
}

function templatedWorkspaceNames(): string[] {
  const dir = resolve(injectDir, "workspaces");
  return readdirSync(dir).filter((entry) =>
    statSync(resolve(dir, entry)).isDirectory(),
  );
}

describe("ensureWorkspaceGitignoreEntries (DX-340)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-gitignore-workspaces-"));
    mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("appends the universal danxbot-owned workspace patterns", () => {
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = readGitignoreLines(repoRoot);
    expect(lines).toContain("workspaces/*/.claude/rules/danx-*.md");
    expect(lines).toContain("workspaces/*/.claude/hooks/worktree-guard.mjs");
    expect(lines).toContain("workspaces/*/.claude/scheduled_tasks.lock");
    expect(lines).toContain("workspaces/*/.claude/clad.json");
  });

  it("appends per-workspace patterns for every templated workspace", () => {
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = readGitignoreLines(repoRoot);
    const names = templatedWorkspaceNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(lines).toContain(`workspaces/${name}/CLAUDE.md`);
      expect(lines).toContain(`workspaces/${name}/workspace.yml`);
      expect(lines).toContain(`workspaces/${name}/workspace-shape.test.ts`);
      expect(lines).toContain(`workspaces/${name}/.mcp.json`);
      expect(lines).toContain(`workspaces/${name}/.claude/settings.json`);
      expect(lines).toContain(`workspaces/${name}/.claude/skills/danx-prep/`);
    }
  });

  it("auto-covers every workspace dir under src/inject/workspaces/", () => {
    // Auto-grow guard: derive the expected set from disk, not a
    // hardcoded list. If someone adds a new templated workspace and
    // forgets to update this rule, the test still passes — which is
    // exactly the intent (no central list to keep in sync).
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = new Set(readGitignoreLines(repoRoot));
    for (const name of templatedWorkspaceNames()) {
      expect(lines.has(`workspaces/${name}/CLAUDE.md`)).toBe(true);
    }
  });

  it("does not stamp per-workspace patterns for non-templated names", () => {
    // A repo-custom workspace (e.g. gpt-manager's `schema-builder`) is
    // NOT in src/inject/workspaces/, so it must NOT receive the
    // per-templated-workspace patterns. Only the universal `workspaces/*`
    // patterns apply to it.
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = readGitignoreLines(repoRoot);
    expect(lines).not.toContain("workspaces/schema-builder/CLAUDE.md");
    expect(lines).not.toContain("workspaces/schema-builder/workspace.yml");
    expect(lines).not.toContain("workspaces/schema-builder/.mcp.json");
  });

  it("is idempotent — repeated ticks do not duplicate lines", () => {
    ensureWorkspaceGitignoreEntries(repoRoot);
    ensureWorkspaceGitignoreEntries(repoRoot);
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = readGitignoreLines(repoRoot);
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (!line) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    for (const [line, count] of counts) {
      expect(count, `duplicate line: ${line}`).toBe(1);
    }
  });

  it("preserves pre-existing gitignore entries", () => {
    writeFileSync(
      resolve(repoRoot, ".danxbot/.gitignore"),
      "issues/\n.trello-retry/\nfeatures.md\n",
    );
    ensureWorkspaceGitignoreEntries(repoRoot);
    const lines = readGitignoreLines(repoRoot);
    expect(lines).toContain("issues/");
    expect(lines).toContain(".trello-retry/");
    expect(lines).toContain("features.md");
    expect(lines).toContain("workspaces/*/.claude/rules/danx-*.md");
  });
});
