/**
 * DX-558 — coverage for `syncRepoRoot` across the four documented
 * branches. The exec seam (`ExecGitFn`) lets us stub git verbatim
 * without spawning processes.
 *
 * Branches:
 *   1. Clean tree, ff-pull succeeds → status: "synced", state file removed.
 *   2. Clean tree, pull non-ff, rebase succeeds → status: "synced".
 *   3. Clean tree, pull non-ff, rebase conflicts → abort, status: "rebase-conflict".
 *   4. Dirty tree (tracked changes / untracked outside .danxbot/) → blocked, no pull attempted.
 *
 * Plus invariants the implementation guarantees:
 *   - Untracked files inside `.danxbot/` are IGNORED (danxbot's own state).
 *   - State file is written on error, removed on clear.
 *   - `since` is preserved across same-reason retries, reset on reason transition.
 *   - `fetch` failure collapses to `rebase-conflict` (same operator action).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetForTesting,
  getRepoRootSyncError,
  hasRepoRootSyncError,
  syncRepoRoot,
  type ExecGitFn,
  type ExecResult,
} from "./sync-root.js";

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr: string, code = 1): ExecResult {
  return { code, stdout: "", stderr };
}

/**
 * Build a tape-deck exec that pops the next scripted result per call
 * and asserts the args it received match. Failing the assert throws,
 * surfacing as a test failure.
 */
function makeTape(
  steps: Array<{ args: string[]; result: ExecResult }>,
): { exec: ExecGitFn; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const exec: ExecGitFn = async (args) => {
    calls.push(args);
    if (i >= steps.length) {
      throw new Error(`Unexpected git call ${i}: ${args.join(" ")}`);
    }
    const step = steps[i++];
    expect(args).toEqual(step.args);
    return step.result;
  };
  return { exec, calls };
}

let workDir: string;
let stateFile: string;
const REPO = "danxbot";
const NOW = "2026-05-16T04:00:00.000Z";

