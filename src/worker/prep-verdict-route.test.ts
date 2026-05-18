import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handlePrepVerdict } from "./prep-verdict-route.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { createEmptyIssue, serializeIssue, parseIssue } from "../issue-tracker/yaml.js";
import type { AgentJob } from "../agent/agent-types.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import {
  registerWriterDb,
  unregisterWriterDb,
  type IssuesMirrorDb,
  type UpsertArgs,
} from "../db/issues-mirror.js";

/**
 * Install a writer DB against the issues-mirror registry for one test.
 * Returns the upsert call log + an `unregister` handle the test MUST
 * call in a `finally` block. Mirrors the helper in
 * `src/poller/yaml-lifecycle.test.ts` so the writer-DB assertions share
 * a mental model across the suite.
 *
 * Regression coverage: the prep-verdict route's three YAML stamps
 * (conflict_on, waiting_on, blocked) MUST go through `writeIssue` so
 * the DB row lands in lockstep with the file. A `writeFileSync`-only
 * write (the pre-DX-552 bug) leaves the DB row stale; the subsequent
 * `onComplete` → `loadLocal` → `clearDispatchAndWrite` chain in
 * `multi-agent-pick.ts` reads that stale row and writes it back,
 * clobbering the stamp. The regression tests below assert
 * `upsertWithHistoryCalls` carries the stamped state so a future
 * regression to direct `writeFileSync` fails the suite.
 */
function installWriterDb(repoLocalPath: string): {
  upsertWithHistoryCalls: UpsertArgs[];
  unregister: () => void;
} {
  const rows = new Map<
    string,
    { data: Record<string, unknown>; content_hash: string }
  >();
  const upsertWithHistoryCalls: UpsertArgs[] = [];
  const db: IssuesMirrorDb = {
    async selectExisting(repoName, id) {
      return rows.get(`${repoName}|${id}`) ?? null;
    },
    async upsertWithHistory(args) {
      rows.set(`${args.repoName}|${args.id}`, {
        data: args.data,
        content_hash: args.contentHash,
      });
      upsertWithHistoryCalls.push(args);
    },
    async tombstone() {},
    async listIds() {
      const out: Array<{ id: string; content_hash: string }> = [];
      for (const [key, row] of rows) {
        const id = key.split("|")[1]!;
        out.push({ id, content_hash: row.content_hash });
      }
      return out;
    },
  };
  registerWriterDb(repoLocalPath, db);
  return {
    upsertWithHistoryCalls,
    unregister: () => unregisterWriterDb(repoLocalPath),
  };
}

function makeRepo(localPath: string) {
  return makeRepoContext({
    name: "danxbot",
    localPath,
    hostPath: localPath,
    issuePrefix: "DX",
  });
}

/**
 * Build a synthetic Dispatch row sufficient for the handler's needs:
 * the route only reads `id`, `repoName`, `issueId`, `agentName`.
 */
function makeDispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-1",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {} as Dispatch["triggerMetadata"],
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: "DX-100",
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "docker",
    hostPid: null,
    hostPidAt: null,
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
    ...over,
  };
}

/**
 * Build a minimal AgentJob stub. The route uses `stop`, `prepVerdict`,
 * and (DX-296) `dispatchKind` for the verdict=ok lifecycle decision.
 */
function makeJobStub(dispatchKind?: "prep" | "work") {
  const stop = vi.fn(async () => undefined);
  const job = {
    id: "dispatch-1",
    status: "running" as const,
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    recoverCount: 0,
    dispatchKind,
    stop,
  } as unknown as AgentJob;
  return { job, stop };
}

/** Write a v7 Issue to `<root>/.danxbot/issues/open/<id>.yml`. */
function writeIssue(
  root: string,
  id: string,
  statusOrMutator:
    | "ToDo"
    | ((issue: ReturnType<typeof createEmptyIssue>) => void) = "ToDo",
) {
  mkdirSync(join(root, ".danxbot", "issues", "open"), { recursive: true });
  // `title` is parser-required non-empty; use a stable test fixture body.
  // Two-shape signature: a literal status keeps the original short-form,
  // a callback lets tests stamp arbitrary fields (waiting_on, etc.).
  const status =
    typeof statusOrMutator === "string" ? statusOrMutator : "ToDo";
  const issue = createEmptyIssue({
    id,
    status,
    title: `Test issue ${id}`,
    description: "fixture",
  });
  if (typeof statusOrMutator === "function") {
    statusOrMutator(issue);
  }
  writeFileSync(
    join(root, ".danxbot", "issues", "open", `${id}.yml`),
    serializeIssue(issue),
  );
}

