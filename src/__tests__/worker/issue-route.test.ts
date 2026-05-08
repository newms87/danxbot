/**
 * Unit + integration tests for the danx_issue_save / danx_issue_create
 * worker handlers (Phase 3 of tracker-agnostic-agents — Trello wsb4TVNT).
 *
 * Spins up a real `node:http` server bound to a random port for each
 * test, registers `/api/issue-save/:id` + `/api/issue-create/:id`, then
 * issues real `fetch` calls against the loopback address. The MemoryTracker
 * stands in for a real IssueTracker — it implements the full interface
 * deterministically and supports `failNextWrite` for the
 * tracker-error-isolation tests that AC #2 requires.
 *
 * Each test gets a fresh tmpdir for `repo.localPath`, so YAML writes do
 * not collide across tests and `_drainAsyncWorkForTesting` reliably
 * settles the per-issue mutex map between cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import {
  _drainAsyncWorkForTesting,
  _resetForTesting,
  appendDiffEntries,
  handleIssueCreate,
  handleIssueSave,
  syncTrackedIssueOnComplete,
  type IssueRouteDeps,
} from "../../worker/issue-route.js";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import {
  ensureIssuesDirs,
  issuePath,
} from "../../poller/yaml-lifecycle.js";
import {
  createEmptyIssue,
  serializeIssue,
} from "../../issue-tracker/yaml.js";
import type { Issue } from "../../issue-tracker/interface.js";
import type { RepoContext } from "../../types.js";

interface TestHarness {
  url: string;
  tracker: MemoryTracker;
  repo: RepoContext;
  recordedErrors: Array<{ dispatchId: string; message: string }>;
  recordedSystemErrors: string[];
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestHarness> {
  const tracker = new MemoryTracker();
  const repoLocalPath = mkdtempSync(join(tmpdir(), "danxbot-issue-route-"));
  ensureIssuesDirs(repoLocalPath);
  const recordedErrors: Array<{ dispatchId: string; message: string }> = [];
  const recordedSystemErrors: string[] = [];
  const deps: IssueRouteDeps = {
    tracker,
    recordError: async (dispatchId, message) => {
      recordedErrors.push({ dispatchId, message });
    },
    recordSystemError: (msg) => {
      recordedSystemErrors.push(msg);
    },
  };

  const repo: RepoContext = {
    name: `test-${Math.random().toString(36).slice(2, 10)}`,
    url: "https://example.invalid/repo",
    localPath: repoLocalPath,
    workerPort: 0,
    githubToken: "",
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      reviewListId: "",
      todoListId: "",
      inProgressListId: "",
      needsHelpListId: "",
      needsApprovalListId: "",
      doneListId: "",
      cancelledListId: "",
      actionItemsListId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
      needsApprovalLabelId: "",
      blockedLabelId: "",
    },
    trelloEnabled: false,
    slack: {
      enabled: false,
      botToken: "",
      appToken: "",
      channelId: "",
    },
    db: {
      host: "",
      port: 0,
      user: "",
      password: "",
      database: "",
      enabled: false,
    },
    issuePrefix: "ISS",
  };

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const saveMatch = url.match(/^\/api\/issue-save\/([^/?]+)/);
      const createMatch = url.match(/^\/api\/issue-create\/([^/?]+)/);
      if (req.method === "POST" && saveMatch) {
        await handleIssueSave(req, res, saveMatch[1], repo, deps);
        return;
      }
      if (req.method === "POST" && createMatch) {
        await handleIssueCreate(req, res, createMatch[1], repo, deps);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    tracker,
    repo,
    recordedErrors,
    recordedSystemErrors,
    close: async () => {
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      rmSync(repoLocalPath, { recursive: true, force: true });
    },
  };
}

function writeYaml(repoLocalPath: string, issue: Issue, state: "open" | "closed" = "open"): string {
  // Filename basename is the internal `id`. external_id is just one of
  // the values inside the YAML body and may be empty.
  const path = issuePath(repoLocalPath, issue.id, state);
  ensureIssuesDirs(repoLocalPath);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

function readYaml(repoLocalPath: string, id: string, state: "open" | "closed" = "open"): string {
  return readFileSync(issuePath(repoLocalPath, id, state), "utf-8");
}

describe("handleIssueSave (POST /api/issue-save/:dispatchId)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("returns saved:true synchronously and runs sync in the background", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-1",
        external_id: "card-1",
        title: "T",
      }),
      tracker: "memory",
    };
    // Seed the tracker so syncIssue has something to read.
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "stale-remote",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    // The seeded card has external_id = "mem-1"; rename our local issue to match.
    issue.external_id = "mem-1";
    issue.title = "fresh-local";
    writeYaml(h.repo.localPath, issue);

    const res = await fetch(`${h.url}/api/issue-save/dispatch-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();
    // syncIssue should have called updateCard with the fresh title and id.
    const updates = h.tracker.getRequestLog().filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(1);
    expect(updates[0].details).toEqual({ patch: { title: "fresh-local", id: "ISS-1" } });
  });

  it("returns saved:false with errors on schema-validation failure", async () => {
    const path = issuePath(h.repo.localPath, "ISS-2", "open");
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(path, "schema_version: 3\nbroken: true\n");

    const res = await fetch(`${h.url}/api/issue-save/dispatch-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-2" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toContain("missing required field");
  });

  it("returns saved:false when the YAML file is missing", async () => {
    const res = await fetch(`${h.url}/api/issue-save/dispatch-3`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-3" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(false);
    expect(body.errors[0]).toMatch(/No YAML file found at \.danxbot\/issues/);
  });

  it("returns saved:false (HTTP 200) when id is missing — agent-recoverable failure", async () => {
    const res = await fetch(`${h.url}/api/issue-save/dispatch-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(false);
    expect(body.errors[0]).toContain("id");
  });

  it("returns HTTP 400 only for malformed JSON body (network-level failure)", async () => {
    const res = await fetch(`${h.url}/api/issue-save/dispatch-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.saved).toBe(false);
  });

  it("AC #2: tracker errors NEVER surface to the agent — saved:true returned regardless", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-4",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote-title",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-4", external_id: "mem-1", title: "local-title" }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    h.tracker.failNextWrite(new Error("simulated 503 from tracker"));

    const res = await fetch(`${h.url}/api/issue-save/dispatch-fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-4" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();

    expect(h.recordedErrors).toHaveLength(1);
    expect(h.recordedErrors[0].dispatchId).toBe("dispatch-fail");
    expect(h.recordedErrors[0].message).toContain("simulated 503 from tracker");
    expect(h.recordedErrors[0].message).toContain("mem-1");
  });

  it("DX-134 Phase 4: tracker errors fire recordSystemError for the dashboard banner", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-44",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote-title",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-44", external_id: "mem-1", title: "local-title" }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    h.tracker.failNextWrite(new Error("simulated 401 from tracker"));

    const res = await fetch(`${h.url}/api/issue-save/dispatch-banner-fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-44" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();

    // recordError wires the per-dispatch row's `error` column. The new
    // recordSystemError wire (DX-134 Phase 4) wires the cross-dispatch
    // dashboard banner. The runSync catch must fire BOTH — deletion of
    // the fireAndForgetSystemError call would regress the operator
    // surface even though recordError still works.
    expect(h.recordedSystemErrors.length).toBeGreaterThanOrEqual(1);
    const systemMsg = h.recordedSystemErrors.find((m) =>
      m.includes("async sync failed"),
    );
    expect(systemMsg, "expected 'async sync failed' in recordSystemError").toBeDefined();
    expect(systemMsg).toContain("mem-1");
    expect(systemMsg).toContain("simulated 401 from tracker");
  });

  it("AC #5: serializes concurrent saves on the same id", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-5",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });

    // Mutex is observable when:
    //   1. Save #1 reads file ("first"), returns saved:true, kicks off sync #1.
    //   2. Save #2 reads file ("second"), returns saved:true, kicks off sync #2.
    //   3. Both syncs queue on the same `issueLocks` entry; sync #2 waits.
    //   4. Drain → tracker sees updateCard("first") then updateCard("second").
    //
    // To make step 1/2 deterministic, await each fetch (the handler has
    // returned by then so the in-handler file read already captured the
    // current title) BEFORE mutating the file for the next save. The two
    // sync tasks are still racing once both are queued — the mutex is
    // what guarantees their ORDER in the request log.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-5", external_id: "mem-1", title: "first" }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);
    const r1 = await fetch(`${h.url}/api/issue-save/dispatch-c1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-5" }),
    });
    expect(await r1.json()).toEqual({ saved: true });

    issue.title = "second";
    writeYaml(h.repo.localPath, issue);
    const r2 = await fetch(`${h.url}/api/issue-save/dispatch-c2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-5" }),
    });
    expect(await r2.json()).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();

    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    // Two saves, two updateCard calls. Order matters: serialized.
    expect(updates.map((u) => u.details)).toEqual([
      { patch: { title: "first", id: "ISS-5" } },
      { patch: { title: "second", id: "ISS-5" } },
    ]);
  });

  it("AC #7: saved status Done moves YAML from open/ to closed/ — idempotent", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-6",
      parent_id: null,
      children: [],
      status: "Done",
      type: "Feature",
      title: "done-card",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-6",
        external_id: "mem-1",
        status: "Done",
        title: "done-card",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    const res = await fetch(`${h.url}/api/issue-save/dispatch-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-6" }),
    });
    expect(await res.json()).toEqual({ saved: true });
    await _drainAsyncWorkForTesting();

    expect(existsSync(issuePath(h.repo.localPath, "ISS-6", "open"))).toBe(false);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-6", "closed"))).toBe(true);

    // Idempotent re-save: load from closed, no further open-side artifacts.
    const res2 = await fetch(`${h.url}/api/issue-save/dispatch-done-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-6" }),
    });
    expect(await res2.json()).toEqual({ saved: true });
    await _drainAsyncWorkForTesting();
    expect(existsSync(issuePath(h.repo.localPath, "ISS-6", "open"))).toBe(false);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-6", "closed"))).toBe(true);
  });

  it("Cancelled status also triggers open→closed move", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-7",
      parent_id: null,
      children: [],
      status: "Cancelled",
      type: "Feature",
      title: "cancelled-card",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-7",
        external_id: "mem-1",
        status: "Cancelled",
        title: "cancelled-card",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    const res = await fetch(`${h.url}/api/issue-save/dispatch-x`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-7" }),
    });
    expect(await res.json()).toEqual({ saved: true });
    await _drainAsyncWorkForTesting();
    expect(existsSync(issuePath(h.repo.localPath, "ISS-7", "open"))).toBe(false);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-7", "closed"))).toBe(true);
  });

  it("AC #5: queue is NOT poisoned when the FIRST sync fails — second still runs", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-8",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-8", external_id: "mem-1", title: "first" }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);
    h.tracker.failNextWrite(new Error("first sync explodes"));
    await fetch(`${h.url}/api/issue-save/dispatch-fail-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-8" }),
    });

    issue.title = "second";
    writeYaml(h.repo.localPath, issue);
    await fetch(`${h.url}/api/issue-save/dispatch-fail-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-8" }),
    });

    await _drainAsyncWorkForTesting();

    // First failure recorded against dispatch-fail-1 only.
    expect(h.recordedErrors).toHaveLength(1);
    expect(h.recordedErrors[0].dispatchId).toBe("dispatch-fail-1");
    // Second sync still ran — exactly one updateCard for "second".
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(1);
    expect(updates[0].details).toEqual({ patch: { title: "second", id: "ISS-8" } });
  });

  it("AC #5: true-concurrency Promise.all with same content — both saves complete, no drops", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-9",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-9", external_id: "mem-1", title: "concurrent" }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    const [r1, r2] = await Promise.all([
      fetch(`${h.url}/api/issue-save/dispatch-pa-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "ISS-9" }),
      }),
      fetch(`${h.url}/api/issue-save/dispatch-pa-2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "ISS-9" }),
      }),
    ]);
    expect(await r1.json()).toEqual({ saved: true });
    expect(await r2.json()).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();

    // Both reads saw the same content; the second save is idempotent
    // (no diff vs tracker after the first ran). Important guarantee:
    // exactly one updateCard, and the request log contains exactly two
    // mutex-serialized syncs (each producing their own getCard +
    // getComments pair).
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(1);
  });

  it("returns 400 on malformed JSON body (network-level failure)", async () => {
    const res = await fetch(`${h.url}/api/issue-save/dispatch-malformed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json {",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.saved).toBe(false);
  });

  it("non-terminal status keeps file in open/", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-10",
      parent_id: null,
      children: [],
      status: "In Progress",
      type: "Feature",
      title: "wip",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-10",
        external_id: "mem-1",
        status: "In Progress",
        title: "wip",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-y`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-10" }),
    });
    await _drainAsyncWorkForTesting();
    expect(existsSync(issuePath(h.repo.localPath, "ISS-10", "open"))).toBe(true);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-10", "closed"))).toBe(false);
  });

  it("status: 'Needs Approval' keeps file in open/ (Phase 1 of auto-triage epic)", async () => {
    // Needs Approval is a non-dispatchable, non-terminal parking status —
    // distinct from Blocked. It must NOT trigger the open→closed move
    // (which is reserved for Done / Cancelled). Pin the contract here so a
    // future regression that adds Needs Approval to the terminal set gets
    // caught.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-77",
        external_id: "",
        title: "Awaiting design approval",
      }),
      tracker: "memory",
      status: "Needs Approval",
    };
    writeYaml(h.repo.localPath, issue);

    const res = await fetch(`${h.url}/api/issue-save/dispatch-na`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-77" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();
    expect(existsSync(issuePath(h.repo.localPath, "ISS-77", "open"))).toBe(true);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-77", "closed"))).toBe(false);
    const persisted = readYaml(h.repo.localPath, "ISS-77");
    expect(persisted).toContain("status: Needs Approval");
  });

  it("forces status to ToDo on save when waiting_on is non-null, regardless of agent-written status", async () => {
    // Worker contract: `waiting_on != null` and `status != "ToDo"` is a
    // category error. The worker silently normalizes status → ToDo before
    // persisting, before the tracker push, and before the open/closed
    // file move. Agents must set `waiting_on` only — they don't separately
    // move status. Status "Blocked" (the renamed-from-Needs-Help self-block
    // status) is incompatible with a non-null waiting_on; the worker
    // resolves the conflict by forcing ToDo.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-50",
        external_id: "",
        title: "Waiting on normalize test",
      }),
      tracker: "memory",
      status: "In Progress",
      waiting_on: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    writeYaml(h.repo.localPath, issue);

    const res = await fetch(`${h.url}/api/issue-save/dispatch-blk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-50" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });

    await _drainAsyncWorkForTesting();
    const persisted = readYaml(h.repo.localPath, "ISS-50");
    expect(persisted).toContain("status: ToDo");
    expect(persisted).not.toContain("status: In Progress");
    // File stays in `open/` (ToDo is non-terminal).
    expect(existsSync(issuePath(h.repo.localPath, "ISS-50", "open"))).toBe(true);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-50", "closed"))).toBe(false);
  });

  it("ISS-92 Phase 2: clears dispatch on Done save (terminal status)", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9201",
        external_id: "",
        title: "Done with dispatch",
      }),
      tracker: "memory",
      status: "Done",
      dispatch: {
        id: "dispatch-uuid-1",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-9201" }),
    });
    await _drainAsyncWorkForTesting();

    // Done → file moved to closed/. Dispatch must be null in the
    // persisted file so the next reattach pass doesn't see a phantom.
    const persisted = readYaml(h.repo.localPath, "ISS-9201", "closed");
    expect(persisted).toContain("dispatch: null");
    expect(persisted).not.toContain("dispatch-uuid-1");
  });

  it("ISS-92 Phase 2: clears dispatch on Cancelled save (terminal status)", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9202",
        external_id: "",
        title: "Cancelled with dispatch",
      }),
      tracker: "memory",
      status: "Cancelled",
      dispatch: {
        id: "dispatch-uuid-2",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-cancelled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-9202" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-9202", "closed");
    expect(persisted).toContain("dispatch: null");
  });

  it("ISS-92 Phase 2: clears dispatch on Blocked save (file stays in open/)", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9203",
        external_id: "",
        title: "Blocked with dispatch",
      }),
      tracker: "memory",
      status: "Blocked",
      blocked: {
        reason: "agent self-block reason",
        timestamp: "2026-05-07T12:00:00.000Z",
      },
      dispatch: {
        id: "dispatch-uuid-3",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-nh-clr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-9203" }),
    });
    await _drainAsyncWorkForTesting();

    // Blocked is non-terminal for the file move (stays in open/) but
    // is terminal-for-session — dispatch clears.
    expect(existsSync(issuePath(h.repo.localPath, "ISS-9203", "open"))).toBe(true);
    const persisted = readYaml(h.repo.localPath, "ISS-9203");
    expect(persisted).toContain("dispatch: null");
  });

  it("ISS-92 Phase 2: clears dispatch on Blocked save (status normalizes to ToDo)", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9204",
        external_id: "",
        title: "Blocked with dispatch",
      }),
      tracker: "memory",
      // Agent set status: ToDo with blocked!=null. Worker keeps status as
      // ToDo (forceBlockedToToDo) AND clears dispatch.
      status: "ToDo",
      waiting_on: {
        reason: "waiting on ISS-99",
        timestamp: "2026-05-07T12:00:00.000Z",
        by: ["ISS-99"],
      },
      dispatch: {
        id: "dispatch-uuid-4",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-blk-clr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-9204" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-9204");
    expect(persisted).toContain("dispatch: null");
    expect(persisted).toContain("status: ToDo");
  });

  it("ISS-92 Phase 2: PRESERVES dispatch on mid-session In Progress save", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9205",
        external_id: "",
        title: "Mid-session save",
      }),
      tracker: "memory",
      status: "In Progress",
      blocked: null,
    waiting_on: null,
      dispatch: {
        id: "dispatch-uuid-5",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-mid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-9205" }),
    });
    await _drainAsyncWorkForTesting();

    // Mid-session In Progress save MUST keep the dispatch{} block.
    // The reattach pass + per-tick liveness scan rely on it.
    const persisted = readYaml(h.repo.localPath, "ISS-9205");
    expect(persisted).not.toContain("dispatch: null");
    expect(persisted).toContain("dispatch-uuid-5");
    expect(persisted).toContain("pid: 9999");
  });

  it("preserves status when blocked is null (no normalization)", async () => {
    // Sanity: forceBlockedToToDo is a no-op when blocked is null. A
    // legitimate Blocked save still persists with status: Blocked.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-51",
        external_id: "",
        title: "Real Blocked",
      }),
      tracker: "memory",
      status: "Blocked",
      blocked: null,
    waiting_on: null,
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-nh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-51" }),
    });
    await _drainAsyncWorkForTesting();
    const persisted = readYaml(h.repo.localPath, "ISS-51");
    expect(persisted).toContain("status: Blocked");
  });
});

describe("handleIssueCreate (POST /api/issue-create/:dispatchId)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("AC #3: creates remote card, stamps ids, renames file to <id>.yml", async () => {
    const draft: Issue = {
      ...createEmptyIssue({ id: "", external_id: "", title: "new feature" }),
      tracker: "memory",
      ac: [{ check_item_id: "", title: "AC1", checked: false }],
    };
    const draftPath = issuePath(h.repo.localPath, "new-feature", "open");
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(draftPath, serializeIssue(draft));

    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "new-feature" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.id).toBe("ISS-1");
    expect(body.external_id).toBe("mem-1");

    expect(existsSync(draftPath)).toBe(false);
    const stampedPath = issuePath(h.repo.localPath, "ISS-1", "open");
    expect(existsSync(stampedPath)).toBe(true);
    const stamped = readYaml(h.repo.localPath, "ISS-1");
    expect(stamped).toContain("id: ISS-1");
    expect(stamped).toContain("external_id: mem-1");
    expect(stamped).toContain("check_item_id: chk-");
  });

  it("auto-fills children: [] when the draft YAML omits the field; tolerates legacy phases: [] (ISS-81)", async () => {
    // The strict v3 validator requires `children`. Drafts written by
    // skill prose almost never include it (children get populated post-
    // create by the danx-epic-link skill on epics, never on the create
    // call itself). The handler must auto-fill an empty list before
    // running the strict parse — otherwise every create round-trips
    // back as a validation failure.
    //
    // Also exercises ISS-81 empty-phases tolerance: pre-ISS-81 skill
    // templates emit `phases: []` even though the field is retired.
    // The handler silently strips empty `phases:` and the create succeeds.
    const draftPath = issuePath(h.repo.localPath, "no-children", "open");
    ensureIssuesDirs(h.repo.localPath);
    // Hand-written YAML that intentionally omits `children:` — mirrors a
    // skill-authored draft.
    writeFileSync(
      draftPath,
      [
        "schema_version: 3",
        "tracker: memory",
        'id: ""',
        'external_id: ""',
        "parent_id: null",
        "dispatch: null",
        "status: ToDo",
        "type: Feature",
        "title: skill-authored draft without children",
        'description: ""',
        "triage:",
        '  expires_at: ""',
        '  reassess_hint: ""',
        '  last_status: ""',
        '  last_explain: ""',
        "  ice:",
        "    total: 0",
        "    i: 0",
        "    c: 0",
        "    e: 0",
        "  history: []",
        "ac: []",
        "phases: []",
        "comments: []",
        "retro:",
        '  good: ""',
        '  bad: ""',
        "  action_item_ids: []",
        "  commits: []",
        "",
      ].join("\n"),
    );
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "no-children" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    const stamped = readYaml(h.repo.localPath, body.id);
    // Auto-filled `children: []` must round-trip into the on-disk YAML.
    expect(stamped).toMatch(/^children:/m);
    // ISS-81: re-serialized YAML must NOT carry the legacy `phases:` key.
    expect(stamped).not.toMatch(/^phases:/m);
  });

  it("rejects danx_issue_create when the draft carries a non-empty phases: [...] payload (ISS-81)", async () => {
    const draftPath = issuePath(h.repo.localPath, "with-phases", "open");
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(
      draftPath,
      [
        "schema_version: 3",
        "tracker: memory",
        'id: ""',
        'external_id: ""',
        "parent_id: null",
        "children: []",
        "dispatch_id: null",
        "status: ToDo",
        "type: Feature",
        "title: legacy draft with phases payload",
        'description: ""',
        "triaged:",
        '  timestamp: ""',
        '  status: ""',
        '  explain: ""',
        "ac: []",
        "phases:",
        '  - title: "Phase 1"',
        "    status: Pending",
        '    notes: ""',
        "comments: []",
        "retro:",
        '  good: ""',
        '  bad: ""',
        "  action_item_ids: []",
        "  commits: []",
        "",
      ].join("\n"),
    );
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "with-phases" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors).toEqual([
      "phases field removed (ISS-81); use children[] for sub-cards / epic phase cards",
    ]);
    // Draft file untouched — agent retries after migrating to children[].
    expect(existsSync(draftPath)).toBe(true);
  });

  it("strips a trailing .yml suffix on filename", async () => {
    const draft: Issue = {
      ...createEmptyIssue({ id: "", external_id: "", title: "with-suffix" }),
      tracker: "memory",
    };
    writeFileSync(
      issuePath(h.repo.localPath, "with-suffix", "open"),
      serializeIssue(draft),
    );
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "with-suffix.yml" }),
    });
    expect((await res.json()).created).toBe(true);
  });

  it("returns created:false when the file is missing", async () => {
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "no-such" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toMatch(/File not found/);
  });

  it("returns created:false on schema-validation failure", async () => {
    const path = issuePath(h.repo.localPath, "broken", "open");
    writeFileSync(path, "schema_version: 3\nstatus: ToDo\n");
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "broken" }),
    });
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toContain("missing required field");
  });

  it("rejects drafts that already carry a non-empty external_id (use save, not create)", async () => {
    const draft: Issue = {
      ...createEmptyIssue({
        id: "",
        external_id: "card-already-exists",
        title: "double-create",
      }),
      tracker: "memory",
    };
    writeFileSync(
      issuePath(h.repo.localPath, "card-already-exists", "open"),
      serializeIssue(draft),
    );
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "card-already-exists" }),
    });
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toMatch(/external_id .* danx_issue_save/);
    // Tracker MUST NOT have been called — preventing duplicate cards.
    const creates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "createCard");
    expect(creates).toHaveLength(0);
  });

  it("returns created:false (HTTP 200) when filename is missing — agent-recoverable", async () => {
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toContain("filename");
  });

  it("returns 400 on malformed JSON body (network-level failure, distinct from agent-recoverable)", async () => {
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.created).toBe(false);
  });

  it("strips only ONE trailing .yml suffix — foo.yml.yml resolves to foo.yml on disk", async () => {
    // Whoever passes `foo.yml.yml` gets the suffix stripped once; the
    // resulting filename `foo.yml` is then looked up, NOT found, and
    // returns the standard not-found shape. Pins current behavior so a
    // future strip-loop change is intentional.
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "foo.yml.yml" }),
    });
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toMatch(/File not found.*foo\.yml\.yml/);
  });

  it("returns created:false when the tracker rejects the create", async () => {
    const draft: Issue = {
      ...createEmptyIssue({ id: "", external_id: "", title: "tracker-fails" }),
      tracker: "memory",
    };
    writeFileSync(
      issuePath(h.repo.localPath, "tracker-fails", "open"),
      serializeIssue(draft),
    );
    h.tracker.failNextWrite(new Error("503 from tracker"));
    const res = await fetch(`${h.url}/api/issue-create/dispatch-c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "tracker-fails" }),
    });
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.errors[0]).toContain("503 from tracker");
  });
});

describe("syncTrackedIssueOnComplete", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("AC #4: calls syncIssue synchronously for the tracked id", async () => {
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-11",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "stale",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-11",
        external_id: "mem-1",
        title: "fresh-via-complete",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    const result = await syncTrackedIssueOnComplete(
      "dispatch-complete",
      h.repo,
      "ISS-11",
      { tracker: h.tracker, recordError: async () => {} },
    );
    expect(result.ok).toBe(true);
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(1);
  });

  it("returns errors:[...] when YAML is missing without throwing", async () => {
    const result = await syncTrackedIssueOnComplete(
      "dispatch-complete",
      h.repo,
      "ISS-ghost",
      { tracker: h.tracker, recordError: async () => {} },
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/No YAML file found at \.danxbot\/issues/);
  });
});

// DX-146 / Phase 2 — appendDiffEntries pure helper + worker write-path
// integration. Pairs DX-145's appendHistory schema with the agent-driven
// `runSync` + `handleIssueCreate` flows. The 10 tests below mirror the test
// plan in the card description; a missing assertion against the test plan
// is the AC failing, not a test omission.

describe("DX-146: appendDiffEntries (pure helper)", () => {
  function makeIssue(overrides: Partial<Issue> = {}): Issue {
    const merged: Issue = {
      ...createEmptyIssue({ id: "ISS-1" }),
      tracker: "memory",
      ...overrides,
    };
    if (merged.status === "Blocked" && merged.blocked === null) {
      merged.blocked = {
        reason: "test self-block",
        timestamp: "2026-01-01T00:00:00.000Z",
      };
    }
    return merged;
  }

  it("test plan #1: status change → exactly one status_change entry with from/to/actor", () => {
    const old = makeIssue({ status: "ToDo" });
    const next = makeIssue({ status: "In Progress" });
    const recordedSystemErrors: string[] = [];
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z", {
      recordSystemError: (msg) => {
        recordedSystemErrors.push(msg);
      },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      timestamp: "2026-05-08T10:00:00.000Z",
      actor: "dispatch:dispatch-abc",
      event: "status_change",
      from: "ToDo",
      to: "In Progress",
    });
    expect(recordedSystemErrors).toEqual([]);
  });

  it("test plan #2: no status change → zero entries appended", () => {
    const old = makeIssue({ status: "ToDo" });
    const next = makeIssue({ status: "ToDo" });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toEqual([]);
  });

  it("test plan #3: blocked null → record → one blocked entry with note listing blocker ids", () => {
    const old = makeIssue({ status: "ToDo", blocked: null });
    const next = makeIssue({
      status: "ToDo",
      waiting_on: {
        reason: "wait on phase",
        timestamp: "2026-05-08T10:00:00.000Z",
        by: ["DX-200", "DX-201"],
      },
    });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      timestamp: "2026-05-08T10:00:00.000Z",
      actor: "dispatch:dispatch-abc",
      event: "blocked",
      to: "ToDo",
      note: "Waiting on DX-200, DX-201",
    });
  });

  it("test plan #4: blocked record → null → one unblocked entry", () => {
    const old = makeIssue({
      status: "ToDo",
      waiting_on: {
        reason: "wait",
        timestamp: "2026-05-08T09:00:00.000Z",
        by: ["DX-200"],
      },
    });
    const next = makeIssue({ status: "ToDo", blocked: null });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      timestamp: "2026-05-08T10:00:00.000Z",
      actor: "dispatch:dispatch-abc",
      event: "unblocked",
      to: "ToDo",
    });
  });

  it("test plan #5: status change AND blocked transition → both entries (status_change first)", () => {
    const old = makeIssue({ status: "In Progress", blocked: null });
    const next = makeIssue({
      status: "ToDo",
      waiting_on: {
        reason: "wait",
        timestamp: "2026-05-08T10:00:00.000Z",
        by: ["DX-300"],
      },
    });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toHaveLength(2);
    expect(history[0].event).toBe("status_change");
    expect(history[0].from).toBe("In Progress");
    expect(history[0].to).toBe("ToDo");
    expect(history[1].event).toBe("blocked");
    expect(history[1].to).toBe("ToDo");
    expect(history[1].note).toBe("Waiting on DX-300");
  });

  it("test plan #7: empty dispatchId → actor 'unknown' AND recordSystemError invoked", () => {
    const old = makeIssue({ status: "ToDo" });
    const next = makeIssue({ status: "Done" });
    const recorded: string[] = [];
    const history = appendDiffEntries(old, next, "", "2026-05-08T10:00:00.000Z", {
      recordSystemError: (msg) => {
        recorded.push(msg);
      },
    });
    expect(history).toHaveLength(1);
    expect(history[0].actor).toBe("unknown");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/missing dispatch id/);
  });

  it("first save (no prior state) → no entries appended; new history preserved", () => {
    const next = makeIssue({ status: "ToDo" });
    const history = appendDiffEntries(null, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toEqual([]);
  });

  it("preserves and appends to existing history entries (does not clobber)", () => {
    const existing = [
      {
        timestamp: "2026-05-07T00:00:00.000Z",
        actor: "dispatch:earlier",
        event: "created" as const,
        to: "ToDo" as const,
      },
    ];
    const old = makeIssue({ status: "ToDo", history: existing });
    const next = makeIssue({ status: "Done", history: existing });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(existing[0]);
    expect(history[1].event).toBe("status_change");
  });

  it("blocked note carries the joined blocker ids and survives appendHistory truncation (single entry)", () => {
    // DX-146's contract at the diff site is "build the right note string
    // from `blocked.by[]` and hand it off cleanly to appendHistory" — the
    // 200-char cap + ellipsis truncation belong to DX-145
    // (yaml-history.test.ts). What we pin here: ONE blocked entry, note
    // prefix is `Blocked on `, the first few blocker ids show up, and
    // the long-list path doesn't crash.
    const longBlockerList = Array.from({ length: 50 }, (_, i) => `DX-${i + 1000}`);
    const old = makeIssue({ status: "ToDo", blocked: null });
    const next = makeIssue({
      status: "ToDo",
      waiting_on: {
        reason: "wait",
        timestamp: "2026-05-08T10:00:00.000Z",
        by: longBlockerList,
      },
    });
    const history = appendDiffEntries(old, next, "dispatch-abc", "2026-05-08T10:00:00.000Z");
    expect(history).toHaveLength(1);
    const note = history[0].note ?? "";
    expect(note.startsWith("Waiting on DX-1000, DX-1001")).toBe(true);
  });
});

describe("DX-146: runSync / handleIssueSave history append integration", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("test plan #1 integration: status change between two saves appends one status_change entry", async () => {
    // No external_id → skip tracker push and exercise the local-only
    // persist path. The diff still happens; the cache populates from
    // the first save, and the second save produces the entry.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-100", external_id: "", title: "claim flow" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);

    // Save 1: ToDo (cache populates with ToDo; no diff yet)
    await fetch(`${h.url}/api/issue-save/dispatch-claim-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-100" }),
    });
    await _drainAsyncWorkForTesting();

    // Agent edits status to In Progress on disk and saves again.
    issue.status = "In Progress";
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-claim-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-100" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-100");
    expect(persisted).toContain("event: status_change");
    expect(persisted).toContain("from: ToDo");
    expect(persisted).toContain("to: In Progress");
    expect(persisted).toContain("actor: dispatch:dispatch-claim-2");
  });

  it("test plan #4 integration: blocked record → null between two saves appends an 'unblocked' entry", async () => {
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-101", external_id: "", title: "unblock flow" }),
      tracker: "memory",
      status: "ToDo",
      waiting_on: {
        reason: "wait",
        timestamp: "2026-05-08T09:00:00.000Z",
        by: ["ISS-999"],
      },
    };
    writeYaml(h.repo.localPath, issue);

    // Save 1: blocked (cache populates with blocked != null)
    await fetch(`${h.url}/api/issue-save/dispatch-unblk-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-101" }),
    });
    await _drainAsyncWorkForTesting();

    // Agent clears the dep-chain wait (waiting_on, formerly the v3 blocked field).
    issue.waiting_on = null;
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-unblk-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-101" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-101");
    expect(persisted).toContain("event: unblocked");
    expect(persisted).toContain("actor: dispatch:dispatch-unblk-2");
  });

  it("test plan #7 integration: empty dispatchId on /api/issue-save → actor 'unknown' and recordSystemError invoked", async () => {
    const recordedSystemErrors: string[] = [];
    const customDeps: IssueRouteDeps = {
      tracker: h.tracker,
      recordError: async (dispatchId, message) => {
        h.recordedErrors.push({ dispatchId, message });
      },
      recordSystemError: (msg) => {
        recordedSystemErrors.push(msg);
      },
    };
    // Stand up a parallel HTTP server bound to the SAME repo dir so we
    // can inject the custom deps. The harness's own server keeps running
    // (and drains in afterEach); they don't conflict because each test
    // owns a fresh mkdtemp.
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "/";
        const saveMatch = url.match(/^\/api\/issue-save\/?([^/?]*)/);
        if (req.method === "POST" && saveMatch) {
          await handleIssueSave(req, res, saveMatch[1] ?? "", h.repo, customDeps);
          return;
        }
        res.writeHead(404).end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const issue: Issue = {
        ...createEmptyIssue({ id: "ISS-200", external_id: "", title: "no dispatch" }),
        tracker: "memory",
        status: "ToDo",
      };
      writeYaml(h.repo.localPath, issue);

      // First save with valid dispatchId to populate cache.
      await fetch(`${url}/api/issue-save/seed-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "ISS-200" }),
      });
      await _drainAsyncWorkForTesting();

      // Agent flips status; save with EMPTY dispatchId.
      issue.status = "Done";
      writeYaml(h.repo.localPath, issue);

      await fetch(`${url}/api/issue-save/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "ISS-200" }),
      });
      await _drainAsyncWorkForTesting();

      // Done → moved to closed/. Read from there.
      const persisted = readYaml(h.repo.localPath, "ISS-200", "closed");
      expect(persisted).toContain("event: status_change");
      expect(persisted).toContain("actor: unknown");
      expect(recordedSystemErrors.length).toBeGreaterThanOrEqual(1);
      expect(recordedSystemErrors[0]).toMatch(/missing dispatch id/);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
    }
  });

  it("test plan #9: rolling cap enforced — appending past 1000 entries drops oldest", async () => {
    // Pre-populate history at exactly 1000 valid entries, then trigger
    // a status_change to verify the cap holds at 1000 (oldest dropped).
    const seedEntries: import("../../issue-tracker/interface.js").IssueHistoryEntry[] =
      Array.from({ length: 1000 }, (_, i) => ({
        timestamp: `2026-05-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        actor: `dispatch:seed-${i}`,
        event: "created" as const,
        to: "ToDo" as const,
      }));
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-300", external_id: "", title: "cap" }),
      tracker: "memory",
      status: "ToDo",
      history: seedEntries,
    };
    writeYaml(h.repo.localPath, issue);

    // First save populates cache; on-disk history stays at 1000.
    await fetch(`${h.url}/api/issue-save/cap-seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-300" }),
    });
    await _drainAsyncWorkForTesting();

    // Status change triggers an append; cap drops oldest, length stays 1000.
    issue.status = "In Progress";
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/cap-trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-300" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-300");
    // First seed entry's actor (`dispatch:seed-0`) was dropped.
    expect(persisted).not.toContain("actor: dispatch:seed-0\n");
    // Last seed entry survives.
    expect(persisted).toContain("actor: dispatch:seed-999");
    // The new status_change rides at the tail.
    expect(persisted).toContain("event: status_change");
    expect(persisted).toContain("actor: dispatch:cap-trigger");
  });

  it("review-gap fix: tracker-bound branch (external_id != \"\") appends history entries during runSync's local-first persist", async () => {
    // Every other DX-146 integration test exercises the
    // `external_id == ""` branch (chainOnIssueLock → persistAfterSync).
    // The production path for any tracker-bound card runs through
    // `runSync`, which writes to disk BEFORE pushing to the tracker
    // (DX-131). The diff append must ride that first-persist write.
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-410",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "tracker-bound diff",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-410", external_id: "mem-1", title: "tracker-bound" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);

    // Save 1: populates cache.
    await fetch(`${h.url}/api/issue-save/dispatch-tb-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-410" }),
    });
    await _drainAsyncWorkForTesting();

    // Save 2: tracker-bound diff append must land on disk.
    issue.status = "In Progress";
    writeYaml(h.repo.localPath, issue);
    await fetch(`${h.url}/api/issue-save/dispatch-tb-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-410" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-410");
    expect(persisted).toContain("event: status_change");
    expect(persisted).toContain("from: ToDo");
    expect(persisted).toContain("to: In Progress");
    expect(persisted).toContain("actor: dispatch:dispatch-tb-2");
    // Tracker push happened (proves runSync ran end-to-end, not just the
    // local-only branch).
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates.length).toBeGreaterThan(0);
  });

  it("review-gap fix: forceBlockedToToDo runs BEFORE applyHistoryDiff — agent's stray (Blocked, blocked != null) emits status_change(In Progress, ToDo)", async () => {
    // Pin the contract at issue-route.ts: handleIssueSave applies
    // forceBlockedToToDo, THEN applyHistoryDiff. A regression that
    // swaps those two lines would emit status_change(In Progress,
    // Blocked) here — wrong, because the worker forced ToDo and
    // Blocked never persists.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-420", external_id: "", title: "blocked normalize" }),
      tracker: "memory",
      status: "In Progress",
    };
    writeYaml(h.repo.localPath, issue);

    // Save 1: cache populates with {status: In Progress, blocked: null}.
    await fetch(`${h.url}/api/issue-save/dispatch-bn-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-420" }),
    });
    await _drainAsyncWorkForTesting();

    // Save 2: agent saves with status: Blocked AND a non-null waiting_on
    // (a category error — waiting_on means dep-chain queue, status
    // should stay ToDo). Worker's `forceWaitingOnToToDo` normalizes
    // status → ToDo because waiting_on takes precedence. Diff sees
    // (In Progress, ToDo) for status and (null, record) for waiting_on.
    // We also populate `blocked` so the YAML obeys the v4 invariant
    // (status === "Blocked" ⟺ blocked !== null) on its way through the
    // serializer; the worker normalization is what proves the test —
    // post-normalization the file lands as ToDo with blocked cleared.
    issue.status = "Blocked";
    issue.blocked = {
      reason: "agent's stray Blocked write — should be normalized away",
      timestamp: "2026-05-08T11:00:00.000Z",
    };
    issue.waiting_on = {
      reason: "wait",
      timestamp: "2026-05-08T11:00:00.000Z",
      by: ["ISS-419"],
    };
    writeYaml(h.repo.localPath, issue);
    await fetch(`${h.url}/api/issue-save/dispatch-bn-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-420" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-420");
    expect(persisted).toContain("event: status_change");
    expect(persisted).toContain("from: In Progress");
    expect(persisted).toContain("to: ToDo");
    expect(persisted).not.toContain("to: Blocked");
    expect(persisted).toContain("event: blocked");
    expect(persisted).toContain("note: Waiting on ISS-419");
  });

  it("review-gap fix: _resetForTesting clears lastSeenIssueState — first save after reset emits no diff", async () => {
    // Pin the cache-clear behavior of _resetForTesting. A regression
    // that drops the `lastSeenIssueState.clear()` call (or moves it
    // outside the helper) would silently leak state across tests and
    // produce order-dependent flakes.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-430", external_id: "", title: "reset test" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);

    // Save 1: populates cache with {status: ToDo, blocked: null}.
    await fetch(`${h.url}/api/issue-save/dispatch-rs-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-430" }),
    });
    await _drainAsyncWorkForTesting();

    // Reset clears the cache.
    _resetForTesting();

    // Save 2: agent flips status. Cache miss → no diff → no entries
    // appended (acceptable trade-off for the cache-miss path; pinned
    // by appendDiffEntries' `if (!oldIssue) return` short-circuit).
    issue.status = "In Progress";
    writeYaml(h.repo.localPath, issue);
    await fetch(`${h.url}/api/issue-save/dispatch-rs-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-430" }),
    });
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-430");
    // History stays empty: cache was cleared, so save 2 has no prior
    // reference and emits zero entries. The status_change(ToDo →
    // In Progress) transition is intentionally lost — that's the
    // documented cache-miss semantics.
    expect(persisted).not.toContain("event: status_change");
  });
});

describe("DX-146: handleIssueCreate appends 'created' entry", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("test plan #6: fresh card → exactly one 'created' entry with actor dispatch:<id> and to: <draft.status>", async () => {
    const draft: Issue = {
      ...createEmptyIssue({ id: "", external_id: "", title: "fresh card" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeFileSync(
      issuePath(h.repo.localPath, "fresh-card", "open"),
      serializeIssue(draft),
    );

    const res = await fetch(`${h.url}/api/issue-create/dispatch-create-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "fresh-card" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);

    const stamped = readYaml(h.repo.localPath, body.id);
    expect(stamped).toContain("event: created");
    expect(stamped).toContain("actor: dispatch:dispatch-create-1");
    expect(stamped).toContain("to: ToDo");
  });

  it("test plan #8: handleIssueCreate with empty dispatchId → actor 'unknown' AND recordSystemError invoked", async () => {
    const recordedSystemErrors: string[] = [];
    const customDeps: IssueRouteDeps = {
      tracker: h.tracker,
      recordSystemError: (msg) => {
        recordedSystemErrors.push(msg);
      },
    };
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "/";
        const createMatch = url.match(/^\/api\/issue-create\/?([^/?]*)/);
        if (req.method === "POST" && createMatch) {
          await handleIssueCreate(req, res, createMatch[1] ?? "", h.repo, customDeps);
          return;
        }
        res.writeHead(404).end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      const draft: Issue = {
        ...createEmptyIssue({ id: "", external_id: "", title: "no dispatch create" }),
        tracker: "memory",
        status: "ToDo",
      };
      writeFileSync(
        issuePath(h.repo.localPath, "no-dispatch-create", "open"),
        serializeIssue(draft),
      );

      const res = await fetch(`${url}/api/issue-create/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "no-dispatch-create" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(true);

      const stamped = readYaml(h.repo.localPath, body.id);
      expect(stamped).toContain("event: created");
      expect(stamped).toContain("actor: unknown");
      expect(recordedSystemErrors.length).toBeGreaterThanOrEqual(1);
      expect(recordedSystemErrors[0]).toMatch(/missing dispatch id/);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
    }
  });

  it("review-gap fix: handleIssueCreate seeds the diff cache — agent's first follow-up save mints status_change(ToDo, In Progress)", async () => {
    // The cache seed at issue-route.ts is the load-bearing line for
    // the next save's diff: without it, the agent's claim save (the
    // very first transition after card creation) would miss the
    // ToDo → In Progress status_change entry. Pin it.
    const draft: Issue = {
      ...createEmptyIssue({ id: "", external_id: "", title: "create then claim" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeFileSync(
      issuePath(h.repo.localPath, "create-claim", "open"),
      serializeIssue(draft),
    );

    const createRes = await fetch(`${h.url}/api/issue-create/dispatch-cc-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "create-claim" }),
    });
    const createBody = await createRes.json();
    expect(createBody.created).toBe(true);
    const newId = createBody.id;

    // Read the just-created YAML to mutate it for the claim save.
    const stamped = readYaml(h.repo.localPath, newId);
    // Sanity: the `created` entry landed.
    expect(stamped).toContain("event: created");

    // Agent claims the card: status: ToDo → In Progress.
    const issue: Issue = {
      ...createEmptyIssue({ id: newId, external_id: createBody.external_id, title: "create then claim" }),
      tracker: "memory",
      status: "In Progress",
      // Preserve the created entry so the diff path appends to it.
      history: [
        {
          timestamp: new Date().toISOString(),
          actor: "dispatch:dispatch-cc-1",
          event: "created",
          to: "ToDo",
        },
      ],
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-cc-2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: newId }),
    });
    await _drainAsyncWorkForTesting();

    const claimed = readYaml(h.repo.localPath, newId);
    // Both the created entry AND the status_change must coexist —
    // proves the cache was seeded by handleIssueCreate (otherwise
    // save 1 = cache miss → no status_change appended).
    expect(claimed).toContain("event: created");
    expect(claimed).toContain("event: status_change");
    expect(claimed).toContain("from: ToDo");
    expect(claimed).toContain("to: In Progress");
    expect(claimed).toContain("actor: dispatch:dispatch-cc-2");
  });
});

describe("DX-146: syncTrackedIssueOnComplete reuses the same diff helper", () => {
  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("test plan #10: status change on auto-sync (no prior explicit save) appends entry via the same path", async () => {
    // Seed: explicit save first to populate cache with status: ToDo.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-310", external_id: "", title: "auto-sync flow" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);
    await fetch(`${h.url}/api/issue-save/dispatch-pre-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-310" }),
    });
    await _drainAsyncWorkForTesting();

    // Agent flips to Done on disk; never saves explicitly. Auto-sync via
    // syncTrackedIssueOnComplete must append the status_change entry.
    issue.status = "Done";
    writeYaml(h.repo.localPath, issue);

    const result = await syncTrackedIssueOnComplete(
      "dispatch-complete",
      h.repo,
      "ISS-310",
      { tracker: h.tracker, recordError: async () => {} },
    );
    expect(result.ok).toBe(true);
    await _drainAsyncWorkForTesting();

    // Done → moved to closed/. Read from there.
    const persisted = readYaml(h.repo.localPath, "ISS-310", "closed");
    expect(persisted).toContain("event: status_change");
    expect(persisted).toContain("from: ToDo");
    expect(persisted).toContain("to: Done");
    expect(persisted).toContain("actor: dispatch:dispatch-complete");
  });

  it("review-gap fix: tracker-bound auto-sync (external_id != \"\") appends entry once and pushes once", async () => {
    // The single Test #10 case uses external_id = "" — the local-only
    // branch. Cover the production path: tracker-bound card, agent
    // flips status on disk without saving, danxbot_complete fires,
    // syncTrackedIssueOnComplete picks up the diff via runSync. Pin
    // (a) entry lands once and (b) tracker push fires once (no
    // double-append from a hypothetical second helper invocation).
    await h.tracker.createCard({
      schema_version: 4,
      tracker: "memory",
      id: "ISS-510",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "tb-complete",
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-510", external_id: "mem-1", title: "tb-complete" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);

    // Seed save populates cache.
    await fetch(`${h.url}/api/issue-save/dispatch-tbc-seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-510" }),
    });
    await _drainAsyncWorkForTesting();

    const moveCountAfterSeed = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "moveToStatus").length;

    // Agent flips status to Done on disk; danxbot_complete triggers auto-sync.
    issue.status = "Done";
    writeYaml(h.repo.localPath, issue);

    const result = await syncTrackedIssueOnComplete(
      "dispatch-tbc-complete",
      h.repo,
      "ISS-510",
      { tracker: h.tracker, recordError: async () => {} },
    );
    expect(result.ok).toBe(true);
    await _drainAsyncWorkForTesting();

    // Entry lands ONCE on disk (in closed/ since Done).
    const persisted = readYaml(h.repo.localPath, "ISS-510", "closed");
    const statusChangeMatches = persisted.match(/event: status_change/g) ?? [];
    expect(statusChangeMatches).toHaveLength(1);
    expect(persisted).toContain("from: ToDo");
    expect(persisted).toContain("to: Done");
    expect(persisted).toContain("actor: dispatch:dispatch-tbc-complete");

    // Tracker move-to-status fired exactly once for the auto-sync
    // (the status_change ToDo → Done routes through `moveToStatus`,
    // not `updateCard`). Proves runSync ran through the shared diff
    // helper end-to-end, not a parallel code path that would double-push.
    const movesNow = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "moveToStatus").length;
    expect(movesNow - moveCountAfterSeed).toBe(1);
  });
});
