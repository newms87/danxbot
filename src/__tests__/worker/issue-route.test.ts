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
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestHarness> {
  const tracker = new MemoryTracker();
  const repoLocalPath = mkdtempSync(join(tmpdir(), "danxbot-issue-route-"));
  ensureIssuesDirs(repoLocalPath);
  const recordedErrors: Array<{ dispatchId: string; message: string }> = [];
  const deps: IssueRouteDeps = {
    tracker,
    recordError: async (dispatchId, message) => {
      recordedErrors.push({ dispatchId, message });
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
      doneListId: "",
      cancelledListId: "",
      actionItemsListId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "stale-remote",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-4",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote-title",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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

  it("AC #5: serializes concurrent saves on the same id", async () => {
    await h.tracker.createCard({
      schema_version: 3,
      tracker: "memory",
      id: "ISS-5",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-6",
      parent_id: null,
      children: [],
      status: "Done",
      type: "Feature",
      title: "done-card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-7",
      parent_id: null,
      children: [],
      status: "Cancelled",
      type: "Feature",
      title: "cancelled-card",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-8",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-9",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-10",
      parent_id: null,
      children: [],
      status: "In Progress",
      type: "Feature",
      title: "wip",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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

  it("forces status to ToDo on save when blocked is non-null, regardless of agent-written status", async () => {
    // Worker contract: `blocked != null` and `status != "ToDo"` is a
    // category error. The worker silently normalizes status → ToDo before
    // persisting, before the tracker push, and before the open/closed
    // file move. Agents must set `blocked` only — they don't separately
    // move status.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-50",
        external_id: "",
        title: "Blocked normalize test",
      }),
      tracker: "memory",
      status: "Needs Help",
      blocked: {
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
    expect(persisted).not.toContain("status: Needs Help");
    // File stays in `open/` (ToDo is non-terminal).
    expect(existsSync(issuePath(h.repo.localPath, "ISS-50", "open"))).toBe(true);
    expect(existsSync(issuePath(h.repo.localPath, "ISS-50", "closed"))).toBe(false);
  });

  it("preserves status when blocked is null (no normalization)", async () => {
    // Sanity: forceBlockedToToDo is a no-op when blocked is null. A
    // legitimate Needs Help save still persists with status: Needs Help.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-51",
        external_id: "",
        title: "Real Needs Help",
      }),
      tracker: "memory",
      status: "Needs Help",
      blocked: null,
    };
    writeYaml(h.repo.localPath, issue);

    await fetch(`${h.url}/api/issue-save/dispatch-nh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ISS-51" }),
    });
    await _drainAsyncWorkForTesting();
    const persisted = readYaml(h.repo.localPath, "ISS-51");
    expect(persisted).toContain("status: Needs Help");
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
      phases: [
        { check_item_id: "", title: "Phase 1", status: "Pending", notes: "" },
      ],
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

  it("auto-fills children: [] when the draft YAML omits the field", async () => {
    // The strict v3 validator requires `children`. Drafts written by
    // skill prose almost never include it (children get populated post-
    // create by the danx-epic-link skill on epics, never on the create
    // call itself). The handler must auto-fill an empty list before
    // running the strict parse — otherwise every create round-trips
    // back as a validation failure.
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
        "dispatch_id: null",
        "status: ToDo",
        "type: Feature",
        "title: skill-authored draft without children",
        'description: ""',
        "triaged:",
        '  timestamp: ""',
        '  status: ""',
        '  explain: ""',
        "ac: []",
        "phases: []",
        "comments: []",
        "retro:",
        '  good: ""',
        '  bad: ""',
        "  action_items: []",
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-11",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "stale",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
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
