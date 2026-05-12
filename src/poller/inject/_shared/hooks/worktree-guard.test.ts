// DX-309: worktree-guard PreToolUse hook — accept/deny matrix.
//
// The hook is a standalone .mjs invoked by Claude Code per tool call.
// Tests spawn it via `execFileSync` with the JSON envelope on stdin
// and assert the exit code + stderr contents. No vitest mocks; the
// hook is a self-contained subprocess.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "worktree-guard.mjs",
);

interface RunResult {
  status: number;
  stderr: string;
  stdout: string;
}

function run(
  envelope: Record<string, unknown>,
  env: Record<string, string | undefined>,
): RunResult {
  try {
    const stdout = execFileSync("node", [HOOK], {
      input: JSON.stringify(envelope),
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stderr: "", stdout: stdout.toString() };
  } catch (err) {
    const e = err as {
      status: number | null;
      stderr: Buffer;
      stdout: Buffer;
    };
    return {
      status: e.status ?? -1,
      stderr: e.stderr?.toString() ?? "",
      stdout: e.stdout?.toString() ?? "",
    };
  }
}

describe("worktree-guard hook (DX-309)", () => {
  let worktreeDir: string;
  let outsideDir: string;
  let issuesLink: string;

  beforeEach(() => {
    const root = mkdtempSync(resolve(tmpdir(), "wt-guard-"));
    worktreeDir = resolve(root, "worktree");
    outsideDir = resolve(root, "outside");
    mkdirSync(worktreeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    // Issues symlink — worktree/.danxbot/issues → outside/issues.
    const issuesTarget = resolve(outsideDir, "issues");
    mkdirSync(resolve(issuesTarget, "open"), { recursive: true });
    writeFileSync(resolve(issuesTarget, "open", "DX-1.yml"), "id: DX-1\n");
    mkdirSync(resolve(worktreeDir, ".danxbot"), { recursive: true });
    issuesLink = resolve(worktreeDir, ".danxbot", "issues");
    symlinkSync(issuesTarget, issuesLink, "dir");
  });

  afterEach(() => {
    rmSync(dirname(worktreeDir), { recursive: true, force: true });
  });

  it("no-ops when DANX_AGENT_WORKTREE unset (non-agent dispatch)", () => {
    const result = run(
      {
        tool_name: "Edit",
        tool_input: { file_path: resolve(outsideDir, "main.ts") },
      },
      { DANX_AGENT_WORKTREE: undefined },
    );
    expect(result.status).toBe(0);
  });

  it("allows Edit on a file inside the worktree", () => {
    const path = resolve(worktreeDir, "src", "foo.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    const result = run(
      { tool_name: "Edit", tool_input: { file_path: path } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(0);
  });

  it("allows Edit on a YAML under the .danxbot/issues symlink (literal-prefix exception)", () => {
    // Literal-prefix passes; realpath resolves out to outside/issues — that
    // is intentional, single canonical issue YAML store.
    const path = resolve(issuesLink, "open", "DX-1.yml");
    const result = run(
      { tool_name: "Edit", tool_input: { file_path: path } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(0);
  });

  it("denies Edit on a file outside the worktree", () => {
    const path = resolve(outsideDir, "main.ts");
    writeFileSync(path, "");
    const result = run(
      { tool_name: "Edit", tool_input: { file_path: path } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("worktree-guard");
    expect(result.stderr).toContain(path);
  });

  it("denies Write on a file outside the worktree", () => {
    const path = resolve(outsideDir, "new.ts");
    const result = run(
      {
        tool_name: "Write",
        tool_input: { file_path: path, content: "x" },
      },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
  });

  it("denies Bash command that redirects to a path outside the worktree", () => {
    const result = run(
      {
        tool_name: "Bash",
        tool_input: {
          command: `echo hi > ${resolve(outsideDir, "data.txt")}`,
        },
      },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("writes to");
  });

  it("denies Bash `git checkout` regardless of path (mutating git op)", () => {
    const result = run(
      {
        tool_name: "Bash",
        tool_input: { command: "git checkout main" },
      },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git checkout");
  });

  it("denies Bash `git reset --hard`", () => {
    const result = run(
      {
        tool_name: "Bash",
        tool_input: { command: "git reset --hard origin/main" },
      },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git reset");
  });

  it("allows Bash `git status` (read-only)", () => {
    const result = run(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(0);
  });

  it("allows Bash command without path arguments", () => {
    const result = run(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(0);
  });

  it("denies Bash `rm` on an absolute path outside the worktree", () => {
    const path = resolve(outsideDir, "victim.ts");
    writeFileSync(path, "");
    const result = run(
      { tool_name: "Bash", tool_input: { command: `rm ${path}` } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(2);
  });

  it("ignores tools that aren't Edit/Write/MultiEdit/NotebookEdit/Bash", () => {
    const result = run(
      { tool_name: "Read", tool_input: { file_path: resolve(outsideDir, "x") } },
      { DANX_AGENT_WORKTREE: worktreeDir },
    );
    expect(result.status).toBe(0);
  });
});