beforeEach(() => {
  _resetForTesting();
  workDir = mkdtempSync(join(tmpdir(), "sync-root-test-"));
  stateFile = join(workDir, "sync-root-state.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("syncRepoRoot — branch 1: clean fast-forward", () => {
  it("returns synced and removes any prior state file", async () => {
    const { exec } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok("") },
      { args: ["pull", "--ff-only", "origin", "main"], result: ok("Already up to date.\n") },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res).toEqual({ status: "synced", error: null });
    expect(hasRepoRootSyncError(REPO)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("syncRepoRoot — branch 2: non-ff but rebase succeeds", () => {
  it("returns synced after a successful rebase", async () => {
    const { exec } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok("") },
      { args: ["pull", "--ff-only", "origin", "main"], result: fail("Not possible to fast-forward, aborting.") },
      { args: ["rebase", "origin/main"], result: ok("Successfully rebased.") },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("synced");
    expect(hasRepoRootSyncError(REPO)).toBe(false);
  });
});

describe("syncRepoRoot — branch 3: rebase conflict aborted", () => {
  it("records rebase-conflict error and writes state file", async () => {
    const { exec, calls } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok("") },
      { args: ["pull", "--ff-only", "origin", "main"], result: fail("non-ff") },
      { args: ["rebase", "origin/main"], result: fail("CONFLICT (content): Merge conflict in src/foo.ts") },
      { args: ["rebase", "--abort"], result: ok() },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("rebase-conflict");
    expect(res.error?.reason).toBe("rebase-conflict");
    expect(res.error?.detail).toContain("CONFLICT");
    expect(existsSync(stateFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persisted.reason).toBe("rebase-conflict");
    expect(persisted.since).toBe(NOW);
    expect(persisted.lastTriedAt).toBe(NOW);
    // Confirms the abort was actually invoked.
    expect(calls[4]).toEqual(["rebase", "--abort"]);
  });
});

describe("syncRepoRoot — branch 4: dirty tree blocks sync", () => {
  it("records dirty error and never invokes pull / rebase", async () => {
    const { exec, calls } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      {
        args: ["status", "--porcelain"],
        result: ok(" M src/foo.ts\n?? scratch.txt\n"),
      },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("dirty");
    expect(res.error?.reason).toBe("dirty");
    expect(res.error?.detail).toContain("M src/foo.ts");
    expect(res.error?.detail).toContain("?? scratch.txt");
    // Pull / rebase MUST NOT have been called.
    expect(calls).toHaveLength(2);
    // State file persisted for the dashboard chokidar.
    expect(existsSync(stateFile)).toBe(true);
  });
});

describe("syncRepoRoot — dirty parser ignores .danxbot/ untracked noise", () => {
  it("returns synced when the only dirty entries are untracked under .danxbot/", async () => {
    const { exec } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      {
        args: ["status", "--porcelain"],
        result: ok("?? .danxbot/workspaces/issue-worker/scratch\n?? .danxbot/cron-state.json\n"),
      },
      { args: ["pull", "--ff-only", "origin", "main"], result: ok() },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("synced");
  });

  it("flags tracked-file changes inside .danxbot/ as dirty", async () => {
    // ` M` (modified-in-worktree) on a tracked file under .danxbot/ MUST
    // still trip the dirty gate — only untracked-`??`-inside-.danxbot/ is
    // ignored. This pins the parser invariant called out in the
    // implementation's parseDirty comment.
    const { exec } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok(" M .danxbot/config/config.yml\n") },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("dirty");
  });
});

describe("syncRepoRoot — fetch failure", () => {
  it("records rebase-conflict-class error when fetch fails", async () => {
    const { exec } = makeTape([
      {
        args: ["fetch", "origin", "main", "--quiet"],
        result: fail("fatal: unable to access 'https://...'"),
      },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("rebase-conflict");
    expect(res.error?.detail).toContain("git fetch origin main failed");
  });
});

describe("syncRepoRoot — since preservation across retries", () => {
  it("preserves `since` across same-reason retries, resets on reason transition", async () => {
    const tapeDirty: Array<{ args: string[]; result: ExecResult }> = [
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok(" M src/a.ts\n") },
    ];

    // First failure → dirty at T1.
    const { exec: e1 } = makeTape(tapeDirty);
    await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec: e1,
      stateFilePath: stateFile,
      now: () => "2026-05-16T04:00:00.000Z",
    });
    const after1 = getRepoRootSyncError(REPO);
    expect(after1?.since).toBe("2026-05-16T04:00:00.000Z");

    // Same reason at T2 — `since` preserved, `lastTriedAt` advances.
    const { exec: e2 } = makeTape(tapeDirty);
    await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec: e2,
      stateFilePath: stateFile,
      now: () => "2026-05-16T04:05:00.000Z",
    });
    const after2 = getRepoRootSyncError(REPO);
    expect(after2?.since).toBe("2026-05-16T04:00:00.000Z");
    expect(after2?.lastTriedAt).toBe("2026-05-16T04:05:00.000Z");

    // Reason transitions dirty → rebase-conflict at T3 — `since` resets.
    const { exec: e3 } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok("") },
      { args: ["pull", "--ff-only", "origin", "main"], result: fail("non-ff") },
      { args: ["rebase", "origin/main"], result: fail("CONFLICT") },
      { args: ["rebase", "--abort"], result: ok() },
    ]);
    await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec: e3,
      stateFilePath: stateFile,
      now: () => "2026-05-16T04:10:00.000Z",
    });
    const after3 = getRepoRootSyncError(REPO);
    expect(after3?.reason).toBe("rebase-conflict");
    expect(after3?.since).toBe("2026-05-16T04:10:00.000Z");
  });
});

describe("syncRepoRoot — clear on subsequent success", () => {
  it("removes the in-memory entry and state file when next sync succeeds", async () => {
    // Prime with a dirty error.
    const { exec: e1 } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok(" M a\n") },
    ]);
    await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec: e1,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(hasRepoRootSyncError(REPO)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);

    // Next sync clean.
    const { exec: e2 } = makeTape([
      { args: ["fetch", "origin", "main", "--quiet"], result: ok() },
      { args: ["status", "--porcelain"], result: ok("") },
      { args: ["pull", "--ff-only", "origin", "main"], result: ok() },
    ]);
    const res = await syncRepoRoot({
      repoName: REPO,
      repoLocalPath: "/fake",
      exec: e2,
      stateFilePath: stateFile,
      now: () => NOW,
    });
    expect(res.status).toBe("synced");
    expect(hasRepoRootSyncError(REPO)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });
});