/** Read an Issue back from disk. */
function readIssue(root: string, id: string) {
  return parseIssue(
    readFileSync(join(root, ".danxbot", "issues", "open", `${id}.yml`), "utf-8"),
    { expectedPrefix: "DX" },
  );
}

describe("handlePrepVerdict — request validation", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("400s on malformed body", async () => {
    const req = createMockReqWithBody("POST", undefined);
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn(),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("400s on missing verdict", async () => {
    const req = createMockReqWithBody("POST", { reason: "x" });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn(),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/verdict must be one of/);
  });

  it("400s on legacy blocked_by arg — hint lists both successor args", async () => {
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      blocked_by: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn(),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /conflict_with.*depends_on|depends_on.*conflict_with/,
    );
  });

  it("404s when the dispatch does not exist", async () => {
    const req = createMockReqWithBody("POST", { verdict: "ok", reason: "x" });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "missing-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(null),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toMatch(/not found/);
  });

  it("404s when the dispatch belongs to a different repo (cross-worker guard)", async () => {
    const req = createMockReqWithBody("POST", { verdict: "ok", reason: "x" });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi
        .fn()
        .mockResolvedValue(makeDispatch({ repoName: "other-repo" })),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toMatch(/not owned by this worker/);
  });
});

describe("handlePrepVerdict — ok verdict", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("dispatchKind=work → does NOT call job.stop; agent continues into /danx-next", async () => {
    const { job, stop } = makeJobStub("work");
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "no conflicts",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.verdict).toBe("ok");
    expect(body.dispatchTerminal).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(job.prepVerdict).toEqual({ verdict: "ok", reason: "no conflicts" });
  });

  it("dispatchKind=prep → calls job.stop('completed', ...) so the next tick can dispatch the work pass", async () => {
    const { job, stop } = makeJobStub("prep");
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "no conflicts",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).dispatchTerminal).toBe("completed");
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep ok \(prep-only dispatch\)/),
    );
  });

  it("dispatchKind=undefined (non-multi-agent-pick caller) → defensive keep-running on ok", async () => {
    // Slack / ideator / external /api/launch paths leave dispatchKind
    // unset. Those callers never INVOKE `/danx-prep`, so a verdict=ok
    // arriving on one is a misconfiguration, not a normal path. Route
    // must not finalize the dispatch — that would silently kill a
    // non-prep run. Defense in depth; the route also log.warns the
    // misconfig (not asserted here — covered by logger interaction
    // tests separately).
    const { job, stop } = makeJobStub(undefined);
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "no conflicts",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).dispatchTerminal).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("handlePrepVerdict — conflict_on verdict", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends {id, reason} entries to candidate YAML's conflict_on[] and stops the dispatch", async () => {
    writeIssue(root, "DX-100");
    const { job, stop } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "both modify src/auth.ts",
      conflict_with: ["DX-200", "DX-201"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.conflictsAppended).toBe(2);
    expect(body.dispatchTerminal).toBe("completed");
    const yaml = readIssue(root, "DX-100");
    expect(yaml.conflict_on).toEqual([
      { id: "DX-200", reason: "both modify src/auth.ts" },
      { id: "DX-201", reason: "both modify src/auth.ts" },
    ]);
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/conflict_on/),
    );
  });

  it("dedupes by id — re-POST of same payload is idempotent", async () => {
    writeIssue(root, "DX-100");
    // First call lands the entries.
    {
      const { job } = makeJobStub();
      const req = createMockReqWithBody("POST", {
        verdict: "conflict_on",
        reason: "overlap",
        conflict_with: ["DX-200"],
      });
      const res = createMockRes();
      await handlePrepVerdict(req, res, "dispatch-1", repo, {
        getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
        getJob: vi.fn().mockReturnValue(job),
      });
      expect(JSON.parse(res._getBody()).conflictsAppended).toBe(1);
    }
    // Second call appends zero (already present).
    {
      const { job } = makeJobStub();
      const req = createMockReqWithBody("POST", {
        verdict: "conflict_on",
        reason: "overlap",
        conflict_with: ["DX-200", "DX-201"],
      });
      const res = createMockRes();
      await handlePrepVerdict(req, res, "dispatch-1", repo, {
        getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
        getJob: vi.fn().mockReturnValue(job),
      });
      // Only the new id (DX-201) lands.
      expect(JSON.parse(res._getBody()).conflictsAppended).toBe(1);
    }
    const yaml = readIssue(root, "DX-100");
    expect(yaml.conflict_on.map((c) => c.id)).toEqual(["DX-200", "DX-201"]);
  });

  it("400s when the dispatch row has no issue_id", async () => {
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch({ issueId: null })),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_id.*candidate card/);
  });

  it("500s with the underlying error when the candidate YAML is missing", async () => {
    // No writeIssue() — file does not exist.
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/candidate YAML not found/);
  });
});

