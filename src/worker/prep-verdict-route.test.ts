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

/** Build a minimal AgentJob stub. The route only uses `stop` + `prepVerdict`. */
function makeJobStub() {
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
    stop,
  } as unknown as AgentJob;
  return { job, stop };
}

/** Write a v7 Issue to `<root>/.danxbot/issues/open/<id>.yml`. */
function writeIssue(root: string, id: string, status: "ToDo" | "Blocked" = "ToDo") {
  mkdirSync(join(root, ".danxbot", "issues", "open"), { recursive: true });
  // `title` is parser-required non-empty; use a stable test fixture body.
  const issue = createEmptyIssue({
    id,
    status,
    title: `Test issue ${id}`,
    description: "fixture",
  });
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

  it("400s on legacy waiting_on verdict — rename hint", async () => {
    const req = createMockReqWithBody("POST", {
      verdict: "waiting_on",
      reason: "x",
      conflict_with: ["DX-1"],
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn(),
      getJob: vi.fn(),
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/renamed to "conflict_on"/);
  });

  it("400s on legacy blocked_by arg — rename hint", async () => {
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
    expect(JSON.parse(res._getBody()).error).toMatch(/renamed to "conflict_with"/);
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

  it("combined mode → does NOT call job.stop; agent continues into work", async () => {
    const { job, stop } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "no conflicts",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
      getMode: vi.fn().mockReturnValue("combined"),
    });
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.verdict).toBe("ok");
    expect(body.dispatchTerminal).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(job.prepVerdict).toEqual({ verdict: "ok", reason: "no conflicts" });
  });

  it("separate mode → calls job.stop('completed', ...)", async () => {
    const { job, stop } = makeJobStub();
    const req = createMockReqWithBody("POST", {
      verdict: "ok",
      reason: "no conflicts",
    });
    const res = createMockRes();
    await handlePrepVerdict(req, res, "dispatch-1", repo, {
      getDispatch: vi.fn().mockResolvedValue(makeDispatch()),
      getJob: vi.fn().mockReturnValue(job),
      getMode: vi.fn().mockReturnValue("separate"),
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).dispatchTerminal).toBe("completed");
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep ok \(separate mode\)/),
    );
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
    expect(yaml.status).toBe("Blocked");
    expect(yaml.blocked).toEqual({
      reason: "spec ambiguous",
      timestamp: new Date(fixedNow).toISOString(),
    });
    expect(stop).toHaveBeenCalledWith(
      "completed",
      expect.stringMatching(/prep blocked/),
    );
  });

  it("clears any pre-existing waiting_on so the v7 parser invariant holds (Blocked + waiting_on != null is rejected)", async () => {
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
    expect(yaml.status).toBe("Blocked");
    expect(yaml.waiting_on).toBeNull();
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
      getMode: vi.fn().mockReturnValue("combined"),
    });
    // No throw, side-effect applied where applicable, response 200.
    expect(res._getStatusCode()).toBe(200);
  });
});
