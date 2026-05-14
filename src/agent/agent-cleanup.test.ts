/**
 * Unit tests for `buildCleanup` — DX-44.
 *
 * Pre-DX-44 the per-spawn MCP settings dir (`/tmp/danxbot-mcp-*`), staged
 * files, and workspace-settings dir were cleaned up in the dispatch-layer
 * `onComplete` closure. Every termination path that fired `_cleanup` but
 * NOT `onComplete` (inactivity timeout, max-runtime timeout, host-mode
 * exit, the docker-close handler's else branch when status was already
 * set by a non-stop path) leaked those dirs. On a dev workstation that
 * grew to ~13k stale dirs in a few weeks.
 *
 * DX-44 moves those cleanups INTO `buildCleanup`'s finally block so every
 * `_cleanup` invocation reaps them — same coverage as `promptDir` and
 * `termSettingsDir`. These tests pin that contract:
 *
 *   - Every per-spawn temp dir/path passed in is removed on cleanup.
 *   - Removal survives a synchronous throw from any observer
 *     (watcher.stop, dispatchTracker.finalize) because the rm calls live
 *     in the existing `try/finally` block, not after the `try`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCleanup, type CleanupBuilderDeps } from "./agent-cleanup.js";
import type { AgentJob } from "./agent-types.js";
import type { SessionLogWatcher } from "./session-log-watcher.js";
import type { createInactivityTimer } from "./process-utils.js";

type InactivityTimer = ReturnType<typeof createInactivityTimer>;

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "test-job",
    status: "completed",
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    recoverCount: 0,
    stop: async () => {},
    ...overrides,
  };
}

function makeWatcherStub(opts: { drainThrows?: boolean } = {}): SessionLogWatcher {
  return {
    drain: vi.fn().mockImplementation(async () => {
      if (opts.drainThrows) throw new Error("drain failed");
    }),
    stop: vi.fn(),
  } as unknown as SessionLogWatcher;
}

function makeInactivityTimer(): InactivityTimer {
  return {
    clear: vi.fn(),
    reset: vi.fn(),
  } as InactivityTimer;
}

function createTempPath(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function createStagedFile(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "stub");
  return path;
}

interface TempPaths {
  promptDir: string;
  termSettingsDir: string;
  mcpSettingsDir: string;
  workspaceSettingsPath: string;
  stagedFilePaths: string[];
  stagedRoot: string;
}

function createAllTempPaths(): TempPaths {
  const stagedRoot = createTempPath("danxbot-test-staged");
  return {
    promptDir: createTempPath("danxbot-test-prompt"),
    termSettingsDir: createTempPath("danxbot-test-term"),
    mcpSettingsDir: createTempPath("danxbot-test-mcp"),
    workspaceSettingsPath: join(
      createTempPath("danxbot-test-workspace-settings"),
      "settings.json",
    ),
    stagedFilePaths: [
      createStagedFile(stagedRoot, "staged-a.json"),
      createStagedFile(stagedRoot, "staged-b.json"),
    ],
    stagedRoot,
  };
}

async function cleanupRemnants(paths: TempPaths): Promise<void> {
  // Safety net so a test failure doesn't strand the test temp dirs.
  for (const p of [
    paths.promptDir,
    paths.termSettingsDir,
    paths.mcpSettingsDir,
    paths.workspaceSettingsPath,
    paths.stagedRoot,
  ]) {
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
}

describe("buildCleanup — finally block per-spawn temp dir cleanup (DX-44)", () => {
  let paths: TempPaths;

  beforeEach(() => {
    paths = createAllTempPaths();
    // Write a real settings.json so workspaceSettingsPath has a parent
    // dir whose existence we can assert against post-cleanup.
    const dir = join(paths.workspaceSettingsPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.workspaceSettingsPath, "{}");
  });

  afterEach(async () => {
    await cleanupRemnants(paths);
  });

  it("removes the MCP settings dir on cleanup", async () => {
    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub(),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: paths.promptDir,
      getTermSettingsDir: () => paths.termSettingsDir,
      mcpSettingsDir: paths.mcpSettingsDir,
      stagedFilePaths: [],
    };

    expect(existsSync(paths.mcpSettingsDir)).toBe(true);
    await buildCleanup(deps)();
    expect(existsSync(paths.mcpSettingsDir)).toBe(false);
  });

  it("removes staged files on cleanup", async () => {
    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub(),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: paths.promptDir,
      getTermSettingsDir: () => paths.termSettingsDir,
      stagedFilePaths: paths.stagedFilePaths,
    };

    for (const p of paths.stagedFilePaths) expect(existsSync(p)).toBe(true);
    await buildCleanup(deps)();
    for (const p of paths.stagedFilePaths) expect(existsSync(p)).toBe(false);
  });

  it("removes the workspace-settings dir on cleanup", async () => {
    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub(),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: paths.promptDir,
      getTermSettingsDir: () => paths.termSettingsDir,
      workspaceSettingsPath: paths.workspaceSettingsPath,
      stagedFilePaths: [],
    };

    const workspaceDir = join(paths.workspaceSettingsPath, "..");
    expect(existsSync(workspaceDir)).toBe(true);
    await buildCleanup(deps)();
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("removes MCP settings dir even when watcher.drain throws (finally semantics — the primary regression DX-44 guards against)", async () => {
    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub({ drainThrows: true }),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: paths.promptDir,
      getTermSettingsDir: () => paths.termSettingsDir,
      mcpSettingsDir: paths.mcpSettingsDir,
      stagedFilePaths: paths.stagedFilePaths,
      workspaceSettingsPath: paths.workspaceSettingsPath,
    };

    // The drain throw escapes (runCleanup itself re-throws), but the
    // temp-dir cleanups in the finally block must still have run.
    await expect(buildCleanup(deps)()).rejects.toThrow("drain failed");
    expect(existsSync(paths.mcpSettingsDir)).toBe(false);
    expect(existsSync(paths.workspaceSettingsPath)).toBe(false);
    for (const p of paths.stagedFilePaths) expect(existsSync(p)).toBe(false);
  });

  it("continues reaping when one rm throws (independent try/catch per path)", async () => {
    // Symmetric coverage with tmp-dir-sweep's "continues sweeping
    // when one rm fails" test. If `mcpSettingsDir` rm fails (EACCES
    // on a host where the worker user lost access), the
    // `workspaceSettingsPath` parent dir + the staged files MUST
    // still get reaped — otherwise one bad path strands the rest.
    //
    // Spy on rmSync at the module level: agent-cleanup imports
    // `rmSync` from node:fs. We can't easily inject; instead, set
    // an "impossible" path for the MCP dir (a deeply nested
    // non-existent path) is NOT sufficient because rmSync({force:
    // true}) no-ops. Use chmod to revoke permissions on the parent
    // so rmSync genuinely throws EACCES.
    const { chmodSync } = await import("node:fs");
    const lockedParent = createTempPath("danxbot-test-locked");
    const lockedChild = join(lockedParent, "mcp-dir");
    mkdirSync(lockedChild);
    // Strip write perms on the parent — rmSync needs write to unlink
    // the child. On Linux this produces EACCES; on other OSes the
    // test may behave differently but the danxbot worker is
    // Linux-only.
    chmodSync(lockedParent, 0o500);

    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub(),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: paths.promptDir,
      getTermSettingsDir: () => paths.termSettingsDir,
      mcpSettingsDir: lockedChild,
      stagedFilePaths: paths.stagedFilePaths,
      workspaceSettingsPath: paths.workspaceSettingsPath,
    };

    try {
      // Cleanup itself must NOT throw — each rm is wrapped.
      await expect(buildCleanup(deps)()).resolves.toBeUndefined();
      // The locked dir survived (the rm error was swallowed).
      expect(existsSync(lockedChild)).toBe(true);
      // The OTHER per-spawn paths were still reaped.
      expect(existsSync(paths.workspaceSettingsPath)).toBe(false);
      for (const p of paths.stagedFilePaths) expect(existsSync(p)).toBe(false);
    } finally {
      // Restore permissions so afterEach can clean it up.
      chmodSync(lockedParent, 0o700);
      await rm(lockedParent, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("tolerates missing optional dirs (undefined / absent paths) without throwing", async () => {
    // promptDir is null + termSettingsDir undefined + mcpSettingsDir
    // undefined + stagedFilePaths empty + workspaceSettingsPath
    // undefined. Pre-DX-44 promptDir+termSettings already handled this;
    // the new fields MUST follow the same idempotency contract.
    const deps: CleanupBuilderDeps = {
      job: makeJob(),
      jobId: "test-job",
      watcher: makeWatcherStub(),
      inactivityTimer: makeInactivityTimer(),
      getMaxRuntimeHandle: () => undefined,
      promptDir: null,
      getTermSettingsDir: () => undefined,
      stagedFilePaths: [],
    };

    await expect(buildCleanup(deps)()).resolves.toBeUndefined();
  });
});
