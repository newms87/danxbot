/**
 * Tests for the Phase 3 (DX-142) process-table orphan scan.
 *
 * Mocks every OS-level seam: pgrep invocation, `/proc/<pid>/cwd` reading,
 * liveness probing, signal sending, DB lookups, and the system-errors
 * sink. Layer 1 (free, fast) — no real processes spawned.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import type { Dispatch } from "../dashboard/dispatches.js";

// `src/config.ts` reads required DB env vars at import time. Mock the
// pieces the module touches so the test can run as Layer 1 (no `.env`).
vi.mock("../config.js", () => ({
  config: { isHost: true },
}));

// pgrep + procfs seams. The real implementations talk to /proc; tests
// inject scripted output so the dispatch table can be exercised
// deterministically.
const mockExecPgrep = vi.fn();
const mockReadProcCwd = vi.fn();
vi.mock("./process-scan-os.js", () => ({
  execPgrepDispatchTag: (...args: unknown[]) => mockExecPgrep(...args),
  readProcCwd: (...args: unknown[]) => mockReadProcCwd(...args),
}));

// Liveness + signalling seams.
const mockIsPidAlive = vi.fn();
const mockKillHostPid = vi.fn();
vi.mock("../agent/host-pid.js", async () => {
  const actual = await vi.importActual<
    typeof import("../agent/host-pid.js")
  >("../agent/host-pid.js");
  return {
    ...actual,
    isPidAlive: (...args: unknown[]) => mockIsPidAlive(...args),
    killHostPid: (...args: unknown[]) => mockKillHostPid(...args),
  };
});

// DB row lookup.
const mockGetDispatchById = vi.fn();
vi.mock("../dashboard/dispatches-db.js", () => ({
  getDispatchById: (...args: unknown[]) => mockGetDispatchById(...args),
}));

// activeJobs registry.
const mockGetActiveJob = vi.fn();
vi.mock("../dispatch/core.js", () => ({
  getActiveJob: (...args: unknown[]) => mockGetActiveJob(...args),
}));

// recordSystemError is the dashboard-banner producer; capture every
// invocation so the per-kill emission contract can be asserted.
const mockRecordSystemError = vi.fn();
vi.mock("../dashboard/system-errors.js", () => ({
  recordSystemError: (...args: unknown[]) => mockRecordSystemError(...args),
}));

// Logger noop.
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  enumerateDispatchProcesses,
  filterByRepoCwd,
  reapOrphans,
  pickKillablePidPerDispatch,
  resolveRepoRoot,
} from "./process-scan.js";
import { mkdtempSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_LOCAL_PATH = "/home/newms/web/danxbot";

const TAGGED_SCRIPT_PARENT = (pid: number, dispatchId: string) =>
  `${pid} script -q -f /tmp/danxbot-terminal-${dispatchId}.log -c claude --dangerously-skip-permissions -- $'<!-- danxbot-dispatch:${dispatchId} --> /danx-next\\n\\nEdit foo.yml.'`;

const TAGGED_CLAUDE_CHILD = (pid: number, dispatchId: string) =>
  `${pid} claude --dangerously-skip-permissions -- <!-- danxbot-dispatch:${dispatchId} --> /danx-next  Edit foo.yml.`;

function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-1",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "card-1",
      cardName: "Card",
      cardUrl: "https://trello.com/c/card-1",
      listId: "list-1",
      listName: "ToDo",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "host",
    hostPid: 13784,
    hostPidAt: 1000,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: pgrep finds nothing, cwds unreadable, processes alive,
  // signals no-op. Each test overrides what it needs.
  (mockExecPgrep as Mock).mockResolvedValue("");
  (mockReadProcCwd as Mock).mockReturnValue(null);
  (mockIsPidAlive as Mock).mockReturnValue(true);
  (mockKillHostPid as Mock).mockReturnValue(undefined);
  (mockGetDispatchById as Mock).mockResolvedValue(null);
  (mockGetActiveJob as Mock).mockReturnValue(undefined);
});

describe("enumerateDispatchProcesses", () => {
  it("parses pgrep output into {pid, dispatchId, cmdline, cwd} for tagged processes", async () => {
    const lines = [
      TAGGED_SCRIPT_PARENT(13784, "021bc59f-cef7-4f50-a608-f73a9f473f25"),
      TAGGED_CLAUDE_CHILD(13786, "021bc59f-cef7-4f50-a608-f73a9f473f25"),
    ].join("\n");
    (mockExecPgrep as Mock).mockResolvedValue(lines);
    (mockReadProcCwd as Mock).mockImplementation((pid: number) => {
      if (pid === 13784 || pid === 13786) {
        return `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`;
      }
      return null;
    });

    const out = await enumerateDispatchProcesses();

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      pid: 13784,
      dispatchId: "021bc59f-cef7-4f50-a608-f73a9f473f25",
      cwd: `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    });
    expect(out[0].cmdline).toContain("script -q -f");
    expect(out[1]).toMatchObject({
      pid: 13786,
      dispatchId: "021bc59f-cef7-4f50-a608-f73a9f473f25",
    });
  });

  it("skips lines without an extractable danxbot-dispatch tag (untagged claude / dev sessions)", async () => {
    const lines = [
      `99001 claude  # dev's interactive session; no danxbot-dispatch tag`,
      TAGGED_CLAUDE_CHILD(13786, "5d4298e1-5888-4c13-88ee-4c192b65ff0f"),
      `99002 grep --color=auto danxbot-dispatch: /tmp/foo  # grepping for the tag is not a dispatch`,
    ].join("\n");
    (mockExecPgrep as Mock).mockResolvedValue(lines);

    const out = await enumerateDispatchProcesses();

    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(13786);
    expect(out[0].dispatchId).toBe("5d4298e1-5888-4c13-88ee-4c192b65ff0f");
  });

  it("returns an empty list when pgrep finds no matches (treats exit-1 as 'no matches')", async () => {
    // Some pgrep implementations resolve with empty stdout; others
    // throw with code 1. The OS seam normalises both to the
    // empty-string return — the contract is "no matches → []".
    (mockExecPgrep as Mock).mockResolvedValue("");

    const out = await enumerateDispatchProcesses();

    expect(out).toEqual([]);
  });
});

describe("filterByRepoCwd", () => {
  it("keeps only processes whose cwd is inside the repo localPath", () => {
    const procs = [
      { pid: 1, dispatchId: "a", cmdline: "", cwd: `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker` },
      { pid: 2, dispatchId: "b", cmdline: "", cwd: "/home/newms/web/gpt-manager/.danxbot/workspaces/issue-worker" },
      { pid: 3, dispatchId: "c", cmdline: "", cwd: null },
    ];

    const out = filterByRepoCwd(procs, REPO_LOCAL_PATH);

    expect(out.map((p) => p.pid)).toEqual([1]);
  });

  it("excludes cwd:null processes explicitly (conservative repo isolation — unattributable processes are NOT this repo's responsibility to reap)", () => {
    // Documenting the contract directly. A regression that flipped
    // the cwd:null check to "include" would silently start killing
    // every other repo's pre-fork dispatch process.
    const procs = [
      { pid: 1, dispatchId: "a", cmdline: "", cwd: null },
    ];

    const out = filterByRepoCwd(procs, REPO_LOCAL_PATH);

    expect(out).toEqual([]);
  });

  it("does NOT match a sibling repo whose path shares a prefix (e.g. /home/newms/web/danx vs /home/newms/web/danxbot)", () => {
    const procs = [
      // Sibling repo that happens to share a path prefix with our repo.
      // Without the trailing-separator guard a naive `startsWith` match
      // would falsely include this dispatch.
      { pid: 1, dispatchId: "a", cmdline: "", cwd: "/home/newms/web/danxbot-clone/.danxbot/workspaces/issue-worker" },
    ];

    const out = filterByRepoCwd(procs, "/home/newms/web/danxbot");

    expect(out).toEqual([]);
  });
});

describe("resolveRepoRoot — symlink realpath", () => {
  // Reviewer-flagged critical bug: <danxbot>/repos/<name> is a symlink
  // to the connected repo's host dir, /proc/<pid>/cwd returns the
  // realpath, and a naive prefix compare would silently filter every
  // legitimate process. resolveRepoRoot is the realpath hop that fixes
  // it. Cover the symlink branch + the ENOENT-fallback branch.
  let tempBase: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "resolve-repo-root-test-"));
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("resolves a symlinked repo path to its realpath so the prefix compare matches /proc/<pid>/cwd", () => {
    const realRepo = join(tempBase, "real-repo");
    mkdirSync(realRepo);
    const symlink = join(tempBase, "repos-symlink");
    symlinkSync(realRepo, symlink);

    expect(resolveRepoRoot(symlink)).toBe(realRepo);
  });

  it("falls back to the input path when realpath throws (e.g. ENOENT for an as-yet-uncreated path)", () => {
    const ghost = join(tempBase, "does-not-exist");
    expect(resolveRepoRoot(ghost)).toBe(ghost);
  });

  it("integration: reapOrphans correctly attributes a dispatch whose cwd is the symlink target when repoLocalPath is the symlink (would silently filter every process without realpath)", async () => {
    const realRepo = join(tempBase, "real-repo");
    mkdirSync(realRepo);
    const workspaceDir = join(realRepo, ".danxbot", "workspaces", "issue-worker");
    mkdirSync(workspaceDir, { recursive: true });
    const symlink = join(tempBase, "repos-symlink");
    symlinkSync(realRepo, symlink);

    const dispatchId = "aabbccdd-aabb-ccdd-eeff-001122334455";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(91000, dispatchId),
    );
    // `/proc/<pid>/cwd` returns the realpath (kernel-resolved). The
    // caller passes the symlink. Pre-fix the prefix compare would
    // miss and the orphan would never be reaped.
    (mockReadProcCwd as Mock).mockReturnValue(workspaceDir);
    (mockGetDispatchById as Mock).mockResolvedValue(null);
    (mockIsPidAlive as Mock).mockReturnValueOnce(false);

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: symlink, // pass the SYMLINK, not the realpath
    });

    // The orphan IS reaped — proves the realpath fix lands.
    expect(mockKillHostPid).toHaveBeenCalledWith(91000, "SIGTERM");
  });
});

describe("pickKillablePidPerDispatch", () => {
  it("selects the script-parent PID for host-mode dispatches (the one we SIGTERM to cascade SIGHUP to claude)", () => {
    const procs = [
      { pid: 13786, dispatchId: "abc", cmdline: "claude --dangerously-skip-permissions -- <!-- danxbot-dispatch:abc --> ...", cwd: null },
      { pid: 13784, dispatchId: "abc", cmdline: "script -q -f /tmp/danxbot-terminal-abc.log -c claude ...", cwd: null },
    ];

    const out = pickKillablePidPerDispatch(procs);

    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(13784);
    expect(out[0].cmdline).toContain("script -q -f");
  });

  it("returns the only entry per dispatchId for docker-mode dispatches (no script wrapper)", () => {
    const procs = [
      { pid: 7777, dispatchId: "abc", cmdline: "claude -p '<!-- danxbot-dispatch:abc --> ...'", cwd: null },
    ];

    const out = pickKillablePidPerDispatch(procs);

    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(7777);
  });

  it("preserves separate entries for distinct dispatchIds (regression test: a global-keyed dedupe would over-collapse)", () => {
    const procs = [
      { pid: 100, dispatchId: "aaa", cmdline: "script -q -f /tmp/a -c claude ... <!-- danxbot-dispatch:aaa -->", cwd: null },
      { pid: 200, dispatchId: "bbb", cmdline: "script -q -f /tmp/b -c claude ... <!-- danxbot-dispatch:bbb -->", cwd: null },
    ];

    const out = pickKillablePidPerDispatch(procs);

    expect(out.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("picks the script parent even when pgrep emits the claude child FIRST (order-independent rank within a dispatchId)", () => {
    // Reviewer-flagged: a prior single-pass single-Map implementation
    // could lose the parent if iteration ranked the child first. The
    // two-pass group-then-rank fix is order-independent.
    const procs = [
      { pid: 13786, dispatchId: "abc", cmdline: "claude --dangerously-skip-permissions -- <!-- danxbot-dispatch:abc -->", cwd: null },
      { pid: 13784, dispatchId: "abc", cmdline: "script -q -f /tmp/danxbot-terminal-abc.log -c claude --dangerously-skip-permissions -- <!-- danxbot-dispatch:abc -->", cwd: null },
    ];

    const out = pickKillablePidPerDispatch(procs);

    expect(out).toHaveLength(1);
    expect(out[0].pid).toBe(13784);
    expect(out[0].cmdline).toMatch(/^script\s+-q\s+-f/);
  });
});

describe("reapOrphans — kill paths", () => {
  it("SIGTERMs a process whose dispatch row is terminal (the May-7 orphan scenario)", async () => {
    const dispatchId = "5d4298e1-5888-4c13-88ee-4c192b65ff0f";
    (mockExecPgrep as Mock).mockResolvedValue(
      [
        TAGGED_SCRIPT_PARENT(28753, dispatchId),
        TAGGED_CLAUDE_CHILD(28755, dispatchId),
      ].join("\n"),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(
      makeRow({ id: dispatchId, status: "completed", hostPid: 28753 }),
    );
    // Process exits cleanly on SIGTERM (no SIGKILL needed).
    (mockIsPidAlive as Mock).mockReturnValueOnce(false);

    const result = await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    // SIGTERM hit the script-parent only — single signal per dispatch.
    expect(mockKillHostPid).toHaveBeenCalledTimes(1);
    expect(mockKillHostPid).toHaveBeenCalledWith(28753, "SIGTERM");
    expect(result.reaped).toEqual([
      expect.objectContaining({ pid: 28753, dispatchId }),
    ]);
  });

  it("SIGTERMs a process with NO DB row at all (orphan never tracked)", async () => {
    const dispatchId = "deadbeef-0000-0000-0000-000000000000";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(50000, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(null);
    (mockIsPidAlive as Mock).mockReturnValueOnce(false);

    const result = await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    expect(mockKillHostPid).toHaveBeenCalledWith(50000, "SIGTERM");
    expect(result.reaped[0].reason).toContain("no-row");
  });

  it("escalates to SIGKILL when SIGTERM fails to take down the process within the grace window", async () => {
    const dispatchId = "11111111-1111-1111-1111-111111111111";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(60000, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(null);
    // Process refuses to die — every isPidAlive poll returns true.
    (mockIsPidAlive as Mock).mockReturnValue(true);

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
      // Tiny grace + tiny poll so the test runs in milliseconds.
      graceMs: 30,
      pollIntervalMs: 5,
    });

    const signalsSent = (mockKillHostPid as Mock).mock.calls
      .filter((c) => c[0] === 60000)
      .map((c) => c[1]);
    expect(signalsSent).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("emits a system_errors event with the full cmdline + reason for every kill", async () => {
    const dispatchId = "22222222-2222-2222-2222-222222222222";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(70000, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(
      makeRow({ id: dispatchId, status: "failed" }),
    );
    (mockIsPidAlive as Mock).mockReturnValue(false);

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "orphan-reaper",
        severity: "error",
        repo: "danxbot",
        message: expect.stringContaining(dispatchId),
        details: expect.objectContaining({
          dispatchId,
          pid: 70000,
          cmdline: expect.stringContaining("danxbot-dispatch:"),
          reason: expect.stringContaining("terminal"),
        }),
      }),
    );
  });
});

describe("reapOrphans — leave-alone paths", () => {
  it("does NOT kill a healthy dispatch (non-terminal row + matching host_pid + alive process)", async () => {
    const dispatchId = "33333333-3333-3333-3333-333333333333";
    (mockExecPgrep as Mock).mockResolvedValue(
      [
        TAGGED_SCRIPT_PARENT(80000, dispatchId),
        TAGGED_CLAUDE_CHILD(80002, dispatchId),
      ].join("\n"),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(
      makeRow({ id: dispatchId, status: "running", hostPid: 80000 }),
    );

    const result = await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    expect(mockKillHostPid).not.toHaveBeenCalled();
    expect(result.healthy).toBe(1);
    expect(result.reaped).toEqual([]);
  });

  it("skips a process when getDispatchById throws AND emits a warn-level system_errors so the operator sees the gap", async () => {
    const dispatchId = "55555555-5555-5555-5555-555555555555";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(11000, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockRejectedValue(
      new Error("connection refused"),
    );

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    expect(mockKillHostPid).not.toHaveBeenCalled();
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "orphan-reaper",
        severity: "warn",
        repo: "danxbot",
        message: expect.stringContaining("DB read failed"),
        details: expect.objectContaining({
          dispatchId,
          pid: 11000,
          error: "connection refused",
        }),
      }),
    );
  });

  it("emits a second error-level system_errors when SIGTERM grace expires and SIGKILL escalation fires", async () => {
    const dispatchId = "66666666-6666-6666-6666-666666666666";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(60001, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(null);
    (mockIsPidAlive as Mock).mockReturnValue(true); // refuses to die

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
      graceMs: 20,
      pollIntervalMs: 5,
    });

    const errors = (mockRecordSystemError as Mock).mock.calls.map(
      (c) => c[0] as { severity: string; message: string },
    );
    // First: pre-kill "Reaped orphan ..." (severity error). Second:
    // SIGKILL escalation (severity error, "refused SIGTERM").
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(/Reaped orphan/);
    expect(errors[1].message).toMatch(/refused SIGTERM/);
    expect(errors[1].severity).toBe("error");
  });

  it("does NOT auto-kill on host_pid mismatch — emits warn-level system_errors instead (Phase 1's atomic stamp should prevent this; surface it for audit)", async () => {
    const dispatchId = "44444444-4444-4444-4444-444444444444";
    (mockExecPgrep as Mock).mockResolvedValue(
      TAGGED_SCRIPT_PARENT(90000, dispatchId),
    );
    (mockReadProcCwd as Mock).mockReturnValue(
      `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`,
    );
    (mockGetDispatchById as Mock).mockResolvedValue(
      // Row claims host_pid=12345 but the live process is 90000 — mismatch.
      makeRow({ id: dispatchId, status: "running", hostPid: 12345 }),
    );

    const result = await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    expect(mockKillHostPid).not.toHaveBeenCalled();
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "orphan-reaper",
        severity: "warn",
        message: expect.stringContaining("mismatched host_pid"),
      }),
    );
    expect(result.mismatched).toEqual([
      expect.objectContaining({ pid: 90000, dispatchId }),
    ]);
  });

  it("skips processes whose cwd belongs to a different repo (repo isolation across host-mode workers)", async () => {
    (mockExecPgrep as Mock).mockResolvedValue(
      [
        TAGGED_SCRIPT_PARENT(20001, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
        TAGGED_SCRIPT_PARENT(20002, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
      ].join("\n"),
    );
    (mockReadProcCwd as Mock).mockImplementation((pid: number) => {
      if (pid === 20001) {
        return `${REPO_LOCAL_PATH}/.danxbot/workspaces/issue-worker`;
      }
      // Sibling repo's dispatch — must NOT be touched.
      return "/home/newms/web/gpt-manager/.danxbot/workspaces/issue-worker";
    });
    (mockGetDispatchById as Mock).mockResolvedValue(null);
    (mockIsPidAlive as Mock).mockReturnValue(false);

    await reapOrphans({
      repoName: "danxbot",
      repoLocalPath: REPO_LOCAL_PATH,
    });

    // Only the in-repo orphan got killed. The sibling repo's dispatch
    // was filtered out before any kill consideration.
    expect(mockKillHostPid).toHaveBeenCalledTimes(1);
    expect(mockKillHostPid).toHaveBeenCalledWith(20001, "SIGTERM");
    expect(mockGetDispatchById).toHaveBeenCalledTimes(1);
    expect(mockGetDispatchById).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
  });
});
