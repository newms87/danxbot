/**
 * Integration test for the Phase 2c (DX-209) reattach pipeline.
 *
 * Covers the AC most tests cannot exercise: after `reattachOrResolveDispatches`
 * registers an alive PID, the dispatch is genuinely cancellable + status-
 * queryable through the SAME activeJobs registry that fresh-spawn dispatches
 * use.
 *
 * Layer 1 (free): mocks the DB layer, uses a real `sleep` child process for
 * the alive PID, real filesystem for the JSONL session file + per-dispatch
 * MCP settings file, real `SessionLogWatcher`, real `attachMonitoringStack`.
 * The integration validates the seam: dispatch core's `getActiveJob` +
 * `cancelJob` see the reattached row exactly like a freshly spawned job.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dispatch } from "../../dashboard/dispatches.js";

// --- Infrastructure mocks (not under test) ---

const mockFindNonTerminalDispatches = vi.fn();
const mockUpdateDispatch = vi.fn();
vi.mock("../../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: (...args: unknown[]) =>
    mockFindNonTerminalDispatches(...args),
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

vi.mock("../../dashboard/event-bus.js", () => ({
  eventBus: { publish: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

// `src/config.ts` reads required DB env vars at import time — bypass.
vi.mock("../../config.js", () => ({
  config: {
    isHost: false,
    dispatch: { agentTimeoutMs: 60_000 },
    logsDir: "/tmp/reattach-int-test-logs",
  },
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { reattachOrResolveDispatches } from "../../worker/reattach.js";
import { getActiveJob } from "../../dispatch/core.js";
import { cancelJob } from "../../agent/launcher.js";

// --- Fixtures ---

let tempDir: string;
let sleepChild: ChildProcess | null;
let exited: Promise<void> | null;

function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "int-row-1",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "c-1",
      cardName: "Card",
      cardUrl: "https://x",
      listId: "l-1",
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
    hostPid: 0, // overridden by fixture
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

function writeFixtures() {
  const sessionDir = join(tempDir, "session-dir");
  mkdirSync(sessionDir, { recursive: true });
  const jsonl = join(sessionDir, "session.jsonl");
  writeFileSync(jsonl, "");
  const settingsPath = join(tempDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        mcpServers: {
          danxbot: {
            command: "x",
            env: {
              DANXBOT_STOP_URL: "http://localhost:9300/api/stop/int-row-1",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return { jsonl, settingsPath };
}

beforeEach(() => {
  vi.clearAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), "reattach-int-test-"));
  sleepChild = null;
  exited = null;
  mockUpdateDispatch.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (sleepChild && !sleepChild.killed) {
    sleepChild.kill("SIGKILL");
  }
  if (exited) {
    await exited;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("DX-209 reattach lifecycle (integration)", () => {
  it("reattach + getActiveJob + cancelJob: an alive PID reattached at boot is cancellable through the worker's standard cancelJob path", { timeout: 15_000 }, async () => {
    // Arrange: real `sleep` child = alive PID we will reattach.
    sleepChild = spawn("sleep", ["30"], { stdio: "ignore" });
    expect(typeof sleepChild.pid).toBe("number");
    const pid = sleepChild.pid as number;
    exited = new Promise<void>((resolve) => {
      sleepChild!.once("exit", () => resolve());
    });

    const { jsonl, settingsPath } = writeFixtures();
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "int-row-1", hostPid: pid, jsonlPath: jsonl, mcpSettingsPath: settingsPath }),
    ]);

    // Act: reattach.
    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(result.reattached).toEqual(["int-row-1"]);

    // Assert (1): the row is queryable through getActiveJob — same path
    // /api/status uses.
    const job = getActiveJob("int-row-1");
    expect(job).toBeDefined();
    expect(job!.id).toBe("int-row-1");
    expect(job!.status).toBe("running");
    expect(job!.handle?.pid).toBe(pid);

    // Assert (2): cancelJob SIGTERMs the existing PID and the cleanup
    // chain finalizes the dispatch row. We assert the PID is no longer
    // alive (the OS-level proof) rather than `child.killed`, because the
    // signal is delivered via `process.kill(pid, sig)` from the host-PID
    // shim — that path does NOT flip the ChildProcess wrapper's
    // `.killed` flag (Node only sets that on `child.kill()`-routed
    // signals). The `exited` promise resolution + the post-await PID
    // probe are the ground-truth signals.
    await cancelJob(job!, "" /* no apiToken — putStatus is a no-op */);
    await exited;
    const { isPidAlive } = await import("../../agent/host-pid.js");
    expect(isPidAlive(pid)).toBe(false);

    // Cleanup ran → updateDispatch was called with terminal status.
    // (The reattach tracker's finalize is the writer; cancelJob status
    //  flips to "canceled" → tracker maps to "cancelled" via agent-cleanup.)
    const updates = mockUpdateDispatch.mock.calls.map((c) => c[0]);
    expect(updates).toContain("int-row-1");
    const terminalUpdate = mockUpdateDispatch.mock.calls.find(
      (c) => c[0] === "int-row-1" && c[1].status,
    );
    expect(terminalUpdate).toBeDefined();
    expect(["completed", "failed", "cancelled"]).toContain(
      terminalUpdate![1].status,
    );
  });

  it("reattach + dead PID: a non-alive PID is marked failed and never lands in activeJobs", async () => {
    // PID 999_999_999 is far above any realistic OS-assigned value.
    mockFindNonTerminalDispatches.mockResolvedValue([
      makeRow({ id: "int-dead-1", hostPid: 999_999_999 }),
    ]);

    const result = await reattachOrResolveDispatches("danxbot", {
      currentWorkerPort: 9300,
    });

    expect(result.orphaned).toEqual(["int-dead-1"]);
    expect(result.reattached).toEqual([]);
    expect(getActiveJob("int-dead-1")).toBeUndefined();
    expect(mockUpdateDispatch).toHaveBeenCalledWith(
      "int-dead-1",
      expect.objectContaining({ status: "failed" }),
    );
  });
});
