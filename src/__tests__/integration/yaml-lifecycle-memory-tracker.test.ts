/**
 * Phase 4 verification — agents work the YAML + danx_issue_save flow
 * end-to-end against MemoryTracker, with zero `mcp__trello__*` calls in
 * the dispatched session JSONL.
 *
 * AC #6 of the Phase 4 card (Trello LDBhbd61) demands that the full card
 * lifecycle (ToDo → In Progress → Done OR ToDo → In Progress → Needs Help)
 * works against a tracker-agnostic backend. A strict reading would require
 * a Layer 3 system test driven by `make test-system` against a Docker
 * worker booted with `DANXBOT_TRACKER=memory` — but the poller's
 * `fetchTodoCards` still reads Trello directly today (Phase 5 refactor),
 * so the Layer 3 harness can't drive a MemoryTracker through the poller
 * yet. The integration test here covers the agent-side guarantee Phase 4
 * actually delivers: given a pre-hydrated YAML and a /api/launch dispatch,
 * the agent moves the card to its terminal state by editing the YAML and
 * calling `danx_issue_save`, and the dispatched JSONL contains NO
 * `mcp__trello__*` tool calls.
 *
 * The "no mcp__trello__" property is structurally guaranteed by the
 * workspace's `.mcp.json` (Trello server entry removed in this same
 * phase), so this test is a regression-pin: a future agent
 * reintroducing Trello MCP into the workspace + drifting fake-claude
 * to call it would be caught here.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

// --- Infrastructure mocks (mirror critical-failure-end-to-end.test.ts) ---

const { testState, mockConfig } = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  return {
    testState: {
      logsDir: fs.mkdtempSync(
        path.join(os.tmpdir(), "danxbot-yaml-test-logs-"),
      ),
      reposBase: "/tmp/danxbot-yaml-test-repos",
    },
    mockConfig: {
      runtime: "docker",
      isHost: false,
      dispatch: {
        defaultApiUrl: "http://localhost:80",
        agentTimeoutMs: 60_000,
        mcpProbeTimeoutMs: 3_000,
      },
      pollerIntervalMs: 60_000,
      pollerBackoffScheduleMs: [1_000, 2_000, 4_000],
      logsDir: "",
    },
  };
});

mockConfig.logsDir = testState.logsDir;

vi.mock("../../config.js", () => ({
  config: mockConfig,
  isWorkerMode: true,
  isDashboardMode: false,
  workerRepoName: "test-repo",
  repos: [],
}));

vi.mock("../../poller/constants.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../poller/constants.js")
  >("../../poller/constants.js");
  return {
    ...actual,
    getReposBase: () => testState.reposBase,
  };
});

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../terminal.js", () => ({
  buildDispatchScript: vi.fn(),
  getTerminalLogPath: vi.fn(),
  spawnInTerminal: vi.fn(),
}));

vi.mock("../../worker/url-normalizer.js", () => ({
  normalizeCallbackUrl: (url: string | undefined) => url,
}));

vi.mock("../../agent/mcp-server-probe.js", () => ({
  probeAllMcpServers: vi.fn().mockResolvedValue({ ok: true, failures: [] }),
}));

vi.mock("../../slack/listener.js", () => ({
  getSlackClientForRepo: vi.fn(),
  startSlackListener: vi.fn(),
}));

vi.mock("../../repo-context.js", () => ({
  repoContexts: [],
  loadRepoContext: vi.fn(),
  getRepoContext: vi.fn(),
}));

// MemoryTracker drives the YAML save path. The test seeds it manually
// per-scenario via `setIssueTracker(seedIssue)` so the per-issue
// external_id matches what the YAML on disk says.
import { MemoryTracker } from "../../issue-tracker/memory.js";
import type { Issue } from "../../issue-tracker/interface.js";
const issueTrackerMock = vi.hoisted(() => ({
  tracker: null as MemoryTracker | null,
}));
function setIssueTracker(seed: Issue): {
  addCommentCalls: Array<{ externalId: string; text: string }>;
  spawnedActionItems: string[];
} {
  const tracker = new MemoryTracker();
  const addCommentCalls: Array<{ externalId: string; text: string }> = [];
  const spawnedActionItems: string[] = [];
  let nextCommentSeq = 0;
  // Bypass MemoryTracker's auto-id-mint: install stubs that return the
  // pre-shaped issue regardless of the lookup key. The worker calls
  // `getCard`, `getComments`, and the various mutation helpers as part of
  // sync.ts's local-as-truth diff. Stubbing read methods to echo the seed
  // is enough — the writes will be issued against MemoryTracker's real
  // store, but `runSync` only mutates remote when local diverges. Echoing
  // the agent's final on-disk YAML keeps the diff small and the test
  // focused on the reachability of the YAML round-trip, not on
  // MemoryTracker-internal write semantics (those have their own unit
  // suite).
  tracker.getCard = async (_id: string) => seed;
  tracker.getComments = async (_id: string) => [];
  tracker.updateCard = async () => undefined;
  tracker.moveToStatus = async () => undefined;
  tracker.setLabels = async () => undefined;
  tracker.addAcItem = async () => ({ check_item_id: "" });
  tracker.updateAcItem = async () => undefined;
  tracker.deleteAcItem = async () => undefined;
  tracker.addPhaseItem = async () => ({ check_item_id: "" });
  tracker.updatePhaseItem = async () => undefined;
  tracker.deletePhaseItem = async () => undefined;
  tracker.addComment = async (externalId: string, text: string) => {
    addCommentCalls.push({ externalId, text });
    nextCommentSeq += 1;
    return {
      id: `comment-${nextCommentSeq}`,
      timestamp: new Date().toISOString(),
    };
  };
  tracker.editComment = async () => undefined;
  issueTrackerMock.tracker = tracker;
  return { addCommentCalls, spawnedActionItems };
}
vi.mock("../../issue-tracker/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../issue-tracker/index.js")
  >("../../issue-tracker/index.js");
  return {
    ...actual,
    createIssueTracker: () => {
      if (!issueTrackerMock.tracker) {
        throw new Error(
          "Test setup: setIssueTracker(issue) must be called before /api/launch",
        );
      }
      return issueTrackerMock.tracker;
    },
  };
});

vi.mock("../../dashboard/dispatches-db.js", () => ({
  insertDispatch: vi.fn().mockResolvedValue(undefined),
  updateDispatch: vi.fn().mockResolvedValue(undefined),
  getDispatchById: vi.fn().mockResolvedValue(null),
}));

// --- Real imports (the pipeline under test) ---

import { startWorkerServer } from "../../worker/server.js";
import { deriveSessionDir } from "../../agent/session-log-watcher.js";
import {
  _resetForTesting as resetDispatchCore,
  _drainPendingCleanupsForTesting as drainPendingCleanupsForTesting,
  listActiveJobs,
} from "../../dispatch/core.js";
import { _resetForTesting as resetPollerState } from "../../poller/index.js";
import {
  _resetForTesting as resetIssueRoute,
  _drainAsyncWorkForTesting as drainIssueRouteAsyncWork,
} from "../../worker/issue-route.js";
import { ensureIssuesDirs, issuePath } from "../../poller/yaml-lifecycle.js";
import { serializeIssue, parseIssue } from "../../issue-tracker/yaml.js";
import { CaptureServer } from "./helpers/capture-server.js";
import { makeRepoContext } from "../helpers/fixtures.js";
import type { RepoContext } from "../../types.js";

// --- Test helpers ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const fakeClaude = resolve(__dirname, "helpers/fake-claude.ts");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");

let captureServer: CaptureServer;
let workerServer: Server | undefined;
let workerPort: number;
let tempDir: string;
let repoDir: string;
let fakeBinDir: string;
let repo: RepoContext;
let originalPath: string | undefined;
let originalEnvKeys: Set<string>;
let workspaceSessionDir: string;

function createClaudeWrapper(binDir: string): void {
  const wrapperPath = join(binDir, "claude");
  writeFileSync(
    wrapperPath,
    `#!/bin/bash\nexec "${tsxBin}" "${fakeClaude}" "$@"\n`,
  );
  chmodSync(wrapperPath, 0o755);
}

function writeWorkspaceFixture(workspaceName: string): void {
  const wsDir = join(repoDir, ".danxbot", "workspaces", workspaceName);
  mkdirSync(join(wsDir, ".claude"), { recursive: true });
  writeFileSync(
    join(wsDir, "workspace.yml"),
    "name: " +
      workspaceName +
      "\n" +
      "description: e2e fixture\n" +
      "required-placeholders: []\n" +
      "optional-placeholders: []\n" +
      "required-gates: []\n",
  );
  writeFileSync(join(wsDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(
    join(wsDir, ".claude", "settings.json"),
    JSON.stringify({ env: {} }),
  );
  writeFileSync(
    join(wsDir, "CLAUDE.md"),
    "# " + workspaceName + " workspace\n",
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function reservePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const tmp = createServer();
    tmp.unref();
    tmp.on("error", rej);
    tmp.listen(0, () => {
      const addr = tmp.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      tmp.close(() => res(port));
    });
  });
}

function buildSeedIssue(externalId: string, status: Issue["status"]): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    id: `ISS-${Math.floor(Math.random() * 9000) + 1000}`,
    external_id: externalId,
    parent_id: null,
    children: [],
    dispatch_id: null,
    status,
    type: "Feature",
    title: "yaml-lifecycle seed card",
    description: "Drive the Phase 4 YAML round-trip end-to-end.",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [
      { check_item_id: "ac-1", title: "First criterion holds", checked: false },
      {
        check_item_id: "ac-2",
        title: "Second criterion holds",
        checked: false,
      },
    ],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
  };
}

function readJsonlEntries(): unknown[] {
  if (!existsSync(workspaceSessionDir)) return [];
  const files = readdirSync(workspaceSessionDir).filter((f) =>
    f.endsWith(".jsonl"),
  );
  const out: unknown[] = [];
  for (const file of files) {
    const raw = readFileSync(join(workspaceSessionDir, file), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignore malformed line — fake-claude writes one entry per line
      }
    }
  }
  return out;
}

// --- Lifecycle ---

beforeAll(() => {
  captureServer = new CaptureServer();
  originalPath = process.env.PATH;
  originalEnvKeys = new Set(Object.keys(process.env));
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetIssueRoute();
  await captureServer.start();

  tempDir = mkdtempSync(join(tmpdir(), "danxbot-yaml-integ-"));
  fakeBinDir = join(tempDir, "bin");
  mkdirSync(fakeBinDir);
  createClaudeWrapper(fakeBinDir);

  testState.reposBase = join(tempDir, "repos");
  repoDir = join(testState.reposBase, "test-repo");
  mkdirSync(join(repoDir, ".danxbot"), { recursive: true });

  // Phase 4 dispatches resolve workspace `issue-worker`. The fixture
  // here is intentionally minimal — the dispatched fake-claude reads the
  // YAML path + URLs from env / --mcp-config, not from the workspace
  // skill files. The skill content lives in src/poller/inject/.../ and
  // is covered by `workspace-shape.test.ts`.
  writeWorkspaceFixture("issue-worker");

  ensureIssuesDirs(repoDir);

  workerPort = await reservePort();

  repo = makeRepoContext({
    name: "test-repo",
    localPath: repoDir,
    workerPort,
    trello: {
      apiKey: "test-trello-key",
      apiToken: "test-trello-token",
      boardId: "test-board",
      reviewListId: "list-review",
      todoListId: "list-todo",
      inProgressListId: "list-inprog",
      needsHelpListId: "list-needshelp",
      doneListId: "list-done",
      cancelledListId: "list-cancelled",
      actionItemsListId: "list-actionitems",
      bugLabelId: "label-bug",
      featureLabelId: "label-feature",
      epicLabelId: "label-epic",
      needsHelpLabelId: "label-needshelp",
      blockedLabelId: "label-blocked",
    },
  });

  workspaceSessionDir = deriveSessionDir(
    join(repoDir, ".danxbot", "workspaces", "issue-worker"),
  );

  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
  process.env.FAKE_CLAUDE_LINGER_MS = "300";
  process.env.FAKE_CLAUDE_WRITE_DELAY_MS = "10";
  process.env.FAKE_CLAUDE_SCENARIO = "yaml-lifecycle";
  process.env.FAKE_CLAUDE_SESSION_DIR = workspaceSessionDir;

  workerServer = await startWorkerServer(repo);
});

afterEach(async () => {
  if (workerServer) {
    await new Promise<void>((res) => workerServer!.close(() => res()));
    workerServer = undefined;
  }
  // Drain in-flight dispatch cleanups (incl. EventForwarder flushes
  // writing to <logsDir>/event-queue/) BEFORE shutting down the
  // capture server. The forwarder POSTs to captureServer.statusUrl;
  // stopping the server first turns drainAndSend into a 60-second
  // exponential-backoff retry loop and trips the 10 s afterEach hook
  // timeout. Drain first → captureServer.stop() second is the
  // correct teardown order. Trello 69f77e9b77472aefac1317b2.
  await drainPendingCleanupsForTesting();
  await captureServer.stop();
  resetPollerState();
  resetDispatchCore();
  // Drain any pending issue-route async sync work so test isolation
  // holds: a stale post-save sync from this test must not run after the
  // next test's setIssueTracker swap, which would cross-contaminate
  // tracker mocks.
  await drainIssueRouteAsyncWork();
  resetIssueRoute();

  process.env.PATH = originalPath;
  for (const key of Object.keys(process.env)) {
    if (!originalEnvKeys.has(key)) {
      delete process.env[key];
    }
  }

  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  // Defense-in-depth: every test's afterEach already drains, but if a
  // test fails before its afterEach completes (vitest still runs
  // afterAll regardless), the activeJobs registry may still hold a
  // dispatch with an in-flight forwarder flush. Drain again so the
  // rmSync below cannot race a pending appendFile / writeFile.
  await drainPendingCleanupsForTesting();
  if (existsSync(testState.logsDir)) {
    rmSync(testState.logsDir, { recursive: true, force: true });
  }
});

// --- Tests ---

describe("Integration: YAML lifecycle vs MemoryTracker (Phase 4 AC #6)", () => {
  it("ToDo → In Progress → Done flips the YAML, moves it open/ → closed/, and emits zero mcp__trello__ calls", async () => {
    const externalId = "mem-yaml-1";
    const seed = buildSeedIssue(externalId, "ToDo");
    const { addCommentCalls } = setIssueTracker(seed);

    // Filename = internal id, NOT external_id. The save handler is also
    // keyed by internal id, so fake-claude's `danx_issue_save({id})` body
    // must use the same value.
    const yamlOpenPath = issuePath(repoDir, seed.id, "open");
    writeFileSync(yamlOpenPath, serializeIssue(seed));

    process.env.FAKE_CLAUDE_YAML_PATH = yamlOpenPath;
    process.env.FAKE_CLAUDE_EXTERNAL_ID = seed.id;
    process.env.FAKE_CLAUDE_YAML_FINAL_STATUS = "Done";

    const launchRes = await fetch(`http://localhost:${workerPort}/api/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "issue-worker",
        task: `Drive the Phase 4 YAML lifecycle for ${externalId}`,
        api_token: "test-token",
        status_url: captureServer.statusUrl,
      }),
    });
    expect(launchRes.status).toBe(200);
    const { job_id } = (await launchRes.json()) as { job_id: string };
    expect(job_id).toBeTruthy();

    // Wait for /api/status to report a terminal state.
    await waitFor(
      async () => {
        const res = await fetch(
          `http://localhost:${workerPort}/api/status/${job_id}`,
        );
        if (res.status !== 200) return false;
        const body = (await res.json()) as { status: string };
        return body.status !== "running";
      },
      15_000,
      "/api/status to report terminal",
    );

    const statusRes = await fetch(
      `http://localhost:${workerPort}/api/status/${job_id}`,
    );
    expect(await statusRes.json()).toMatchObject({
      job_id,
      status: "completed",
    });

    // The second `danx_issue_save` call (with status=Done) is what
    // triggers `persistAfterSync` to move the file open/ → closed/.
    // `handleIssueSave` returns `{saved: true}` synchronously, then
    // schedules `runSync` → `persistAfterSync` on the per-issue mutex
    // chain. Drain that chain before asserting on disk state. Auto-sync
    // via `danxbot_complete` does NOT move the file in this test —
    // `getDispatchById` is mocked to return null (line where
    // `dashboard/dispatches-db` is mocked), so `autoSyncTrackedIssue`
    // returns early. The agent's explicit second save is what matters.
    await drainIssueRouteAsyncWork();

    const yamlClosedPath = issuePath(repoDir, seed.id, "closed");
    expect(existsSync(yamlClosedPath)).toBe(true);
    expect(existsSync(yamlOpenPath)).toBe(false);

    const persisted = parseIssue(readFileSync(yamlClosedPath, "utf-8"));
    expect(persisted.status).toBe("Done");
    expect(persisted.ac.every((a) => a.checked)).toBe(true);

    const entries = readJsonlEntries() as Array<Record<string, unknown>>;
    // The fake-claude scenario MUST have emitted at least the
    // danx_issue_save tool calls; this anchors the assertion below
    // (so a regression that produces an empty JSONL doesn't trivially
    // satisfy "no mcp__trello__").
    const issueSaveCalls = entries.filter((e) => {
      if (e.type !== "assistant") return false;
      const message = e.message as { content?: Array<Record<string, unknown>> };
      return (message.content ?? []).some(
        (c) =>
          c.type === "tool_use" && c.name === "mcp__danxbot__danx_issue_save",
      );
    });
    expect(issueSaveCalls.length).toBeGreaterThanOrEqual(2);

    const trelloCalls = entries.filter((e) => {
      if (e.type !== "assistant") return false;
      const message = e.message as { content?: Array<Record<string, unknown>> };
      return (message.content ?? []).some(
        (c) =>
          c.type === "tool_use" &&
          typeof c.name === "string" &&
          c.name.startsWith("mcp__trello__"),
      );
    });
    expect(trelloCalls).toEqual([]);

    // Phase 5: the worker-side retro renderer must post a single
    // `## Retro` comment carrying both danxbot markers, derived from the
    // YAML's retro fields (fake-claude fills retro.good / retro.bad before
    // the terminal save). fake-claude no longer appends a manual retro
    // comment to comments[] — the worker is the single source of retro
    // rendering on terminal-status save.
    const retroPosts = addCommentCalls.filter((c) =>
      c.text.includes("<!-- danxbot-retro -->"),
    );
    expect(
      retroPosts,
      `expected exactly one worker-rendered retro comment; saw ${addCommentCalls
        .map((c) => c.text.slice(0, 80))
        .join(" | ")}`,
    ).toHaveLength(1);
    expect(retroPosts[0].text).toContain("## Retro");
    expect(retroPosts[0].text).toContain(
      "**What went well:** Test ran cleanly.",
    );
    expect(retroPosts[0].text).toContain("**What went wrong:** Nothing.");
    expect(retroPosts[0].text.startsWith("<!-- danxbot -->\n")).toBe(true);
  }, 30_000);

  it("ToDo → In Progress → Needs Help leaves the YAML in open/, status=Needs Help, ACs unchanged", async () => {
    const externalId = "mem-yaml-2";
    const seed = buildSeedIssue(externalId, "ToDo");
    setIssueTracker(seed);

    // Filename = internal id, NOT external_id. The save handler is also
    // keyed by internal id, so fake-claude's `danx_issue_save({id})` body
    // must use the same value.
    const yamlOpenPath = issuePath(repoDir, seed.id, "open");
    writeFileSync(yamlOpenPath, serializeIssue(seed));

    process.env.FAKE_CLAUDE_YAML_PATH = yamlOpenPath;
    process.env.FAKE_CLAUDE_EXTERNAL_ID = seed.id;
    process.env.FAKE_CLAUDE_YAML_FINAL_STATUS = "Needs Help";

    const launchRes = await fetch(`http://localhost:${workerPort}/api/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "issue-worker",
        task: `Drive the Phase 4 Needs Help branch for ${externalId}`,
        api_token: "test-token",
        status_url: captureServer.statusUrl,
      }),
    });
    expect(launchRes.status).toBe(200);
    const { job_id } = (await launchRes.json()) as { job_id: string };

    await waitFor(
      async () => {
        const res = await fetch(
          `http://localhost:${workerPort}/api/status/${job_id}`,
        );
        if (res.status !== 200) return false;
        const body = (await res.json()) as { status: string };
        return body.status !== "running";
      },
      15_000,
      "/api/status to report terminal",
    );

    await drainIssueRouteAsyncWork();

    // Needs Help is NOT a terminal status for `persistAfterSync` —
    // file stays in open/.
    expect(existsSync(yamlOpenPath)).toBe(true);
    expect(existsSync(issuePath(repoDir, seed.id, "closed"))).toBe(false);

    const persisted = parseIssue(readFileSync(yamlOpenPath, "utf-8"));
    expect(persisted.status).toBe("Needs Help");
    // ACs not auto-checked on Needs Help branch.
    expect(persisted.ac.some((a) => !a.checked)).toBe(true);

    const entries = readJsonlEntries() as Array<Record<string, unknown>>;
    const trelloCalls = entries.filter((e) => {
      if (e.type !== "assistant") return false;
      const message = e.message as { content?: Array<Record<string, unknown>> };
      return (message.content ?? []).some(
        (c) =>
          c.type === "tool_use" &&
          typeof c.name === "string" &&
          c.name.startsWith("mcp__trello__"),
      );
    });
    expect(trelloCalls).toEqual([]);
  }, 30_000);

  it("Needs Help → In Progress → Done recovery flips the YAML to Done and closes it (AC #6 linear lifecycle)", async () => {
    // AC #6 spec lifecycle: ToDo → In Progress → Needs Help → Done. The
    // first test covers the happy-path Done. The Needs Help test covers
    // the blocker branch. This third test covers the *recovery* leg —
    // an agent dispatched against a YAML already at Needs Help (operator
    // unblocked it) drives it through to Done. Same external_id, same
    // YAML file, second dispatch.
    const externalId = "mem-yaml-3";
    const seed = buildSeedIssue(externalId, "Needs Help");
    setIssueTracker(seed);

    // Filename = internal id, NOT external_id. The save handler is also
    // keyed by internal id, so fake-claude's `danx_issue_save({id})` body
    // must use the same value.
    const yamlOpenPath = issuePath(repoDir, seed.id, "open");
    writeFileSync(yamlOpenPath, serializeIssue(seed));

    process.env.FAKE_CLAUDE_YAML_PATH = yamlOpenPath;
    process.env.FAKE_CLAUDE_EXTERNAL_ID = seed.id;
    process.env.FAKE_CLAUDE_YAML_FINAL_STATUS = "Done";

    const launchRes = await fetch(`http://localhost:${workerPort}/api/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "issue-worker",
        task: `Resume blocker recovery for ${externalId}`,
        api_token: "test-token",
        status_url: captureServer.statusUrl,
      }),
    });
    expect(launchRes.status).toBe(200);
    const { job_id } = (await launchRes.json()) as { job_id: string };

    await waitFor(
      async () => {
        const res = await fetch(
          `http://localhost:${workerPort}/api/status/${job_id}`,
        );
        if (res.status !== 200) return false;
        const body = (await res.json()) as { status: string };
        return body.status !== "running";
      },
      15_000,
      "/api/status to report terminal",
    );

    await drainIssueRouteAsyncWork();

    const yamlClosedPath = issuePath(repoDir, seed.id, "closed");
    expect(existsSync(yamlClosedPath)).toBe(true);
    expect(existsSync(yamlOpenPath)).toBe(false);

    const persisted = parseIssue(readFileSync(yamlClosedPath, "utf-8"));
    expect(persisted.status).toBe("Done");
    expect(persisted.ac.every((a) => a.checked)).toBe(true);

    const entries = readJsonlEntries() as Array<Record<string, unknown>>;
    const trelloCalls = entries.filter((e) => {
      if (e.type !== "assistant") return false;
      const message = e.message as { content?: Array<Record<string, unknown>> };
      return (message.content ?? []).some(
        (c) =>
          c.type === "tool_use" &&
          typeof c.name === "string" &&
          c.name.startsWith("mcp__trello__"),
      );
    });
    expect(trelloCalls).toEqual([]);
  }, 30_000);

  // Regression guard for Trello 69f77e9b77472aefac1317b2: the previous
  // unhandled-rejection fix (commit fa15457) wrapped `drainAndSend` so
  // ENOENT no longer escapes from the inner appendFile/writeFile calls,
  // but did NOT address the underlying TEARDOWN LEAK — the EventForwarder
  // continued doing async work AFTER the test resolved, which (a) kept
  // vitest's event loop warm and (b) re-introduced the rejection class
  // the moment the inner catch is removed.
  //
  // Two structural guarantees this test pins:
  // 1. `_drainPendingCleanupsForTesting()` exists in dispatch/core.ts and
  //    awaits every `_cleanup()` + `_forwarderFlush` for jobs in
  //    `listActiveJobs()`.
  // 2. After the helper resolves, the queue dir can be removed without
  //    producing any unhandled rejection or escaping ENOENT — the
  //    process.on("unhandledRejection") listener filtered to this
  //    test's logsDir would catch any leak.
  it("_drainPendingCleanupsForTesting awaits forwarder writes so subsequent rmSync produces no ENOENT", async () => {
    const externalId = "mem-yaml-drain";
    const seed = buildSeedIssue(externalId, "ToDo");
    setIssueTracker(seed);

    const yamlOpenPath = issuePath(repoDir, seed.id, "open");
    writeFileSync(yamlOpenPath, serializeIssue(seed));

    process.env.FAKE_CLAUDE_YAML_PATH = yamlOpenPath;
    process.env.FAKE_CLAUDE_EXTERNAL_ID = seed.id;
    process.env.FAKE_CLAUDE_YAML_FINAL_STATUS = "Done";

    const launchRes = await fetch(`http://localhost:${workerPort}/api/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "issue-worker",
        task: `Drive lifecycle to verify drain helper`,
        api_token: "test-token",
        status_url: captureServer.statusUrl,
      }),
    });
    expect(launchRes.status).toBe(200);
    const { job_id } = (await launchRes.json()) as { job_id: string };

    await waitFor(
      async () => {
        const res = await fetch(
          `http://localhost:${workerPort}/api/status/${job_id}`,
        );
        if (res.status !== 200) return false;
        const body = (await res.json()) as { status: string };
        return body.status !== "running";
      },
      15_000,
      "/api/status to report terminal",
    );

    await drainIssueRouteAsyncWork();

    // Drain forwarder activity. After this resolves, all in-flight
    // cleanups (including the runCleanup chain that sets
    // `job._forwarderFlush`) have completed and no pending writes to
    // the event-queue file remain.
    await drainPendingCleanupsForTesting();

    // Post-drain assertion: the dispatched job is still in activeJobs
    // (TTL grace window) and exposes the forwarder flush promise the
    // launcher set during runCleanup. This pins the launcher contract:
    // every dispatch with `eventForwarding` enabled MUST surface the
    // flush as `_forwarderFlush` so the drain helper above has
    // something to await.
    const jobsAfterDrain = listActiveJobs();
    expect(jobsAfterDrain.length).toBeGreaterThanOrEqual(1);
    const dispatchedJob = jobsAfterDrain.find((j) => j.id === job_id);
    expect(dispatchedJob).toBeDefined();
    expect(dispatchedJob!._forwarderFlush).toBeInstanceOf(Promise);

    // Filter to ONLY this test's logsDir so any cross-test interference
    // doesn't false-fail the assertion. The unhandled rejection we're
    // guarding against has the testState.logsDir embedded in the ENOENT
    // path.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      const message = String((reason as Error)?.message ?? reason);
      if (message.includes(testState.logsDir)) unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Nuke the event-queue subdir directly so any in-flight writes
      // would ENOENT instantly. testState.logsDir itself stays intact
      // for afterAll's full removal.
      rmSync(join(testState.logsDir, "event-queue"), {
        recursive: true,
        force: true,
      });
      // Yield long enough for any pending appendFile / writeFile to
      // settle. Two macrotask hops covers the libuv fs callback + any
      // microtask drain — same shape as the laravel-forwarder unit test
      // for "BATCH_SIZE-triggered drain produces no unhandled rejection".
      await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  }, 30_000);
});