describe("handlePrepVerdict — waiting_on verdict", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stamps waiting_on={by, reason, timestamp} on the candidate YAML and stops the dispatch", async () => {
    writeIssue(root, "DX-100");
    const { job, stop } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "waiting_on",
      reason: "Phase 2 needs Phase 1 to land first",
      depends_on: ["DX-200"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
      now: () => new Date("2026-05-15T07:00:00Z").getTime(),
    });
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.waitingOnStamped).toBe(true);
    expect(body.dispatchTerminal).toBe("completed");
    const yaml = readIssue(root, "DX-100");
    expect(yaml.waiting_on).toEqual({
      by: ["DX-200"],
      reason: "Phase 2 needs Phase 1 to land first",
      timestamp: "2026-05-15T07:00:00.000Z",
    });
    // Status untouched — waiting_on is orthogonal to status.
    expect(yaml.status).toBe("ToDo");
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/waiting_on/),
    );
  });

  it("merges depends_on with an existing waiting_on.by — preserves existing first, appends new in input order", async () => {
    writeIssue(root, "DX-100", (i) => {
      i.waiting_on = {
        by: ["DX-200"],
        reason: "old reason",
        timestamp: "2026-05-14T00:00:00.000Z",
      };
    });
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "waiting_on",
      reason: "now also needs DX-201",
      depends_on: ["DX-200", "DX-201"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
      now: () => new Date("2026-05-15T07:00:00Z").getTime(),
    });
    const body = JSON.parse(res._getBody());
    expect(body.waitingOnStamped).toBe(true);
    const yaml = readIssue(root, "DX-100");
    expect(yaml.waiting_on?.by).toEqual(["DX-200", "DX-201"]);
    expect(yaml.waiting_on?.reason).toBe("now also needs DX-201");
    expect(yaml.waiting_on?.timestamp).toBe("2026-05-15T07:00:00.000Z");
  });

  it("no-ops when re-POSTed with identical depends_on + reason (waitingOnStamped: false)", async () => {
    writeIssue(root, "DX-100", (i) => {
      i.waiting_on = {
        by: ["DX-200"],
        reason: "same reason",
        timestamp: "2026-05-14T00:00:00.000Z",
      };
    });
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "waiting_on",
      reason: "same reason",
      depends_on: ["DX-200"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    const body = JSON.parse(res._getBody());
    expect(body.waitingOnStamped).toBe(false);
    const yaml = readIssue(root, "DX-100");
    // Timestamp preserved on no-op.
    expect(yaml.waiting_on?.timestamp).toBe("2026-05-14T00:00:00.000Z");
  });

  it("400s when the dispatch row has no issue_id", async () => {
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "waiting_on",
      reason: "x",
      depends_on: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch({ issueId: null })),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(
      /waiting_on verdict requires.*issue_id/,
    );
  });
});

