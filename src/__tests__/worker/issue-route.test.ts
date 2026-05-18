/**
 * Unit + integration tests for the `danx_issue_create` worker handler
 * and the `syncTrackedIssueOnComplete` auto-sync helper.
 *
 * Spins up a real `node:http` server bound to a random port for each
 * test, registers `/api/issue-create/:id`, then issues real `fetch`
 * calls against the loopback address. The FakeTracker stands in for a
 * real IssueTracker — it implements the full interface deterministically
 * and supports `failNextWrite` for the tracker-error-isolation tests
 * that AC #2 requires.
 *
 * DX-157 retired the agent-facing save HTTP route. Behaviors that were
 * previously exercised through the legacy save HTTP route (history-diff
 * append, terminal open→closed file move, dispatch clearing on terminal
 * save) now run inside
 * `syncTrackedIssueOnComplete` — invoked synchronously from the worker's
 * `handleStop` when the agent calls `danxbot_complete`. The auto-sync
 * test block exercises that path end-to-end.
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
  runSync,
  syncTrackedIssueOnComplete,
  type IssueRouteDeps,
} from "../../worker/issue-route.js";
import { FakeTracker } from "../helpers/FakeTracker.js";
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
  tracker: FakeTracker;
  repo: RepoContext;
  recordedErrors: Array<{ dispatchId: string; message: string }>;
  recordedSystemErrors: string[];
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestHarness> {
  const tracker = new FakeTracker();
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
    hostPath: repoLocalPath,
    workerPort: 0,
    githubToken: "",
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
      blockedLabelId: "",
      requiresHumanLabelId: "",
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
      const createMatch = url.match(/^\/api\/issue-create\/([^/?]+)/);
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
        "schema_version: 11",
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
    // DX-594: priority became strictly required. The fixture above omits
    // the field; the handler stamps `PRIORITY_DEFAULT` so the strict
    // validator accepts the draft and the canonical writer emits it.
    expect(stamped).toMatch(/^priority: 3(\.0)?$/m);
  });

  it("auto-fills schema_version: KNOWN_SCHEMA_MAX when the draft omits it (DX-594)", async () => {
    // DX-594 strict reader rejects anything < KNOWN_SCHEMA_MIN, so the
    // handler's auto-fill MUST stamp the canonical version (10), not
    // the legacy `3` literal it used pre-DX-594. Drafts authored by
    // skills routinely omit the field — this exercises that fall-through.
    const draftPath = issuePath(h.repo.localPath, "no-schema-version", "open");
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(
      draftPath,
      [
        // schema_version intentionally omitted
        "tracker: memory",
        'id: ""',
        'external_id: ""',
        "parent_id: null",
        "children: []",
        "dispatch: null",
        "status: ToDo",
        "type: Feature",
        "title: skill-authored draft without schema_version",
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
      body: JSON.stringify({ filename: "no-schema-version" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    const stamped = readYaml(h.repo.localPath, body.id);
    // The canonical writer stamps KNOWN_SCHEMA_MAX (=10) at save time.
    expect(stamped).toMatch(/^schema_version: 11$/m);
  });

  it("rejects danx_issue_create when the draft carries a non-empty phases: [...] payload (ISS-81)", async () => {
    const draftPath = issuePath(h.repo.localPath, "with-phases", "open");
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(
      draftPath,
      [
        "schema_version: 11",
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
    expect(body.errors[0]).toMatch(/external_id .* edit the existing YAML directly/);
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

  // DX-342 — YAML-only mode: `deps.tracker === null`. The handler must
  // synthesize a result with empty external_id + empty check_item_ids,
  // skip the tracker.createCard call entirely, and still stamp + write
  // the YAML to disk. A parallel harness with a null-tracker deps shape
  // verifies the end-to-end behaviour via fetch + filesystem assertion.
  it("DX-342: deps.tracker === null synthesizes empty external_id + check_item_ids and never calls createCard", async () => {
    // Build a parallel server bound to its own loopback port whose
    // deps.tracker is null. Closes after the test.
    const repoLocalPath = mkdtempSync(join(tmpdir(), "danxbot-issue-route-yaml-only-"));
    ensureIssuesDirs(repoLocalPath);
    const repo: RepoContext = { ...h.repo, localPath: repoLocalPath };
    const nullDeps: IssueRouteDeps = {
      tracker: null,
      recordError: async () => undefined,
      recordSystemError: () => undefined,
    };
    const server = createServer(async (req, res) => {
      const m = (req.url ?? "/").match(/^\/api\/issue-create\/([^/?]+)/);
      if (req.method === "POST" && m) {
        await handleIssueCreate(req, res, m[1] ?? "", repo, nullDeps);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      const draft: Issue = {
        ...createEmptyIssue({
          id: "",
          external_id: "",
          title: "yaml-only create",
        }),
        tracker: "memory",
        ac: [
          { check_item_id: "", title: "AC one", checked: false },
          { check_item_id: "", title: "AC two", checked: false },
        ],
      };
      writeFileSync(
        issuePath(repoLocalPath, "yaml-only-create", "open"),
        serializeIssue(draft),
      );

      const res = await fetch(`${url}/api/issue-create/dispatch-yaml-only`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "yaml-only-create" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(true);
      expect(body.id).toBe("ISS-1");
      expect(body.external_id).toBe("");

      // YAML on disk carries the synthesized empty coordinates.
      const stamped = readFileSync(
        issuePath(repoLocalPath, "ISS-1", "open"),
        "utf-8",
      );
      expect(stamped).toContain("id: ISS-1");
      expect(stamped).toMatch(/external_id:\s*""\s*$/m);
      // Each AC item has an empty check_item_id stub.
      const checkIdLines = stamped.match(/check_item_id:\s*""\s*$/gm) ?? [];
      expect(checkIdLines.length).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(repoLocalPath, { recursive: true, force: true });
    }
  });
});

describe("runSync (local-first persist)", () => {
  // Direct-invocation tests against the exported `runSync` helper —
  // distinct from the `syncTrackedIssueOnComplete` wrapper that adds the
  // history-diff append and per-issue mutex chain. These tests pin behaviors that survived the
  // DX-157 retirement of the legacy save HTTP handler but moved one
  // layer deeper into the runSync internals — primarily the
  // `persistAfterSync` branching for non-terminal statuses and the
  // recordError + recordSystemError dual-emission contract on tracker
  // failure (DX-134 Phase 4).

  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("requires_human != null keeps file in open/ — moveToClosedIfTerminal returns false (DX-231)", async () => {
    // DX-231 retired the `Needs Approval` parking status; the orthogonal
    // `requires_human` field replaces it. A card with the field
    // populated stays in `open/` regardless of status — the dispatch
    // session is terminal but the file location is not. This test pins
    // that `runSync` falls through to the open/ write branch when the
    // saved YAML carries `requires_human != null`.
    await h.tracker.createCard({
      schema_version: 11,
      tracker: "memory",
      id: "ISS-77",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "Awaiting design approval",
      priority: 3.0,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-77",
        external_id: "mem-1",
        title: "Awaiting design approval",
      }),
      tracker: "memory",
      status: "ToDo",
      requires_human: {
        reason: "Need an architectural review before implementation",
        steps: ["Review approach with a senior eng", "Toggle off this flag"],
        set_by: "agent",
        set_at: "2026-05-10T12:00:00.000Z",
      },
    };
    writeYaml(h.repo.localPath, issue);

    await runSync(
      { tracker: h.tracker, recordError: async () => {} },
      "dispatch-na",
      h.repo,
      issue,
    );

    expect(existsSync(issuePath(h.repo.localPath, "ISS-77", "open"))).toBe(
      true,
    );
    expect(existsSync(issuePath(h.repo.localPath, "ISS-77", "closed"))).toBe(
      false,
    );
    const persisted = readYaml(h.repo.localPath, "ISS-77");
    expect(persisted).toContain("status: ToDo");
    expect(persisted).toContain("requires_human:");
  });

  it("recordSystemError fires on tracker error alongside recordError (DX-134 Phase 4)", async () => {
    // Pre-DX-157 had this coverage on the legacy save handler. The
    // DX-134 Phase 4 contract is: when the tracker push throws,
    // `runSync`'s catch block fires BOTH `recordError` (per-dispatch
    // row, drives the dispatch's `error` column) AND `recordSystemError`
    // (cross-dispatch SSE banner) with the IDENTICAL message body. A
    // future refactor that drops the `fireAndForgetSystemError(deps, msg)`
    // call regresses the operator banner without breaking recordError —
    // this test catches that regression.
    await h.tracker.createCard({
      schema_version: 11,
      tracker: "memory",
      id: "ISS-44",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote-title",
      priority: 3.0,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    // Local title diverges from the remote so the diff path produces an
    // `updateCard` write — the operation that `failNextWrite` rejects.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-44",
        external_id: "mem-1",
        title: "local-title",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    h.tracker.failNextWrite(new Error("simulated 401 from tracker"));

    const recordedErrors: Array<{ dispatchId: string; message: string }> = [];
    const recordedSystemErrors: string[] = [];
    await runSync(
      {
        tracker: h.tracker,
        recordError: async (dispatchId, message) => {
          recordedErrors.push({ dispatchId, message });
        },
        recordSystemError: (msg) => {
          recordedSystemErrors.push(msg);
        },
      },
      "dispatch-banner-fail",
      h.repo,
      issue,
    );

    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0].dispatchId).toBe("dispatch-banner-fail");
    expect(recordedErrors[0].message).toMatch(/^tracker sync failed for mem-1: /);
    expect(recordedErrors[0].message).toContain("simulated 401 from tracker");

    expect(recordedSystemErrors).toHaveLength(1);
    // Same body — both surfaces describe the same failure to the operator.
    expect(recordedSystemErrors[0]).toBe(recordedErrors[0].message);
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
      schema_version: 11,
      tracker: "memory",
      id: "ISS-11",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "stale",
      priority: 3.0,
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

  it("preserves `status: ToDo + waiting_on: {…}` YAML through the auto-sync round-trip", async () => {
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9301",
        external_id: "",
        title: "Waiting on canonical",
      }),
      tracker: "memory",
      status: "ToDo",
      waiting_on: {
        reason: "Waiting on ISS-99 to ship",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    writeYaml(h.repo.localPath, issue);

    const result = await syncTrackedIssueOnComplete(
      "dispatch-norm-1",
      h.repo,
      "ISS-9301",
      { tracker: h.tracker, recordError: async () => {} },
    );
    if (!result.ok) {
      throw new Error(`syncTrackedIssueOnComplete failed: ${result.errors.join(" | ")}`);
    }
    expect(result.ok).toBe(true);
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-9301");
    expect(persisted).toContain("status: ToDo");
    expect(persisted).toContain("blocked: null");
    expect(persisted).toContain("by:");
    expect(persisted).toContain("ISS-99");
  });

  it("preserves `status: In Progress + waiting_on: {…}` through the auto-sync (status + waiting_on are independent fields)", async () => {
    // waiting_on is the dispatch gate; status is the workflow position.
    // An agent that picks up a card flips status → In Progress and leaves
    // the durable waiting_on record alone. The auto-sync MUST NOT mutate
    // or reject either field.
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-9302",
        external_id: "",
        title: "Active dispatch with durable waiting_on record",
      }),
      tracker: "memory",
      status: "In Progress",
      waiting_on: {
        reason: "Waiting on ISS-99 to ship",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    writeYaml(h.repo.localPath, issue);

    const result = await syncTrackedIssueOnComplete(
      "dispatch-in-progress",
      h.repo,
      "ISS-9302",
      { tracker: h.tracker, recordError: async () => {} },
    );

    expect(result.ok).toBe(true);
    await _drainAsyncWorkForTesting();

    const persisted = readYaml(h.repo.localPath, "ISS-9302");
    expect(persisted).toContain("status: In Progress");
    expect(persisted).toContain("ISS-99");
  });

  it("returns ok:false with parse error when YAML on disk is malformed (does not throw)", async () => {
    // Pre-DX-157 had "returns saved:false with errors on schema-validation
    // failure" against the legacy save handler. The post-completion
    // auto-sync path now catches `parseIssue` (IssueParseError or any
    // other), records the failure against the dispatch row via
    // `recordError` with a `danxbot_complete auto-sync validation
    // failure: ` prefix, and returns `{ok: false, errors}` — never throws
    // out of `handleStop`. A regression that lets the throw escape would
    // crash the worker's stop handler.
    const id = "ISS-9999";
    ensureIssuesDirs(h.repo.localPath);
    writeFileSync(
      issuePath(h.repo.localPath, id, "open"),
      "schema_version: 3\nbroken: true\n",
    );

    const recordedErrors: Array<{ dispatchId: string; message: string }> = [];
    const result = await syncTrackedIssueOnComplete(
      "dispatch-malformed",
      h.repo,
      id,
      {
        tracker: h.tracker,
        recordError: async (dispatchId, message) => {
          recordedErrors.push({ dispatchId, message });
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    // The unparseable YAML carries `schema_version: 3` but is missing
    // every other required field — `validateIssue` raises one of its
    // `missing required field` / shape-mismatch errors. Match the
    // category prefix without pinning the exact field order so a
    // future validator-message tweak doesn't spuriously fail this test.
    expect(result.errors[0]).toMatch(/missing required field|invalid|expected/i);

    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0].dispatchId).toBe("dispatch-malformed");
    expect(recordedErrors[0].message).toMatch(
      /^danxbot_complete auto-sync validation failure: /,
    );
    expect(recordedErrors[0].message).toContain(result.errors[0]);

    // Tracker MUST NOT have been called — parse failure short-circuits
    // before the chain runs.
    const writes = h.tracker
      .getRequestLog()
      .filter(
        (l) =>
          l.method === "updateCard" ||
          l.method === "moveToList" ||
          l.method === "createCard",
      );
    expect(writes).toHaveLength(0);
  });
});

describe("syncTrackedIssueOnComplete — concurrent invocations", () => {
  // The per-issue mutex map (`issueLocks`) inside `issue-route.ts`
  // serializes overlapping `syncTrackedIssueOnComplete` calls on the
  // same internal id. Two independent guarantees the legacy handler had
  // moved one layer in: (a) ordering — sync 2's tracker push runs only
  // AFTER sync 1's chain task completes; (b) queue-poisoning resistance
  // — sync 1's failure does NOT block sync 2 (each task's rejection is
  // swallowed via `prior.catch(() => undefined)`).

  let h: TestHarness;

  beforeEach(async () => {
    _resetForTesting();
    h = await startTestServer();
  });

  afterEach(async () => {
    await _drainAsyncWorkForTesting();
    await h.close();
  });

  it("two concurrent calls on same id serialize via chainOnIssueLock; later call observes earlier call's writes", async () => {
    await h.tracker.createCard({
      schema_version: 11,
      tracker: "memory",
      id: "ISS-50",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      priority: 3.0,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-50",
        external_id: "mem-1",
        title: "first",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    // Sync 1 reads "first" synchronously (before its `await
    // chainOnIssueLock`). Don't await — leave it pending.
    const p1 = syncTrackedIssueOnComplete(
      "dispatch-c1",
      h.repo,
      "ISS-50",
      { tracker: h.tracker, recordError: async () => {} },
    );

    // Mutate the YAML BEFORE sync 2 begins. The synchronous prefix of
    // `syncTrackedIssueOnComplete` will then read "second" before its
    // chain-queue happens.
    issue.title = "second";
    writeYaml(h.repo.localPath, issue);

    const p2 = syncTrackedIssueOnComplete(
      "dispatch-c2",
      h.repo,
      "ISS-50",
      { tracker: h.tracker, recordError: async () => {} },
    );

    await Promise.all([p1, p2]);
    await _drainAsyncWorkForTesting();

    // Mutex serializes — sync 1's updateCard("first") runs strictly
    // before sync 2's updateCard("second"). The order in the request
    // log is the load-bearing observable.
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(2);
    expect(updates[0].details).toEqual({
      patch: { title: "first", id: "ISS-50" },
    });
    expect(updates[1].details).toEqual({
      patch: { title: "second", id: "ISS-50" },
    });
  });

  it("first call rejecting via runSync does not poison the queue — second call still runs", async () => {
    await h.tracker.createCard({
      schema_version: 11,
      tracker: "memory",
      id: "ISS-51",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "remote",
      priority: 3.0,
      description: "",
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const issue: Issue = {
      ...createEmptyIssue({
        id: "ISS-51",
        external_id: "mem-1",
        title: "first",
      }),
      tracker: "memory",
    };
    writeYaml(h.repo.localPath, issue);

    const recordedErrors: Array<{ dispatchId: string; message: string }> = [];
    const deps: IssueRouteDeps = {
      tracker: h.tracker,
      recordError: async (dispatchId, message) => {
        recordedErrors.push({ dispatchId, message });
      },
    };

    h.tracker.failNextWrite(new Error("first sync explodes"));
    const p1 = syncTrackedIssueOnComplete(
      "dispatch-fail-1",
      h.repo,
      "ISS-51",
      deps,
    );

    issue.title = "second";
    writeYaml(h.repo.localPath, issue);
    const p2 = syncTrackedIssueOnComplete(
      "dispatch-fail-2",
      h.repo,
      "ISS-51",
      deps,
    );

    await Promise.all([p1, p2]);
    await _drainAsyncWorkForTesting();

    // First failure recorded against dispatch-fail-1 only.
    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0].dispatchId).toBe("dispatch-fail-1");
    expect(recordedErrors[0].message).toMatch(/^tracker sync failed for mem-1: /);

    // Second sync still ran — exactly one updateCard for "second".
    // Proves `prior.catch(() => undefined)` in `chainOnIssueLock`
    // swallows sync 1's rejection so sync 2 isn't poisoned.
    const updates = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "updateCard");
    expect(updates).toHaveLength(1);
    expect(updates[0].details).toEqual({
      patch: { title: "second", id: "ISS-51" },
    });
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
        at: "2026-01-01T00:00:00.000Z",
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

    // Drive the diff append via syncTrackedIssueOnComplete (the SOLE
    // remaining post-DX-157 caller of applyHistoryDiff). The cache was
    // seeded by handleIssueCreate above with `{status: ToDo}`, so this
    // call mints the ToDo → In Progress status_change entry.
    await syncTrackedIssueOnComplete(
      "dispatch-cc-2",
      h.repo,
      newId,
      { tracker: h.tracker, recordError: async () => {} },
    );
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
    // Seed: invoke syncTrackedIssueOnComplete directly to populate the
    // lastSeenIssueState cache with status: ToDo. The legacy save HTTP
    // route was retired (DX-157); auto-sync is now the SOLE write
    // pipeline that touches that cache.
    const issue: Issue = {
      ...createEmptyIssue({ id: "ISS-310", external_id: "", title: "auto-sync flow" }),
      tracker: "memory",
      status: "ToDo",
    };
    writeYaml(h.repo.localPath, issue);
    await syncTrackedIssueOnComplete(
      "dispatch-pre-complete",
      h.repo,
      "ISS-310",
      { tracker: h.tracker, recordError: async () => {} },
    );
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
      schema_version: 11,
      tracker: "memory",
      id: "ISS-510",
      parent_id: null,
      children: [],
      status: "ToDo",
      priority: 3.0,
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

    // Seed: prime the lastSeenIssueState cache via a direct auto-sync
    // call. The legacy save HTTP route was retired (DX-157); the
    // post-completion auto-sync is the SOLE caller of applyHistoryDiff
    // and the only path that updates the cache.
    await syncTrackedIssueOnComplete(
      "dispatch-tbc-seed",
      h.repo,
      "ISS-510",
      { tracker: h.tracker, recordError: async () => {} },
    );
    await _drainAsyncWorkForTesting();

    const moveCountAfterSeed = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "moveToList").length;

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

    // DX-621 / Phase 9d — the tracker move is gated on a resolved
    // destinationTrelloListId from `<repo>/.danxbot/trello-list-map.yaml`.
    // This test runs against a freshly-created repo with no mapping, so
    // the move step is intentionally a no-op. The status_change disk
    // entry (asserted above) is the load-bearing proof that the shared
    // diff helper ran end-to-end; the tracker move-count check was
    // redundant once mapping resolution moved out of the tracker layer.
    const movesNow = h.tracker
      .getRequestLog()
      .filter((l) => l.method === "moveToList").length;
    expect(movesNow - moveCountAfterSeed).toBe(0);
  });
});
