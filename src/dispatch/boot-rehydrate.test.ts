/**
 * Tests for `bootRehydrate` — DX-220 Phase 5 consolidated boot pass.
 *
 * Replaces the deleted `runStartupReattach` describe blocks from
 * pre-Phase-5 `src/poller/index.test.ts`. The per-verdict liveness
 * rules stay covered by `src/poller/dispatch-liveness-yaml.test.ts`;
 * this file pins the orchestration:
 *
 *   - Step 1 (dead-dispatch clearing): walks open YAML, alive stays,
 *     dead-pid / dead-ttl / cross-host clears via `clearDispatchAndWrite`.
 *   - Step 2 (TTL timer boot scan): `scanAndArmTtlTimers` is invoked.
 *   - Step 3 (triage timer boot scan): `scanAndArmTriageTimers` is
 *     invoked.
 *   - Per-card tolerance: corrupt YAML logs + the scan continues.
 *   - Missing open dir is a no-op (TTL + triage scans still run).
 *
 * Lives in its own file so the existing 49-test `scheduler.test.ts`
 * suite stays untouched — bootRehydrate's mock surface (loadLocal +
 * clearDispatchAndWrite + checkYamlDispatchLiveness) is wider than the
 * other scheduler entry points.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import type { Dispatch } from "../dashboard/dispatches.js";

// Mock the YAML loader so we control which dispatches each fixture
// reports. The real loader would walk the file but we want
// orchestration-level testing.
const loadLocalMock = vi.hoisted(() => vi.fn());
const clearDispatchAndWriteMock = vi.hoisted(() => vi.fn());
const isPidAliveMock = vi.hoisted(() => vi.fn());
const findNonTerminalMock = vi.hoisted(() => vi.fn());
const scanTriageMock = vi.hoisted(() => vi.fn());
const scanTtlMock = vi.hoisted(() => vi.fn());

vi.mock("../poller/yaml-lifecycle.js", () => ({
  loadLocal: loadLocalMock,
  clearDispatchAndWrite: clearDispatchAndWriteMock,
  findByExternalId: vi.fn(),
}));
vi.mock("../agent/host-pid.js", () => ({
  isPidAlive: isPidAliveMock,
}));
vi.mock("../dashboard/dispatches-db.js", () => ({
  findNonTerminalDispatches: findNonTerminalMock,
}));
vi.mock("./triage-timer.js", async () => {
  const actual =
    await vi.importActual<typeof import("./triage-timer.js")>("./triage-timer.js");
  return {
    ...actual,
    scanAndArmTriageTimers: scanTriageMock,
  };
});
vi.mock("./ttl-timer.js", async () => {
  const actual =
    await vi.importActual<typeof import("./ttl-timer.js")>("./ttl-timer.js");
  return {
    ...actual,
    scanAndArmTtlTimers: scanTtlMock,
  };
});

import { bootRehydrate } from "./scheduler.js";

function makeRepo(localPath: string): RepoContext {
  return {
    name: "test-repo",
    url: "",
    localPath,
    hostPath: localPath,
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      reviewListId: "",
      todoListId: "",
      inProgressListId: "",
      needsHelpListId: "",
      doneListId: "",
      cancelledListId: "",
      actionItemsListId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
      blockedLabelId: "",
      requiresHumanLabelId: "",
    },
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: { host: "", port: 0, user: "", password: "", database: "", enabled: false },
    githubToken: "",
    trelloEnabled: false,
    workerPort: 0,
    issuePrefix: "DX",
  };
}

function makeIssueWithDispatch(opts: {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
  ttlSeconds: number;
}): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id: opts.id,
    external_id: `ext-${opts.id}`,
    parent_id: null,
    children: [],
    dispatch: {
      id: `dispatch-${opts.id}`,
      pid: opts.pid,
      host: opts.host,
      kind: "work",
      started_at: opts.startedAt,
      ttl_seconds: opts.ttlSeconds,
    },
    status: "In Progress",
    type: "Feature",
    title: opts.id,
    description: "",
    priority: 3,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: "agent",
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    history: [],
  } as unknown as Issue;
}

const dummyReconcile = vi.fn().mockResolvedValue({});
const dummyTtlDeps = {
  isPidAlive: vi.fn(),
  reconcile: dummyReconcile,
  clearDispatch: vi.fn(),
  loadIssue: vi.fn(),
};

describe("bootRehydrate", () => {
  let tmpRoot: string;
  let openDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = mkdtempSync(resolve(tmpdir(), "boot-rehydrate-"));
    openDir = resolve(tmpRoot, ".danxbot", "issues", "open");
    mkdirSync(openDir, { recursive: true });
    scanTtlMock.mockResolvedValue({ armed: 0, skipped: 0 });
    scanTriageMock.mockReturnValue(undefined);
    findNonTerminalMock.mockResolvedValue([]);
  });

  it("Step 1: alive dispatch stays, dead-pid / cross-host / dead-ttl are cleared", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, "DX-2.yml"), "");
    writeFileSync(resolve(openDir, "DX-3.yml"), "");
    writeFileSync(resolve(openDir, "DX-4.yml"), "");

    // Alive: same host, PID alive, TTL fresh.
    const alive = makeIssueWithDispatch({
      id: "DX-1",
      pid: 100,
      host: "local-host",
      startedAt: new Date().toISOString(),
      ttlSeconds: 7200,
    });
    // Dead-PID: same host, PID dead.
    const deadPid = makeIssueWithDispatch({
      id: "DX-2",
      pid: 200,
      host: "local-host",
      startedAt: new Date().toISOString(),
      ttlSeconds: 7200,
    });
    // Cross-host.
    const crossHost = makeIssueWithDispatch({
      id: "DX-3",
      pid: 300,
      host: "OTHER-HOST",
      startedAt: new Date().toISOString(),
      ttlSeconds: 7200,
    });
    // Dead-TTL: started_at long ago, ttl exceeded.
    const deadTtl = makeIssueWithDispatch({
      id: "DX-4",
      pid: 400,
      host: "local-host",
      startedAt: new Date(Date.now() - 9000 * 1000).toISOString(),
      ttlSeconds: 60,
    });

    loadLocalMock.mockImplementation(async (_root: string, stem: string) => {
      if (stem === "DX-1") return alive;
      if (stem === "DX-2") return deadPid;
      if (stem === "DX-3") return crossHost;
      if (stem === "DX-4") return deadTtl;
      return null;
    });
    isPidAliveMock.mockImplementation((pid: number) => pid === 100);
    clearDispatchAndWriteMock.mockResolvedValue(undefined);

    // Spy on the test's hostname needs to match what `os.hostname()` returns.
    // The bootRehydrate uses osHostname() internally; we make `alive` claim
    // that hostname.
    const realHostname = await import("node:os").then((m) => m.hostname());
    alive.dispatch!.host = realHostname;
    deadPid.dispatch!.host = realHostname;
    deadTtl.dispatch!.host = realHostname;

    const result = await bootRehydrate({
      repo: makeRepo(tmpRoot),
      reconcile: dummyReconcile as never,
      ttlMs: 7_200_000,
      ttlTimerDeps: dummyTtlDeps as never,
    });

    expect(result.alive).toBe(1);
    expect(result.cleared).toBe(3);
    expect(clearDispatchAndWriteMock).toHaveBeenCalledTimes(3);
    const clearedIds = clearDispatchAndWriteMock.mock.calls
      .map((c) => (c[1] as Issue).id)
      .sort();
    expect(clearedIds).toEqual(["DX-2", "DX-3", "DX-4"]);
  });

  it("Step 2 + 3: invokes scanAndArmTtlTimers and scanAndArmTriageTimers", async () => {
    scanTtlMock.mockResolvedValue({ armed: 5, skipped: 2 });

    const result = await bootRehydrate({
      repo: makeRepo(tmpRoot),
      reconcile: dummyReconcile as never,
      ttlMs: 7_200_000,
      ttlTimerDeps: dummyTtlDeps as never,
    });

    expect(scanTtlMock).toHaveBeenCalledTimes(1);
    expect(scanTriageMock).toHaveBeenCalledTimes(1);
    expect(result.ttlArmed).toBe(5);
  });

  it("corrupt YAML during loadLocal is logged + skipped — scan continues", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, "DX-2.yml"), "");
    const good = makeIssueWithDispatch({
      id: "DX-1",
      pid: 100,
      host: (await import("node:os")).hostname(),
      startedAt: new Date().toISOString(),
      ttlSeconds: 7200,
    });
    loadLocalMock.mockImplementation(async (_root: string, stem: string) => {
      if (stem === "DX-1") return good;
      if (stem === "DX-2") throw new Error("malformed YAML");
      return null;
    });
    isPidAliveMock.mockReturnValue(true);

    const result = await bootRehydrate({
      repo: makeRepo(tmpRoot),
      reconcile: dummyReconcile as never,
      ttlMs: 7_200_000,
      ttlTimerDeps: dummyTtlDeps as never,
    });

    // Good entry processed (alive), corrupt entry skipped without throwing.
    expect(result.alive).toBe(1);
    expect(result.cleared).toBe(0);
  });

  it("missing open dir is a no-op for Step 1 but Step 2 + 3 still run", async () => {
    rmSync(openDir, { recursive: true, force: true });
    scanTtlMock.mockResolvedValue({ armed: 2, skipped: 0 });

    const result = await bootRehydrate({
      repo: makeRepo(tmpRoot),
      reconcile: dummyReconcile as never,
      ttlMs: 7_200_000,
      ttlTimerDeps: dummyTtlDeps as never,
    });

    expect(result.alive).toBe(0);
    expect(result.cleared).toBe(0);
    expect(result.ttlArmed).toBe(2);
    expect(scanTtlMock).toHaveBeenCalledTimes(1);
    expect(scanTriageMock).toHaveBeenCalledTimes(1);
  });
});

// scanAndArmTtlTimers tests live in src/dispatch/ttl-timer.test.ts
// — colocated with the module under test, which avoids the
// scheduler-test mock of `./ttl-timer.js` interfering with the unit.