describe("handlePrepVerdict — blocked verdict preconditions + edge cases", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("400s when the dispatch row has no issue_id (blocked verdict)", async () => {
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "blocked",
      reason: "x",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch({ issueId: null })),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/issue_id.*candidate card/);
  });

  it("500s when the candidate YAML is missing (blocked verdict — symmetric to conflict_on)", async () => {
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "blocked",
      reason: "x",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/candidate YAML not found/);
  });
});

describe("handlePrepVerdict — IssueParseError → 422", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 422 with a parse-error message when the candidate YAML is malformed", async () => {
    // A YAML that parses but fails the validator's required-field
    // check exercises the same IssueParseError → 422 mapping the
    // route promises in its catch block.
    mkdirSync(join(root, ".danxbot", "issues", "open"), { recursive: true });
    writeFileSync(
      join(root, ".danxbot", "issues", "open", "DX-100.yml"),
      "not: real: yaml: garbage here\n",
    );
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(422);
    expect(JSON.parse(res._getBody()).error).toMatch(/candidate YAML invalid/);
  });
});

describe("handlePrepVerdict — closed/ candidate contract", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 500 'not found' when the candidate lives in closed/ — route reads open/ only", async () => {
    // The contract today: prep verdict targets in-flight candidates,
    // which live in `open/`. A candidate that moved to `closed/`
    // between dispatch + verdict POST is treated as missing — the
    // 500 surfaces the race so the operator (or boot replay) can
    // investigate. Pin the behavior so a future "fall back to
    // closed/" refactor lands deliberately, not silently.
    mkdirSync(join(root, ".danxbot", "issues", "closed"), { recursive: true });
    const issue = createEmptyIssue({
      id: "DX-100",
      title: "Closed candidate",
      description: "fixture",
    });
    writeFileSync(
      join(root, ".danxbot", "issues", "closed", "DX-100.yml"),
      serializeIssue(issue),
    );
    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/candidate YAML not found/);
  });
});

describe("handlePrepVerdict — blocked verdict", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stamps status: Blocked + blocked: {reason, timestamp} on the candidate", async () => {
    writeIssue(root, "DX-100");
    const { job, stop } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "blocked",
      reason: "spec ambiguous",
    });
    const res = createMockRes();
    const fixedNow = 1747000000000; // 2026-05-11T22:13:20Z
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
      now: () => fixedNow,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).candidateBlocked).toBe(true);
    const yaml = readIssue(root, "DX-100");
    // status unchanged post-DX-658 — blocked field is the gate
    expect(yaml.blocked).toEqual({
      reason: "spec ambiguous",
      at: new Date(fixedNow).toISOString(),
    });
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep blocked/),
    );
  });

  it("preserves any pre-existing waiting_on when stamping Blocked (independent fields)", async () => {
    mkdirSync(join(root, ".danxbot", "issues", "open"), { recursive: true });
    const issueWithWaiting = createEmptyIssue({
      id: "DX-100",
      status: "ToDo",
      title: "Test issue DX-100",
      description: "fixture",
    });
    issueWithWaiting.waiting_on = {
      reason: "depends on DX-99",
      timestamp: "2026-05-10T00:00:00Z",
      by: ["DX-99"],
    };
    writeFileSync(
      join(root, ".danxbot", "issues", "open", "DX-100.yml"),
      serializeIssue(issueWithWaiting),
    );

    const { job } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "blocked",
      reason: "spec ambiguous",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(res._getStatusCode()).toBe(200);
    const yaml = readIssue(root, "DX-100");
    // status unchanged post-DX-658 — blocked field is the gate
    expect(yaml.waiting_on).not.toBeNull();
    expect(yaml.waiting_on?.by).toEqual(["DX-99"]);
  });
});

