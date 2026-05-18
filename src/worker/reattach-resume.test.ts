/**
 * DX-655 — disk re-verify gate in `attemptAutoResume`.
 *
 * The boot scan's `findInProgressIssueByDispatchId` reads `dbListOpenIssues`
 * which can lag the on-disk YAML by up to the 5s chokidar mirror debounce.
 * Inside that window an agent that has already stamped a terminal field on
 * disk (`blocked.at`, `completed_at`, `cancelled_at`, `requires_human`)
 * still appears In Progress in the DB — pre-DX-655 the auto-resume path
 * re-launched the terminal card on every worker restart, producing the
 * DX-655 dispatch loop. This test pins the disk-re-verify gate: when the
 * on-disk derived status is NOT `In Progress`, `attemptAutoResume` MUST
 * refuse with `refusalReason: "card-not-in-progress-on-disk"` and MUST NOT
 * call `dispatch()`.
 *
 * Layer 1 — no DB, no claude, no FS outside a tmpdir.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockDispatch = vi.fn();
const mockUpdateDispatch = vi.fn();
const mockFindInProgress = vi.fn();
const mockReadSettings = vi.fn();

vi.mock("../dispatch/core.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));
vi.mock("../dashboard/dispatches-db.js", () => ({
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));
vi.mock("../poller/local-issues.js", () => ({
  findInProgressIssueByDispatchId: (...args: unknown[]) =>
    mockFindInProgress(...args),
}));
vi.mock("../settings-file.js", () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
}));
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { attemptAutoResume } from "./reattach-resume.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

let tempRepoRoot: string;

function makeRepo(): RepoContext {
  return {
    name: "test-repo",
    localPath: tempRepoRoot,
    hostPath: tempRepoRoot,
    url: "git@example.com:test/test.git",
    runtime: "local",
    issuePrefix: "TX",
    config: {} as never,
    trello: {} as never,
    composeFile: null,
    docs: [],
  } as unknown as RepoContext;
}

function makeRow(): Dispatch {
  return {
    id: "row-1",
    repoName: "test-repo",
    trigger: "trello",
    triggerMetadata: {},
    sessionUuid: "session-uuid-1",
    jsonlPath: "/tmp/fake.jsonl",
    status: "running",
    summary: null,
    workspace: "issue-worker",
    agentName: "phil",
    issueId: "TX-100",
    hostPid: 9999,
    pidTerminatedAt: null,
    completedAt: null,
    parentJobId: null,
    createdAt: Date.now(),
  } as unknown as Dispatch;
}

function makeInProgressIssue(): Issue {
  return {
    schema_version: 11,
    tracker: "memory",
    id: "TX-100",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: {
      id: "row-1",
      pid: 9999,
      host: "test",
      kind: "work",
      started_at: new Date().toISOString(),
      ttl_seconds: 7200,
    },
    status: "In Progress",
    type: "Feature",
    title: "Test card",
    description: "Test",
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
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: "phil",
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    db_updated_at: new Date().toISOString(),
    archived_at: null,
    ready_at: new Date().toISOString(),
    completed_at: null,
    cancelled_at: null,
    list_name: "In Progress",
    priority: 3,
  } as unknown as Issue;
}

function writeIssueYaml(id: string, blockedAt: string | null): void {
  const dir = join(tempRepoRoot, ".danxbot", "issues", "open");
  mkdirSync(dir, { recursive: true });
  const blockedBlock =
    blockedAt === null
      ? "blocked: null"
      : `blocked:\n  reason: "test block"\n  at: ${blockedAt}`;
  const yaml = `schema_version: 11
tracker: memory
id: ${id}
external_id: ""
parent_id: null
children: []
dispatch:
  id: row-1
  pid: 9999
  host: test
  kind: work
  started_at: 2026-05-18T16:00:00Z
  ttl_seconds: 7200
status: In Progress
type: Feature
title: "Test card"
description: |-
  Test description.
priority: 3
triage:
  expires_at: ""
  reassess_hint: ""
  last_status: ""
  last_explain: ""
  ice:
    total: 0
    i: 0
    c: 0
    e: 0
  history: []
ac: []
comments: []
history: []
retro:
  good: ""
  bad: ""
  action_item_ids: []
  commits: []
assigned_agent: phil
waiting_on: null
${blockedBlock}
requires_human: null
conflict_on: []
effort_level: null
db_updated_at: 2026-05-18T16:00:00Z
archived_at: null
ready_at: 2026-05-18T15:00:00Z
completed_at: null
cancelled_at: null
list_name: "In Progress"
`;
  writeFileSync(join(dir, `${id}.yml`), yaml);
}

beforeEach(() => {
  tempRepoRoot = mkdtempSync(join(tmpdir(), "reattach-resume-test-"));
  mockDispatch.mockReset();
  mockUpdateDispatch.mockReset();
  mockFindInProgress.mockReset();
  mockReadSettings.mockReset();
});

afterEach(() => {
  rmSync(tempRepoRoot, { recursive: true, force: true });
});

describe("attemptAutoResume — disk re-verify gate (DX-655)", () => {
  it("refuses when on-disk YAML has blocked.at populated (stale DB shows In Progress)", async () => {
    // DB-stale: findInProgressIssueByDispatchId returns the issue as
    // In Progress (chokidar mirror not yet landed).
    mockFindInProgress.mockResolvedValue(makeInProgressIssue());
    mockReadSettings.mockReturnValue({ agents: { phil: { bio: "" } } });
    // Disk truth: blocked.at populated.
    writeIssueYaml("TX-100", "2026-05-18T16:02:00Z");

    const result = await attemptAutoResume(makeRow(), makeRepo());

    expect(result.resumed).toBe(false);
    expect(result.refusalReason).toBe("card-not-in-progress-on-disk");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateDispatch).not.toHaveBeenCalled();
  });

  it("proceeds (does not short-circuit on disk gate) when on-disk YAML is genuinely In Progress", async () => {
    mockFindInProgress.mockResolvedValue(makeInProgressIssue());
    mockReadSettings.mockReturnValue({ agents: { phil: { bio: "" } } });
    mockDispatch.mockResolvedValue({ dispatchId: "child-1" });
    mockUpdateDispatch.mockResolvedValue(undefined);
    writeIssueYaml("TX-100", null);

    const result = await attemptAutoResume(makeRow(), makeRepo());

    expect(result.resumed).toBe(true);
    expect(result.childDispatchId).toBe("child-1");
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});