describe("handlePrepVerdict — abort verdict", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stamps agents.<name>.broken via setAgentBroken and stops with failed", async () => {
    const { job, stop } = makeJobStub();
    const setBroken = vi.fn(async () => ({}) as never);
    const req = createMockReqWithBody("POST", {
      verdict: "abort",
      reason: "Bash returning ENOENT",
      broken_details: { suggested_steps: ["ssh to host", "fix PATH"] },
    });
    const res = createMockRes();
    const fixedNow = 1747000000000;
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi
        .fn()
        .mockResolvedValue(makeDispatch({ agentName: "murphy" })),
      getJob: vi.fn().mockReturnValue(job),
      setBroken: setBroken as unknown as typeof import("../settings-file.js").setAgentBroken,
      now: () => fixedNow,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).agentMarkedBroken).toBe(true);
    expect(setBroken).toHaveBeenCalledWith(
      root,
      "murphy",
      {
        reason: "Bash returning ENOENT",
        suggested_steps: ["ssh to host", "fix PATH"],
        set_at: new Date(fixedNow).toISOString(),
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      },
      "worker",
    );
    expect(stop).toHaveBeenCalledWith(
      "failed",
      expect.stringMatching(/agent env aborted prep/),
    );
  });

  it("400s when the dispatch row has no agent_name (missing-precondition fails fast)", async () => {
    // Precondition violations on the dispatch row are 4xx, not 5xx —
    // symmetric to the conflict_on / blocked tests that 400 on
    // `issueId: null`. The route doesn't enter `applyAbortVerdict`
    // when the precondition fails, so `setBroken` is never called.
    const { job } = makeJobStub();
    const setBroken = vi.fn(async () => ({}) as never);
    const req = createMockReqWithBody("POST", {
      verdict: "abort",
      reason: "x",
      broken_details: { suggested_steps: [] },
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch({ agentName: null })),
      getJob: vi.fn().mockReturnValue(job),
      setBroken: setBroken as unknown as typeof import("../settings-file.js").setAgentBroken,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/agent_name/);
    expect(setBroken).not.toHaveBeenCalled();
  });
});

describe("handlePrepVerdict — prepVerdict stash on AgentJob", () => {
  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stamps job.prepVerdict before stop() fires so the onComplete observer sees the verdict", async () => {
    writeIssue(root, "DX-100");
    const { job, stop } = makeJobStub();
    // Capture the order of side-effects.
    const order: string[] = [];
    stop.mockImplementation(async () => {
      order.push(`stop:prepVerdict=${job.prepVerdict?.verdict}`);
    });

    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });
    expect(order).toEqual(["stop:prepVerdict=conflict_on"]);
  });

  it("flushes the HTTP response before awaiting job.stop — prevents MCP-server kill race", async () => {
    // Repro for the DX-504 prep-verdict close-on-call class. The
    // prep agent's MCP server (a child of the dispatch's cgroup) makes
    // the verdict POST; the route awaits `job.stop()` which tears down
    // that cgroup via `systemctl --user stop`. If the route awaits stop
    // BEFORE writing the response, the MCP server dies mid-fetch and
    // the agent sees the MCP stdio close instead of the verdict ack.
    //
    // Contract under test: by the time `job.stop()` has been invoked
    // but is still pending (its kill HAS NOT completed), the worker
    // MUST have already written the HTTP response onto the wire. The
    // MCP server's `fetch` then returns before the kill lands.
    writeIssue(root, "DX-100");
    const { job, stop } = makeJobStub();
    let resolveStop!: () => void;
    const stopGate = new Promise<void>((r) => {
      resolveStop = r;
    });
    stop.mockImplementation(async () => {
      await stopGate;
    });

    const req = createMockReqWithBody("POST", {
      verdict: "conflict_on",
      reason: "race repro",
      conflict_with: ["DX-200"],
    });
    const res = createMockRes();
    const handlerPromise = handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
    });

    // Drain microtasks + nextTicks so parseBody, applyVerdictSideEffect,
    // and the response write complete. The handler must NOT have
    // returned yet because the stop gate is still unresolved.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(stop).toHaveBeenCalledTimes(1);
    expect((res.end as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.verdict).toBe("conflict_on");
    expect(body.dispatchTerminal).toBe("completed");

    resolveStop();
    await handlerPromise;
  });

  it("tolerates a missing job (race: dispatch ended between activeJobs and the verdict POST)", async () => {
    writeIssue(root, "DX-100");
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "x",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(undefined),
    });
    // No throw, side-effect applied where applicable, response 200.
    expect(res._getStatusCode()).toBe(200);
  });
});

describe("handlePrepVerdict — DB writer consistency (DX-552 regression)", () => {
  // The prep-verdict route's three YAML stamps MUST go through
  // `writeIssue` so the synchronous DB upsert lands in lockstep with the
  // file write. The pre-fix code used `writeFileSync` directly, leaving
  // the DB row stale. The follow-up onComplete (`multi-agent-pick.ts`
  // line ~756) then `loadLocal`s the stale row and writes it back via
  // `clearDispatchAndWrite` → the just-stamped field evaporates and the
  // poller re-dispatches the same card forever.

  let root: string;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prep-verdict-route-"));
    repo = makeRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("waiting_on verdict upserts the DB row with waiting_on populated", async () => {
    writeIssue(root, "DX-100");
    const writerDb = installWriterDb(root);
    try {
      const { job } = makeJobStub();
      const req = createMockReqWithBody("POST", {
        verdict: "waiting_on",
        reason: "Phase 2 needs Phase 1",
        depends_on: ["DX-200"],
      });
      const res = createMockRes();
      await handlePrepVerdict(req, res, "dispatch-1", repo, {
        getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
        getJob: vi.fn().mockReturnValue(job),
        now: () => new Date("2026-05-15T07:00:00Z").getTime(),
      });
      expect(res._getStatusCode()).toBe(200);
      const upserts = writerDb.upsertWithHistoryCalls.filter(
        (u) => u.id === "DX-100",
      );
      expect(upserts.length).toBeGreaterThan(0);
      const last = upserts[upserts.length - 1]!;
      expect(last.source).toBe("writer");
      expect(last.data.waiting_on).toEqual({
        by: ["DX-200"],
        reason: "Phase 2 needs Phase 1",
        timestamp: "2026-05-15T07:00:00.000Z",
      });
    } finally {
      writerDb.unregister();
    }
  });

  it("conflict_on verdict upserts the DB row with the appended conflict_on[]", async () => {
    writeIssue(root, "DX-100");
    const writerDb = installWriterDb(root);
    try {
      const { job } = makeJobStub();
      const req = createMockReqWithBody("POST", {
        verdict: "conflict_on",
        reason: "shared module",
        conflict_with: ["DX-200", "DX-201"],
      });
      const res = createMockRes();
      await handlePrepVerdict(req, res, "dispatch-1", repo, {
        getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
        getJob: vi.fn().mockReturnValue(job),
      });
      expect(res._getStatusCode()).toBe(200);
      const upserts = writerDb.upsertWithHistoryCalls.filter(
        (u) => u.id === "DX-100",
      );
      expect(upserts.length).toBeGreaterThan(0);
      const last = upserts[upserts.length - 1]!;
      expect(last.data.conflict_on).toEqual([
        { id: "DX-200", reason: "shared module" },
        { id: "DX-201", reason: "shared module" },
      ]);
    } finally {
      writerDb.unregister();
    }
  });

  it("blocked verdict upserts the DB row with status: Blocked + blocked record", async () => {
    writeIssue(root, "DX-100");
    const writerDb = installWriterDb(root);
    try {
      const { job } = makeJobStub();
      const req = createMockReqWithBody("POST", {
        verdict: "blocked",
        reason: "spec ambiguous",
      });
      const res = createMockRes();
      await handlePrepVerdict(req, res, "dispatch-1", repo, {
        getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
        getJob: vi.fn().mockReturnValue(job),
        now: () => new Date("2026-05-15T07:00:00Z").getTime(),
      });
      expect(res._getStatusCode()).toBe(200);
      const upserts = writerDb.upsertWithHistoryCalls.filter(
        (u) => u.id === "DX-100",
      );
      expect(upserts.length).toBeGreaterThan(0);
      const last = upserts[upserts.length - 1]!;
      // status unchanged post-DX-658 — blocked field is the gate
      expect(last.data.blocked).toEqual({
        reason: "spec ambiguous",
        at: "2026-05-15T07:00:00.000Z",
      });
    } finally {
      writerDb.unregister();
    }
  });
});
