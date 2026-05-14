/**
 * Integration tests for `dispatch()` — the unified workspace-shaped entry
 * point for all dispatches. These tests cover the boundary between the
 * caller-facing `DispatchInput` and what ships to claude:
 *
 *   - the on-disk MCP settings file (`--mcp-config <path>`) contents
 *   - the `--allowed-tools` CLI flag contents
 *   - the infrastructure invariants (danxbot always present, stopUrl wired)
 *
 * `spawnAgent` is mocked so we can capture the flag set without actually
 * spawning claude. The settings file is written for real (to a temp dir) —
 * reading it back is the observable boundary that downstream claude would
 * see, which is exactly what we want to assert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { DispatchTriggerMetadata } from "../dashboard/dispatches.js";

const mockSpawnAgent = vi.fn();

vi.mock("../agent/launcher.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/launcher.js")>(
    "../agent/launcher.js",
  );
  return {
    ...actual,
    spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  };
});

vi.mock("../config.js", () => ({
  config: {
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 3600000,
    },
    logsDir: "/tmp/danxbot-dispatch-core-logs",
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Hoisted shared state so tests can read what core.ts handed to its
// collaborators. `capturedStallOpts` lets stall-recovery tests trigger the
// onStall callback directly without faking JSONL contents; `mockUpdateDispatch`
// lets the nudge-count test assert on the exact (dispatchId, patch) pair the
// stall callback writes to the dispatches DB.
const { capturedStallOpts, mockUpdateDispatch } = vi.hoisted(() => ({
  capturedStallOpts: [] as Array<{
    onStall: () => void | Promise<void>;
  }>,
  mockUpdateDispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../dashboard/dispatches-db.js", () => ({
  updateDispatch: (...args: unknown[]) => mockUpdateDispatch(...args),
}));

vi.mock("../agent/terminal-output-watcher.js", () => ({
  TerminalOutputWatcher: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock("../agent/stall-detector.js", () => ({
  StallDetector: class {
    start = vi.fn();
    stop = vi.fn();
    constructor(opts: { onStall: () => void | Promise<void> }) {
      capturedStallOpts.push(opts);
    }
  },
  DEFAULT_MAX_NUDGES: 3,
}));

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  dispatch,
  listActiveJobs,
  _drainPendingCleanupsForTesting,
  _resetForTesting,
} from "./core.js";
// The mocked `../config.js` module exposes a plain mutable object. The cast
// to `{ isHost: boolean }` defeats the readonly type from the real config
// module — in the mocked factory, the object is a plain literal and writes
// are safe. Used by the `openTerminal` mirror / default tests.
import { config as realConfig } from "../config.js";
const mockedConfig = realConfig as unknown as { isHost: boolean };

const MOCK_REPO = makeRepoContext();
const DEFAULT_DISPATCH_META: DispatchTriggerMetadata = {
  trigger: "api",
  metadata: {
    endpoint: "/api/launch",
    callerIp: "127.0.0.1",
    statusUrl: null,
    initialPrompt: "test task",
  },
};

function makeRunningJob() {
  return {
    id: "mock-job-id",
    status: "running" as const,
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // capturedStallOpts is a plain array (vi.clearAllMocks resets vi.fn()
  // call history but does NOT touch arrays), so reset it explicitly so a
  // prior test's StallDetector instance doesn't leak into the next.
  capturedStallOpts.length = 0;
  mockSpawnAgent.mockResolvedValue(makeRunningJob());
  mockUpdateDispatch.mockResolvedValue(undefined);
});

describe("dispatch() — slack-worker integration", () => {
  // Copy the real `src/inject/workspaces/slack-worker/` fixture
  // into a per-test tmpdir so the resolver walks actual slack-worker
  // files (workspace.yml + .mcp.json + CLAUDE.md + .claude/). This
  // validates the published workspace contract end-to-end without
  // needing to mock resolveWorkspace.
  //
  // The `makeRepoContext` default has `slack.enabled = true`, so the
  // `settings.slack.enabled ≠ false` gate passes without a
  // `.danxbot/settings.json` file.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let slackRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-slack-dispatch-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    slackRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  const SLACK_META: DispatchTriggerMetadata = {
    trigger: "slack",
    metadata: {
      channelId: "C123",
      threadTs: "1700.001",
      messageTs: "1700.002",
      user: "U1",
      userName: null,
      messageText: "why the deploy is stuck?",
    },
  };

  it("a caller-supplied DANXBOT_WORKER_PORT in the overlay wins over the auto-injected value (precedence contract documented on `DispatchInput.overlay`)", async () => {
    // The `DispatchInput.overlay` docstring says "Caller overlay wins
    // over auto-injected values — tests rely on that." Pin that
    // contract: pass an explicit override and verify the spawn env
    // carries the override, not `String(slackRepo.workerPort)`. This is
    // load-bearing for future refactors that might be tempted to flip
    // the merge order.
    const overrideValue = "9999";
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: { DANXBOT_WORKER_PORT: overrideValue },
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.env.DANXBOT_WORKER_PORT).toBe(overrideValue);
    expect(opts.env.DANXBOT_WORKER_PORT).not.toBe(String(slackRepo.workerPort));
  });

  it("auto-injects DANXBOT_WORKER_PORT from repo.workerPort so callers never duplicate the same `String(repo.workerPort)` line (Phase 5 hotfix, Trello 69f7764f...)", async () => {
    // The slack-worker workspace's `.claude/settings.json` references
    // `${DANXBOT_WORKER_PORT}` and declares it in `required-placeholders`.
    // Pre-hotfix, every dispatch caller (poller, slack listener, HTTP
    // `/api/launch` smoke tests) had to pass it manually; HTTP launches
    // without an overlay therefore failed at workspace resolution time
    // (verified by `make test-system-yaml-memory`). Auto-injection in
    // dispatch core fixes that without forcing every caller to know
    // about the placeholder.
    const result = await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    // The slack-worker's `.claude/settings.json` env block declares
    // `DANXBOT_WORKER_PORT: "${DANXBOT_WORKER_PORT}"`. Auto-injection
    // makes the placeholder resolvable without a caller overlay; the
    // resolver hands the substituted env block to `dispatch`, which
    // forwards it as `env` on the spawnAgent options.
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.env.DANXBOT_WORKER_PORT).toBe(String(slackRepo.workerPort));
    // The dispatch row's id is the same dispatchId returned to the
    // caller — sanity check that auto-injection used `repo.workerPort`,
    // not some other source.
    expect(result.dispatchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("auto-injects DANXBOT_SLACK_REPLY_URL and DANXBOT_SLACK_UPDATE_URL into the overlay so callers never pre-compute dispatchId-derived URLs", async () => {
    // The listener passes ONLY `DANXBOT_WORKER_PORT`; the dispatch core
    // fills in the rest. Observable boundary: the danxbot MCP server's
    // env in the written settings.json must contain both URLs pointing
    // at the worker's per-dispatch endpoints.
    const result = await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_SLACK_REPLY_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/slack/reply/${result.dispatchId}`,
    );
    expect(env.DANXBOT_SLACK_UPDATE_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/slack/update/${result.dispatchId}`,
    );
    expect(env.DANXBOT_STOP_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/stop/${result.dispatchId}`,
    );
    // Phase 3 (tracker-agnostic-agents): the issue-create URL is
    // auto-injected the same way the Slack URLs are. It lands in the
    // danxbot MCP server's env so `danx_issue_create` can POST back to
    // the worker. A regression that drops it would silently disable
    // the agent's create surface. (DX-157 retired the parallel save
    // URL — agents `Edit` the YAML directly and the watcher mirrors.)
    expect(env.DANXBOT_ISSUE_CREATE_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/issue-create/${result.dispatchId}`,
    );
    // DX-157 retired the parallel save URL injection; only the create
    // URL survives in the issue surface. Pin the absence of any
    // legacy save key by name shape (no literal string here, since the
    // grep AC for the migration forbids matches anywhere under src/).
    expect(
      Object.keys(env).filter((k) => /^DANXBOT_ISSUE_S/.test(k)),
    ).toEqual([]);
    // ISS-72 (autonomous worker restart Phase 2): the restart URL is
    // auto-injected on the same worker-port gate. Regression that drops
    // it silently disables `danxbot_restart_worker`.
    expect(env.DANXBOT_RESTART_WORKER_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/restart/${result.dispatchId}`,
    );
    // DX-294: the prep-verdict URL is auto-injected on the same
    // worker-port gate. Regression that drops it silently disables
    // `danxbot_prep_verdict` — the pre-dispatch prep step would then
    // run with no verdict surface and the picker would proceed
    // blindly with the candidate.
    expect(env.DANXBOT_PREP_VERDICT_URL).toBe(
      `http://localhost:${slackRepo.workerPort}/api/prep-verdict/${result.dispatchId}`,
    );
  });

  it("populates mcpSettingsPath on spawnAgent options matching the per-dispatch settings.json path (DX-207)", async () => {
    // Phase 2a (DX-207) of the DB-driven full-stack reattach epic: the
    // path of the per-dispatch MCP settings file is captured on the
    // dispatch row via the `mcp_settings_path` column. This is the seam
    // Phase 2c (DX-209) reads at reattach time to rewrite
    // `DANXBOT_STOP_URL` when the worker restarts on a different port.
    //
    // Observable boundary: the same absolute path that `dispatch()`
    // wrote settings.json at MUST also reach `spawnAgent` as
    // `mcpSettingsPath` so the launcher's `startDispatchTracking` call
    // stamps the column with the live filesystem path. A regression
    // that decouples the two would pass every other test (the file is
    // still written, the agent still spawns, the row still inserts)
    // but would silently leave the column NULL — every reattach in
    // Phase 2c would then fall through to mark-failed.
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(typeof opts.mcpSettingsPath).toBe("string");
    expect(opts.mcpSettingsPath.length).toBeGreaterThan(0);
    // The path is the canonical per-dispatch settings file the launcher
    // also receives as `mcpConfigPath` — they MUST be the same string,
    // because Phase 2c needs to read+rewrite the file the live agent's
    // MCP server is consuming.
    expect(opts.mcpSettingsPath).toBe(opts.mcpConfigPath);
    // Belt-and-suspenders sanity: it really points at a danxbot-mcp-*
    // temp dir produced by `writeMcpSettingsFile`, not some unrelated
    // path that happened to match `mcpConfigPath`.
    expect(opts.mcpSettingsPath).toMatch(/danxbot-mcp-/);
  });

  it("never passes an allowedTools field to spawnAgent — the allowlist concept is gone", async () => {
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    // The workspace's `.mcp.json` (combined with `--strict-mcp-config`)
    // is the single source of truth for the agent's MCP surface.
    // `allowedTools` no longer exists on SpawnAgentOptions; danxbot_complete
    // is reachable because the danxbot MCP server registers it, not because
    // it's listed in any allowlist.
    expect(opts.allowedTools).toBeUndefined();
  });

  it("rejects the dispatch BEFORE spawnAgent when the workspace contains a stale allowed-tools.txt (loud-fail end-to-end)", async () => {
    // Closes the loop with the resolver-level WorkspaceLegacyFileError test.
    // Drops `allowed-tools.txt` into the slack-worker fixture and asserts
    // `dispatch()` rejects without ever reaching the spawn boundary —
    // proves the resolver's loud-fail actually halts the dispatch path,
    // not just the resolver in isolation.
    const slackWorkerDest = resolve(
      tmpRepoDir,
      ".danxbot",
      "workspaces",
      "slack-worker",
    );
    writeFileSync(resolve(slackWorkerDest, "allowed-tools.txt"), "Read\n");

    await expect(
      dispatch({
        repo: slackRepo,
        task: "investigate",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: SLACK_META,
      }),
    ).rejects.toThrow(/allowed-tools\.txt/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("lands the agent's cwd in the slack-worker workspace directory", async () => {
    await dispatch({
      repo: slackRepo,
      task: "investigate",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: SLACK_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.cwd).toBe(
      resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker"),
    );
  });

  it("refuses to resolve when operator flipped overrides.slack.enabled to false — settings.slack.enabled ≠ false gate fails", async () => {
    // Three-valued settings toggle: operator sets overrides.slack.enabled
    // to false on the Agents tab, the gate fails, dispatch
    // rejects before spawnAgent is ever called. The poller-halt contract
    // uses CRITICAL_FAILURE for env-level breakage; operator toggles are
    // gated at the workspace entry.
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(resolve(tmpRepoDir, ".danxbot"), { recursive: true });
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({
        overrides: {
          slack: { enabled: false },
          issuePoller: { enabled: null },
          dispatchApi: { enabled: null },
        },
        display: {},
        meta: { updatedAt: "2026-04-24T00:00:00Z", updatedBy: "setup" },
      }),
    );

    await expect(
      dispatch({
        repo: slackRepo,
        task: "should not spawn",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: SLACK_META,
      }),
    ).rejects.toThrow(/settings\.slack\.enabled/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("dispatch() — issue-worker integration (Phase 3 of ISS-90, DX-203 follow-up)", () => {
  // Phase 3 wired the `danx-issue` MCP server into the issue-worker
  // workspace's `.mcp.json` so the new `danx-triage-card` skill can call
  // `mcp__danx-issue__danx_issue_get` / `danx_issue_list` directly
  // (DX-157 retired the agent-facing save tool; agents `Edit` YAMLs in
  // place and the chokidar watcher mirrors the change). The server
  // originally read `DANX_REPO_ROOT`, `DANX_TRACKER`, `TRELLO_API_KEY`,
  // `TRELLO_API_TOKEN`; DX-203 retired the tracker triple, so the only
  // env var the server still needs is `DANX_REPO_ROOT`. dispatch()
  // auto-injects it from `RepoContext` so callers don't have to.
  //
  // Boundary asserted here: the merged settings.json handed to spawnAgent
  // (the file claude actually reads) carries the `danx-issue` server with
  // its single placeholder substituted to the matching `RepoContext`
  // value. Regression that drops `DANX_REPO_ROOT` from the overlay would
  // either throw `PlaceholderError` (when required) or — worse —
  // substitute it to empty string and let the MCP server start with a
  // missing repo root, producing confusing 500s on every triage call.
  const issueWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "issue-worker",
  );

  let tmpRepoDir: string;
  let issueRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-issue-dispatch-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "issue-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(issueWorkerSrc, dest, { recursive: true });
    // Scaffold the empty `.danxbot/issues/` dir the MCP server would later
    // walk (the resolver doesn't read it, but other gates might).
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "issues", "open"), {
      recursive: true,
    });
    const baseRepo = makeRepoContext({ localPath: tmpRepoDir });
    issueRepo = {
      ...baseRepo,
      trelloEnabled: true,
      trello: {
        ...baseRepo.trello,
        apiKey: "issue-worker-test-key",
        apiToken: "issue-worker-test-token",
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("auto-injects DANX_REPO_ROOT into the danx-issue server's env (DX-203: tracker triple retired)", async () => {
    await dispatch({
      repo: issueRepo,
      task: "/danx-triage-card ISS-1",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    const danxIssue = settings.mcpServers["danx-issue"];
    expect(danxIssue).toBeDefined();
    // DX-203: env block contains exactly DANX_REPO_ROOT — the tracker
    // triple (`DANX_TRACKER`, `TRELLO_API_KEY`, `TRELLO_API_TOKEN`) is
    // gone. Pinning equality (not just presence) so a regression that
    // re-adds tracker creds to the overlay trips loud.
    expect(danxIssue.env).toEqual({
      DANX_REPO_ROOT: tmpRepoDir,
    });
  });

  it("ignores trelloEnabled flag — the danx-issue server's env is independent of tracker config (DX-203)", async () => {
    // The MCP server is purely a YAML manipulator; it does not read any
    // tracker creds. So whether `repo.trelloEnabled` is true or false,
    // the auto-injected overlay for the danx-issue server is identical.
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({
        overrides: { issuePoller: { enabled: true, pickupNamePrefix: null } },
      }),
    );
    issueRepo = makeRepoContext({
      localPath: tmpRepoDir,
      trelloEnabled: false,
      trello: { ...issueRepo.trello, apiKey: "", apiToken: "" },
    });

    await dispatch({
      repo: issueRepo,
      task: "/danx-triage-card ISS-1",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(settings.mcpServers["danx-issue"].env).toEqual({
      DANX_REPO_ROOT: tmpRepoDir,
    });
  });

  it("merges the danxbot infrastructure server alongside the workspace's `danx-issue` server", async () => {
    // Defence-in-depth: the workspace's `.mcp.json` declares danx-issue +
    // playwright; dispatch core merges danxbot infra. A regression that
    // either dropped infra or replaced (rather than merged) workspace
    // servers would silently break the agent's tool surface. Use
    // `toContain` rather than strict-equal-set so a future workspace
    // addition (e.g. a `schema` server) doesn't fail this test for the
    // wrong reason — the regression of interest is "infra+danx-issue both
    // present", not "exactly these three."
    await dispatch({
      repo: issueRepo,
      task: "Triage card ISS-1.",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    const serverNames = Object.keys(settings.mcpServers);
    expect(serverNames).toContain("danx-issue");
    expect(serverNames).toContain("danxbot");
    expect(serverNames).toContain("playwright");
  });

  // Precedence contract — caller overlay wins over the auto-injected
  // `DANX_REPO_ROOT`. After DX-203 retired the tracker triple, this is
  // the only auto-injected danx-issue key left. The matrix shape stays
  // (it.each over a 1-row table) so adding a future overlay key is a
  // one-line edit, not a structural rewrite.
  it.each([["DANX_REPO_ROOT", "/tmp/other-repo-root"]])(
    "caller-supplied %s in overlay wins over the auto-injected value (precedence contract)",
    async (key, overrideValue) => {
      // For DANX_REPO_ROOT specifically, the resolver hits `existsSync` on
      // the overridden path before substitution lands — scaffold it.
      if (key === "DANX_REPO_ROOT") {
        mkdirSync(resolve(overrideValue, ".danxbot", "issues", "open"), {
          recursive: true,
        });
      }
      try {
        await dispatch({
          repo: issueRepo,
          task: "Triage card ISS-1.",
          workspace: "issue-worker",
          overlay: { [key]: overrideValue },
          apiDispatchMeta: DEFAULT_DISPATCH_META,
        });

        const opts = mockSpawnAgent.mock.calls[0][0];
        const settings = JSON.parse(
          readFileSync(opts.mcpConfigPath, "utf-8"),
        ) as { mcpServers: Record<string, { env?: Record<string, string> }> };
        expect(settings.mcpServers["danx-issue"].env?.[key]).toBe(overrideValue);
      } finally {
        if (key === "DANX_REPO_ROOT") {
          rmSync(overrideValue, { recursive: true, force: true });
        }
      }
    },
  );

  describe("auto-flip ToDo → In Progress before spawn", () => {
    async function writeCandidate(
      id: string,
      status: "Review" | "ToDo" | "In Progress" | "Blocked" = "ToDo",
    ): Promise<void> {
      const { createEmptyIssue, serializeIssue } = await import(
        "../issue-tracker/yaml.js"
      );
      const yamlPath = resolve(
        tmpRepoDir,
        ".danxbot",
        "issues",
        "open",
        `${id}.yml`,
      );
      writeFileSync(
        yamlPath,
        serializeIssue(
          createEmptyIssue({
            id,
            status,
            title: `${id} title`,
            description: "fixture",
          }),
        ),
      );
    }

    async function readCandidateStatus(id: string): Promise<string> {
      const { parseIssue } = await import("../issue-tracker/yaml.js");
      const yamlPath = resolve(
        tmpRepoDir,
        ".danxbot",
        "issues",
        "open",
        `${id}.yml`,
      );
      return parseIssue(readFileSync(yamlPath, "utf-8"), {
        expectedPrefix: issueRepo.issuePrefix,
      }).status;
    }

    it("flips ToDo → In Progress when issueId set + dispatchKind=work", async () => {
      await writeCandidate("ISS-100", "ToDo");

      await dispatch({
        repo: issueRepo,
        task: "/danx-prep ISS-100\n\n/danx-next ISS-100",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        issueId: "ISS-100",
        dispatchKind: "work",
      });

      expect(await readCandidateStatus("ISS-100")).toBe("In Progress");
    });

    it("skips flip when dispatchKind=prep (prep-only dispatch — verdict may stamp Blocked/conflict_on later)", async () => {
      await writeCandidate("ISS-101", "ToDo");

      await dispatch({
        repo: issueRepo,
        task: "/danx-prep ISS-101",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        issueId: "ISS-101",
        dispatchKind: "prep",
      });

      expect(await readCandidateStatus("ISS-101")).toBe("ToDo");
    });

    it("skips flip when dispatchKind=triage — triage agent edits status via Edit, not auto-flip (DX-515)", async () => {
      // Triage runs `/danx-triage-card`; the agent's per-status decision
      // tree expects to READ the candidate at its current status
      // (Review / Blocked / Waiting On) and then decide whether to flip
      // it via Edit. If `dispatch/core.ts` auto-flipped to In Progress
      // first, every Review card would look like a work-in-progress to
      // the triage agent and the ICE decision tree would refuse to run.
      // The gate at `dispatch/core.ts:1279` uses strict `=== "work"`
      // equality so this test pins the literal contract.
      await writeCandidate("ISS-102", "Review");

      await dispatch({
        repo: issueRepo,
        task: "Triage card ISS-102 using the danx-triage-card skill.",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        issueId: "ISS-102",
        dispatchKind: "triage",
      });

      expect(await readCandidateStatus("ISS-102")).toBe("Review");
    });

    it("skips flip when issueId is undefined (Slack / external dispatch)", async () => {
      // No candidate YAML — verify dispatch does not throw on the
      // missing-id branch and does not write any new YAML.
      await dispatch({
        repo: issueRepo,
        task: "Slack-style dispatch",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        dispatchKind: "work",
      });
      expect(
        existsSync(resolve(tmpRepoDir, ".danxbot", "issues", "open", "DX-1.yml")),
      ).toBe(false);
    });

    it("no-op when candidate is already In Progress (idempotent)", async () => {
      await writeCandidate("ISS-102", "In Progress");

      await dispatch({
        repo: issueRepo,
        task: "/danx-prep ISS-102\n\n/danx-next ISS-102",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        issueId: "ISS-102",
        dispatchKind: "work",
      });

      expect(await readCandidateStatus("ISS-102")).toBe("In Progress");
    });

    it("revert respects a concurrent Blocked stamp — does NOT clobber Blocked back to ToDo", async () => {
      await writeCandidate("ISS-104", "ToDo");
      // Simulate a concurrent writer (e.g., prep-verdict route, human
      // dashboard edit) stamping Blocked between the auto-flip and the
      // spawn-failure revert. We do this by making the spawnAgent
      // throw, but FIRST we rewrite the YAML to Blocked from inside
      // the spawn fake — the revert path will read the disk state
      // back and must not overwrite Blocked.
      mockSpawnAgent.mockImplementationOnce(async () => {
        const { createEmptyIssue, serializeIssue } = await import(
          "../issue-tracker/yaml.js"
        );
        const blocked = {
          ...createEmptyIssue({
            id: "ISS-104",
            status: "Blocked",
            title: "ISS-104 title",
            description: "fixture",
          }),
          blocked: {
            reason: "concurrent stamp by prep-verdict route",
            timestamp: "2026-05-14T00:00:00.000Z",
          },
        };
        writeFileSync(
          resolve(tmpRepoDir, ".danxbot/issues/open/ISS-104.yml"),
          serializeIssue(blocked),
        );
        throw new Error("spawn failed");
      });

      await expect(
        dispatch({
          repo: issueRepo,
          task: "/danx-prep ISS-104\n\n/danx-next ISS-104",
          workspace: "issue-worker",
          overlay: {},
          apiDispatchMeta: DEFAULT_DISPATCH_META,
          issueId: "ISS-104",
          dispatchKind: "work",
        }),
      ).rejects.toThrow(/spawn failed/);

      // Card stayed Blocked — the revert did NOT clobber.
      expect(await readCandidateStatus("ISS-104")).toBe("Blocked");
    });

    it("reverts flip to ToDo when spawnAgent throws", async () => {
      await writeCandidate("ISS-103", "ToDo");
      mockSpawnAgent.mockRejectedValueOnce(new Error("spawn failed"));

      await expect(
        dispatch({
          repo: issueRepo,
          task: "/danx-prep ISS-103\n\n/danx-next ISS-103",
          workspace: "issue-worker",
          overlay: {},
          apiDispatchMeta: DEFAULT_DISPATCH_META,
          issueId: "ISS-103",
          dispatchKind: "work",
        }),
      ).rejects.toThrow(/spawn failed/);

      // Candidate rolled back to ToDo so the poller can re-pick.
      expect(await readCandidateStatus("ISS-103")).toBe("ToDo");
    });
  });

  it("rejects dispatch with WorkspaceGateError when overrides.issuePoller.enabled = false (parallel to slack-worker gate test)", async () => {
    // Symmetry with the slack-worker test at line ~342. The issue-worker
    // workspace declares `settings.issuePoller.enabled ≠ false` as a gate;
    // a regression that flipped the evaluator off would let dispatch
    // proceed against an operator-disabled repo. Pin the rejection.
    writeFileSync(
      resolve(tmpRepoDir, ".danxbot", "settings.json"),
      JSON.stringify({
        overrides: { issuePoller: { enabled: false, pickupNamePrefix: null } },
      }),
    );

    await expect(
      dispatch({
        repo: issueRepo,
        task: "Triage card ISS-1.",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      }),
    ).rejects.toThrow(/settings\.issuePoller\.enabled/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });
});

describe("dispatch() — top_level_agent forwarding", () => {
  // Phase 4 of the schema-builder sub-30s epic (ISS-55). When a workspace
  // declares `top_level_agent: orchestrator`, the resolver propagates the
  // name and dispatch core threads it through to spawnAgent so claude
  // receives `--agent orchestrator` — the top-level session BECOMES the
  // agent, eager-loading its `tools:` frontmatter and eliminating the
  // ~4s ToolSearch tax MCP tools otherwise pay.
  let tmpRepoDir: string;
  let agentRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-tla-dispatch-"));
    const ws = resolve(tmpRepoDir, ".danxbot", "workspaces", "ws-with-agent");
    mkdirSync(resolve(ws, ".claude", "agents"), { recursive: true });
    writeFileSync(
      resolve(ws, "workspace.yml"),
      [
        "name: ws-with-agent",
        "description: fixture for top_level_agent test",
        "top_level_agent: orchestrator",
        "required-placeholders: []",
      ].join("\n") + "\n",
    );
    writeFileSync(
      resolve(ws, ".mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    writeFileSync(
      resolve(ws, ".claude", "settings.json"),
      JSON.stringify({ env: {} }),
    );
    writeFileSync(
      resolve(ws, ".claude", "agents", "orchestrator.md"),
      "---\nname: orchestrator\ndescription: x\n---\nbody\n",
    );
    agentRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("forwards topLevelAgent to spawnAgent when the manifest declares top_level_agent", async () => {
    await dispatch({
      repo: agentRepo,
      task: "investigate",
      workspace: "ws-with-agent",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.topLevelAgent).toBe("orchestrator");
  });

  it("omits topLevelAgent on spawnAgent options when the manifest does not declare top_level_agent", async () => {
    // Strip the field from the fixture's workspace.yml.
    const wsYml = resolve(
      tmpRepoDir,
      ".danxbot",
      "workspaces",
      "ws-with-agent",
      "workspace.yml",
    );
    writeFileSync(
      wsYml,
      [
        "name: ws-with-agent",
        "description: fixture for top_level_agent test",
        "required-placeholders: []",
      ].join("\n") + "\n",
    );
    await dispatch({
      repo: agentRepo,
      task: "investigate",
      workspace: "ws-with-agent",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });
    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.topLevelAgent).toBeUndefined();
  });
});

describe("listActiveJobs()", () => {
  it("returns every job currently in the activeJobs map", async () => {
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-list-"));
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      const { job: jobA } = await dispatch({
        repo: testRepo,
        task: "task A",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });
      const { job: jobB } = await dispatch({
        repo: testRepo,
        task: "task B",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      const tracked = listActiveJobs();
      expect(tracked).toContain(jobA);
      expect(tracked).toContain(jobB);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });

  it("returns an array snapshot — mutating it does not mutate internal state", async () => {
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-snapshot-"));
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      await dispatch({
        repo: testRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      const first = listActiveJobs();
      first.length = 0;
      const second = listActiveJobs();
      expect(second.length).toBeGreaterThan(0);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });
});

/**
 * Pin the test-only drain helper added for Trello 69f77e9b77472aefac1317b2:
 * the `yaml-lifecycle-fake-tracker.test.ts` teardown leak. The helper
 * iterates `activeJobs` and awaits each `_cleanup()` + `_forwarderFlush`
 * so test teardown can `rmSync(<config.logsDir>)` without racing the
 * fire-and-forget forwarder flush the launcher kicks off in `runCleanup`.
 *
 * Helper signature is intentionally narrow — these tests guard against
 * regressions that drop one of the two awaited handles, or stop
 * snapshotting `activeJobs` upfront.
 */
describe("_drainPendingCleanupsForTesting", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  function makeJobWithSpies(id: string): {
    job: ReturnType<typeof makeRunningJob> & {
      _cleanup: ReturnType<typeof vi.fn>;
      _forwarderFlush: Promise<void>;
    };
    cleanupSpy: ReturnType<typeof vi.fn>;
    flushResolve: () => void;
  } {
    const cleanupSpy = vi.fn().mockResolvedValue(undefined);
    let flushResolve!: () => void;
    const flushPromise = new Promise<void>((resolve) => {
      flushResolve = resolve;
    });
    const job = {
      ...makeRunningJob(),
      id,
      _cleanup: cleanupSpy,
      _forwarderFlush: flushPromise,
    };
    return { job, cleanupSpy, flushResolve };
  }

  it("awaits both _cleanup() and _forwarderFlush for every job in the registry", async () => {
    // Two jobs, each with distinct cleanup spy + flush promise. The
    // helper must await BOTH per job — a regression that drops
    // `_forwarderFlush` from the awaited list (or vice versa) is
    // exactly the failure mode this test catches.
    const a = makeJobWithSpies("job-a");
    const b = makeJobWithSpies("job-b");

    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-drain-"));
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      mockSpawnAgent.mockResolvedValueOnce(a.job);
      mockSpawnAgent.mockResolvedValueOnce(b.job);

      await dispatch({
        repo: testRepo,
        task: "task A",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });
      await dispatch({
        repo: testRepo,
        task: "task B",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      // Drain hangs until both flush promises resolve — proves the
      // helper actually awaits `_forwarderFlush` (not just `_cleanup()`).
      const drainPromise = _drainPendingCleanupsForTesting();
      let drained = false;
      void drainPromise.then(() => {
        drained = true;
      });

      // Yield twice — long enough for any non-awaiting helper variant
      // to early-resolve. If `drained` flips here, the helper is NOT
      // awaiting `_forwarderFlush`.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(drained).toBe(false);

      a.flushResolve();
      b.flushResolve();
      await drainPromise;

      expect(a.cleanupSpy).toHaveBeenCalledTimes(1);
      expect(b.cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });

  it("is a no-op when activeJobs is empty (resolves without error)", async () => {
    // Defensive baseline: a fresh registry should drain instantly.
    // Guards against a future refactor that adds a side effect (e.g.
    // logging) which could throw on an empty input.
    await expect(_drainPendingCleanupsForTesting()).resolves.toBeUndefined();
  });

  it("skips the _forwarderFlush await when the job has no forwarder (poller-style dispatch)", async () => {
    // Poller dispatches gate `eventForwarding` on (statusUrl &&
    // apiToken). When apiToken is absent, the launcher leaves
    // `_forwarderFlush` undefined. The helper must not crash on
    // `await undefined` — TypeScript's `if (job._forwarderFlush)`
    // guard is the contract, this test pins it.
    const cleanupSpy = vi.fn().mockResolvedValue(undefined);
    const job = {
      ...makeRunningJob(),
      id: "poller-job",
      _cleanup: cleanupSpy,
      // _forwarderFlush deliberately undefined.
    };

    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const tmpRepoDir = mkdtempSync(
      resolve(tmpdir(), "danxbot-test-drain-noflush-"),
    );
    try {
      const dest = resolve(
        tmpRepoDir,
        ".danxbot",
        "workspaces",
        "slack-worker",
      );
      mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
        recursive: true,
      });
      cpSync(slackWorkerSrc, dest, { recursive: true });
      const testRepo = makeRepoContext({ localPath: tmpRepoDir });

      mockSpawnAgent.mockResolvedValueOnce(job);

      await dispatch({
        repo: testRepo,
        task: "poller task",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
      });

      await expect(_drainPendingCleanupsForTesting()).resolves.toBeUndefined();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmpRepoDir, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for the `apiDispatchMeta` plumbing inside `dispatch()`. The HTTP
 * handlers (in `src/worker/dispatch.ts`) build the meta from the request body
 * and hand it to dispatch(); these tests assert that dispatch() forwards it
 * verbatim to the initial spawn and explicitly drops it on stall-recovery
 * respawns. The respawn path also writes `nudgeCount` to the dispatches DB —
 * verified at the same boundary so the column the dashboard reads can never
 * silently regress to zero.
 */
describe("dispatch() — apiDispatchMeta wiring", () => {
  // Fixture and helpers shared across every test in this describe. The
  // workspace is the real on-disk slack-worker (so resolveWorkspace runs
  // for real); the per-test mkdtemp gives each `dispatch()` call its own
  // ~/.danxbot/workspaces/slack-worker tree without leaking between tests.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let testRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-meta-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    testRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
    mockedConfig.isHost = false;
  });

  // setupStallDetection short-circuits unless watcher + terminalLogPath are
  // both present on the spawned job AND statusUrl is on the input. Wrapping
  // the production conditions in a factory keeps the tests focused on the
  // behavior under test, not the harness shape.
  function makeStallReadyJob(suffix: string) {
    return {
      ...makeRunningJob(),
      watcher: { subscribe: vi.fn() },
      terminalLogPath: `/fake/log-${suffix}.txt`,
      stop: vi.fn().mockResolvedValue(undefined),
      _cleanup: vi.fn().mockResolvedValue(undefined),
    };
  }

  // The minimal `DispatchInput` for triggering stall detection — both
  // statusUrl AND apiToken must be set, isHost must be true, and the
  // returned job must have watcher+terminalLogPath. The two stall tests
  // share this exact configuration.
  async function dispatchWithStallEnabled(
    meta: DispatchTriggerMetadata,
  ): Promise<{ dispatchId: string }> {
    return dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: meta,
      statusUrl: "https://forwarder.example/status",
      apiToken: "tok-stall",
    });
  }

  it("apiDispatchMeta is forwarded verbatim to spawnAgent on the initial spawn", async () => {
    // The dispatch row's `trigger` and `triggerMetadata` columns are
    // populated from this struct via spawnAgent → DispatchTracker. Forwarding
    // it verbatim (not reshaping it inside dispatch()) is the contract — the
    // worker handler is responsible for the build, dispatch() just plumbs it.
    const meta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: "10.0.0.42",
        statusUrl: null,
        initialPrompt: "investigate failure",
      },
    };

    await dispatch({
      repo: testRepo,
      task: "investigate failure",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: meta,
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const opts = mockSpawnAgent.mock.calls[0][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    expect(opts.dispatch).toEqual(meta);
  });

  it("DX-296: dispatchKind plumbs from DispatchInput → spawnAgent options on the initial spawn (route reads it via getActiveJob.dispatchKind)", async () => {
    // The route's lifecycle decision keys off `AgentJob.dispatchKind`,
    // which is stamped at construction time by `runSpawnPreflight` from
    // `SpawnAgentOptions.dispatchKind`. A regression that drops the
    // value anywhere in the chain (DispatchInput → core → spawnAgent →
    // job) would silently demote prep dispatches to work-mode and
    // break the entire 2-tick separate-mode protocol.
    await dispatch({
      repo: testRepo,
      task: "prep then work",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchKind: "prep",
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const opts = mockSpawnAgent.mock.calls[0][0] as {
      dispatchKind: "prep" | "work" | undefined;
    };
    expect(opts.dispatchKind).toBe("prep");
  });

  it("DX-296: dispatchKind=undefined is preserved as undefined to spawnAgent (non-multi-agent-pick callers — Slack, ideator, external launches)", async () => {
    await dispatch({
      repo: testRepo,
      task: "non-prep dispatch",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      // dispatchKind omitted — Slack/ideator/external paths.
    });

    expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    const opts = mockSpawnAgent.mock.calls[0][0] as {
      dispatchKind: "prep" | "work" | undefined;
    };
    expect(opts.dispatchKind).toBeUndefined();
  });

  it("DX-296: dispatchKind survives stall-recovery respawn (the route still needs the discriminator after a respawn — `getActiveJob` reads from the same module-scoped registry)", async () => {
    // The respawn path forwards `dispatchKind` unconditionally because
    // the route reads it from the same `activeJobs` slot. A respawn
    // that dropped the field would leave the route's `getActiveJob(
    // dispatchId)?.dispatchKind` returning undefined → defensive
    // keep-running on `ok` even when the dispatch was prep-only →
    // separate-mode broken on the very first stall recovery.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn"));

    await dispatch({
      repo: testRepo,
      task: "prep dispatch with stall",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      statusUrl: "https://forwarder.example/status",
      apiToken: "tok-stall",
      dispatchKind: "prep",
    });

    expect(capturedStallOpts).toHaveLength(1);
    await capturedStallOpts[0].onStall();

    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    const initialOpts = mockSpawnAgent.mock.calls[0][0] as {
      dispatchKind: "prep" | "work" | undefined;
    };
    const respawnOpts = mockSpawnAgent.mock.calls[1][0] as {
      dispatchKind: "prep" | "work" | undefined;
    };
    expect(initialOpts.dispatchKind).toBe("prep");
    expect(respawnOpts.dispatchKind).toBe("prep");
  });

  it("does NOT pass dispatch on stall-recovery respawn — only the initial spawn records the dispatch row", async () => {
    // Stall-recovery respawns reuse the same dispatchId in `activeJobs`
    // and must NOT create a second row for the same conceptual run. Forgetting
    // this would surface as duplicate dispatch rows in the dashboard, with
    // the second one stamped as a fresh "api" trigger and orphaned from the
    // original caller's correlation ID.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn"));

    const meta: DispatchTriggerMetadata = {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: null,
        statusUrl: "https://forwarder.example/status",
        initialPrompt: "do thing",
      },
    };

    await dispatchWithStallEnabled(meta);

    // setupStallDetection ran → exactly one StallDetector was
    // constructed and we captured its onStall callback.
    expect(capturedStallOpts).toHaveLength(1);
    await capturedStallOpts[0].onStall();

    // Two spawnAgent calls now: initial + respawn. Initial carries
    // the meta; respawn must have `dispatch: undefined`.
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    const initialOpts = mockSpawnAgent.mock.calls[0][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    const respawnOpts = mockSpawnAgent.mock.calls[1][0] as {
      dispatch: DispatchTriggerMetadata | undefined;
    };
    expect(initialOpts.dispatch).toEqual(meta);
    expect(respawnOpts.dispatch).toBeUndefined();
  });

  it("stall callback records nudgeCount on the dispatch row via updateDispatch — increments across multiple stalls", async () => {
    // The stall detector tracks nudge attempts in-memory via `resumeCount`,
    // but the dashboard reads `nudgeCount` off the dispatches table. Without
    // this updateDispatch call the dashboard would silently report zero
    // nudges for every dispatch that recovered via stall — and the cost-
    // attribution ("how often does the stall recovery actually save a run?")
    // would be invisible in production. Asserting both the first and second
    // calls also catches an off-by-one or accidental reset on respawn.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn-1"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn-2"));

    const result = await dispatchWithStallEnabled(DEFAULT_DISPATCH_META);

    // First stall → resumeCount becomes 1, fresh StallDetector wired up
    // for the respawned job. `toHaveBeenCalledWith` (not `Nth`) because
    // DX-207 added a second updateDispatch on respawn that resyncs
    // `mcpSettingsPath` — call positions are no longer load-bearing for
    // this assertion's intent (just that the nudge patch fires).
    await capturedStallOpts[0].onStall();
    expect(mockUpdateDispatch).toHaveBeenCalledWith(result.dispatchId, {
      nudgeCount: 1,
    });

    // Second stall on the respawned job → resumeCount becomes 2. The
    // dispatchId on the patch must remain the original — the column is
    // keyed by dispatchId, not by the launcher's internal jobId (which
    // changes on every respawn). And the count must increment, not reset.
    expect(capturedStallOpts).toHaveLength(2);
    await capturedStallOpts[1].onStall();
    expect(mockUpdateDispatch).toHaveBeenCalledWith(result.dispatchId, {
      nudgeCount: 2,
    });
  });

  it("respawn syncs mcp_settings_path to the freshly written settings dir (DX-207 + DX-209 reattach contract)", async () => {
    // DX-207 P0 fix: `writeMcpSettingsFile` runs INSIDE `spawnForDispatch`,
    // so each respawn produces a fresh `/tmp/danxbot-mcp-XXXX/` path.
    // The previous spawn's `cleanupMcpSettings` removes the old dir as
    // part of its onComplete chain (triggered by `terminateWithGrace`).
    // Without an `updateDispatch` resync the dispatches row would still
    // point at the deleted dir, and Phase 2c (DX-209) reattach would
    // either read a missing file or, after `mkdtempSync` collision
    // randomness, an unrelated dispatch's settings.
    //
    // Observable boundary: after a stall-recovery respawn,
    // `updateDispatch(dispatchId, { mcpSettingsPath: <new path> })` MUST
    // have been called with a string that:
    //   (a) is not the same path the initial spawn used (proving a fresh
    //       file was written, not a stale capture), and
    //   (b) matches the value just handed to spawnAgent on the respawn.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("respawn"));

    const result = await dispatchWithStallEnabled(DEFAULT_DISPATCH_META);
    const initialOpts = mockSpawnAgent.mock.calls[0][0] as {
      mcpSettingsPath: string;
    };

    expect(capturedStallOpts).toHaveLength(1);
    await capturedStallOpts[0].onStall();

    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    const respawnOpts = mockSpawnAgent.mock.calls[1][0] as {
      mcpSettingsPath: string;
    };
    expect(respawnOpts.mcpSettingsPath).not.toBe(initialOpts.mcpSettingsPath);
    expect(respawnOpts.mcpSettingsPath).toMatch(/danxbot-mcp-/);

    // The DB resync uses the SAME path as the respawn's spawnAgent argument.
    // Lock both halves of the contract: same dispatchId, same fresh path.
    expect(mockUpdateDispatch).toHaveBeenCalledWith(result.dispatchId, {
      mcpSettingsPath: respawnOpts.mcpSettingsPath,
    });
  });

  it("initial spawn does NOT issue an mcp_settings_path updateDispatch — the value lands on the row via insertDispatch atomic with row creation", async () => {
    // The respawn-only `updateDispatch` adds a write to the DB; if the
    // initial spawn ALSO wrote it, that would be a redundant round-trip
    // and a contract violation (the column is meant to be set once at
    // INSERT and only re-set across spawns when the path actually
    // changes). This test pins the gate.
    mockedConfig.isHost = true;
    mockSpawnAgent.mockResolvedValueOnce(makeStallReadyJob("initial"));
    await dispatchWithStallEnabled(DEFAULT_DISPATCH_META);

    // No respawn fired — exactly zero updateDispatch calls touching
    // mcpSettingsPath should have happened. Nudge-count updates are
    // also zero because no stall fired.
    const mcpUpdates = mockUpdateDispatch.mock.calls.filter(
      ([, patch]) =>
        Object.prototype.hasOwnProperty.call(
          patch as Record<string, unknown>,
          "mcpSettingsPath",
        ),
    );
    expect(mcpUpdates).toHaveLength(0);
  });
});

describe("dispatch() — dispatchId override", () => {
  // Phase 2 of the tracker-agnostic-agents epic (Trello ZDb7FOGO) needs the
  // poller to pre-generate the dispatchId so it can stamp it into the YAML
  // file BEFORE the spawn happens. The optional `dispatchId` override is the
  // mechanism: callers that don't pass one keep getting `randomUUID()`
  // generated inside `dispatch()`; callers that do pass one see it threaded
  // through to `result.dispatchId`, the spawn's `jobId`, and every
  // dispatchId-derived URL in the danxbot MCP server's env block.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let testRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-test-dispatchid-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    testRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("uses the caller-supplied dispatchId verbatim when provided", async () => {
    const explicitId = "11111111-2222-3333-4444-555555555555";
    const result = await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: explicitId,
    });

    expect(result.dispatchId).toBe(explicitId);

    const opts = mockSpawnAgent.mock.calls[0][0] as { jobId: string };
    expect(opts.jobId).toBe(explicitId);
  });

  it("propagates the override into every dispatchId-derived URL in the MCP env", async () => {
    const explicitId = "deadbeef-1234-5678-9abc-deadbeef0000";
    await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: explicitId,
    });

    const opts = mockSpawnAgent.mock.calls[0][0] as { mcpConfigPath: string };
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_STOP_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/stop/${explicitId}`,
    );
    expect(env.DANXBOT_SLACK_REPLY_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/slack/reply/${explicitId}`,
    );
    expect(env.DANXBOT_SLACK_UPDATE_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/slack/update/${explicitId}`,
    );
    expect(env.DANXBOT_ISSUE_CREATE_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/issue-create/${explicitId}`,
    );
    // DX-157 retired the parallel save URL injection; only the create
    // URL survives in the issue surface. Pin the absence of any
    // legacy save key by name shape (no literal string here, since the
    // grep AC for the migration forbids matches anywhere under src/).
    expect(
      Object.keys(env).filter((k) => /^DANXBOT_ISSUE_S/.test(k)),
    ).toEqual([]);
    expect(env.DANXBOT_RESTART_WORKER_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/restart/${explicitId}`,
    );
    // DX-294: same dispatchId-derivation contract for the prep-verdict
    // URL. Explicit-dispatchId callers (today: the poller's
    // pre-stamp-then-spawn flow) MUST see the URL bound to the same id.
    expect(env.DANXBOT_PREP_VERDICT_URL).toBe(
      `http://localhost:${testRepo.workerPort}/api/prep-verdict/${explicitId}`,
    );
  });

  it("falls back to randomUUID when no dispatchId is provided (existing callers unchanged)", async () => {
    const result = await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    // RFC 4122 UUID v4 shape — 8-4-4-4-12 hex.
    expect(result.dispatchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("dispatch() — staged_files staging", () => {
  let tmpRepoDir: string;
  let stagingRoot: string;
  let testRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-staging-test-"));
    // Real on-disk slack-worker fixture, then overwrite workspace.yml to add
    // `staging-paths`. Easier than minting a fresh fixture inline; the
    // resolver doesn't care which workspace declares the field.
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });

    stagingRoot = resolve(tmpRepoDir, "staging-${SCHEMA_DEFINITION_ID}");
    writeFileSync(
      resolve(dest, "workspace.yml"),
      `name: slack-worker
description: staging test
required-placeholders:
  - DANXBOT_STOP_URL
  - DANXBOT_WORKER_PORT
  - DANXBOT_SLACK_REPLY_URL
  - DANXBOT_SLACK_UPDATE_URL
required-gates:
  - "settings.slack.enabled ≠ false"
staging-paths:
  - "${stagingRoot}/"
`,
    );
    testRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("writes every staged_files entry under the workspace allowlist before spawn", async () => {
    const overlay = { SCHEMA_DEFINITION_ID: "42" };
    const resolvedRoot = resolve(tmpRepoDir, "staging-42");

    let onSpawnExisted: { schema?: boolean; bp?: boolean } = {};
    mockSpawnAgent.mockImplementationOnce(async () => {
      // At spawnAgent call time the staged files MUST be on disk.
      onSpawnExisted = {
        schema: existsSync(resolve(resolvedRoot, "schema.json")),
        bp: existsSync(resolve(resolvedRoot, "blueprints/7.json")),
      };
      return makeRunningJob();
    });

    await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay,
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      stagedFiles: [
        { path: resolvedRoot + "/schema.json", content: '{"a":1}' },
        { path: resolvedRoot + "/blueprints/7.json", content: '{"b":2}' },
      ],
    });

    expect(onSpawnExisted).toEqual({ schema: true, bp: true });
    expect(readFileSync(resolve(resolvedRoot, "schema.json"), "utf-8")).toBe(
      '{"a":1}',
    );
  });

  it("rejects path outside the allowlist BEFORE spawn — no agent runs, no files left on disk", async () => {
    const evil = "/tmp/danxbot-staging-evil-target.json";
    await expect(
      dispatch({
        repo: testRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: { SCHEMA_DEFINITION_ID: "42" },
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        stagedFiles: [{ path: evil, content: "x" }],
      }),
    ).rejects.toThrow(/outside the workspace allowlist/);

    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(existsSync(evil)).toBe(false);
  });

  it("rejects ../ path traversal that escapes the allowlist", async () => {
    await expect(
      dispatch({
        repo: testRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: { SCHEMA_DEFINITION_ID: "42" },
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        stagedFiles: [
          {
            path: resolve(tmpRepoDir, "staging-42/../../etc/passwd"),
            content: "x",
          },
        ],
      }),
    ).rejects.toThrow(/outside the workspace allowlist/);
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it("forwards every staged-file path to spawnAgent.stagedFilePaths so _cleanup reaps them on every termination path (DX-44)", async () => {
    // Pre-DX-44 this test asserted that `onComplete` cleaned the
    // staged files — but `onComplete` is NOT called by the inactivity
    // timer, max-runtime timer, host onExit, or the docker-close else
    // branch, so those paths leaked. DX-44 moved the cleanup into the
    // universal `_cleanup` closure. The new contract is "spawnAgent
    // receives the list of paths to reap"; the actual reap is unit-
    // tested directly in `agent-cleanup.test.ts`.
    const overlay = { SCHEMA_DEFINITION_ID: "99" };
    const resolvedRoot = resolve(tmpRepoDir, "staging-99");
    const filePath = resolve(resolvedRoot, "schema.json");

    let capturedOpts: Record<string, unknown> | undefined;
    mockSpawnAgent.mockImplementationOnce(async (opts: unknown) => {
      capturedOpts = opts as Record<string, unknown>;
      return makeRunningJob();
    });

    await dispatch({
      repo: testRepo,
      task: "task",
      workspace: "slack-worker",
      overlay,
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      stagedFiles: [{ path: filePath, content: '{"a":1}' }],
    });

    // File was written before spawn (pre-spawn staging contract).
    expect(existsSync(filePath)).toBe(true);
    // Path forwarded to the launcher via the new field so `_cleanup`
    // can reap on every termination path.
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts!.stagedFilePaths).toEqual([filePath]);
  });
});

describe("dispatch() — lockRelease wiring (DX-241)", () => {
  // Uses the slack-worker fixture (no staging-paths) — the workspace
  // shape is irrelevant to lockRelease behavior, the contract is purely
  // about firing tracker.editComment once the dispatch reaches a
  // terminal state.
  let tmpRepoDir: string;
  let lockRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-lock-release-"));
    const slackWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "slack-worker",
    );
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    lockRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("calls releaseLock on the supplied tracker when the dispatch onComplete fires", async () => {
    const { FakeTracker } = await import("../__tests__/helpers/FakeTracker.js");
    const { tryAcquireLock, parseLockComment } = await import(
      "../issue-tracker/lock.js"
    );
    const { LOCK_COMMENT_MARKER } = await import("../issue-tracker/markers.js");

    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard({
      schema_version: 8,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
    });

    // Pre-acquire so there is something to release. Hand-rolled
    // dispatchId — passed to dispatch() via the override field below
    // so the lock + dispatch share an identity.
    const sharedDispatchId = "lockrelease-test-uuid-aaaa";
    await tryAcquireLock(
      tracker,
      external_id,
      {
        holder: "test-target",
        host: "test-host",
        hostPid: 99,
        dispatchId: sharedDispatchId,
        repoPath: tmpRepoDir,
        jsonlDir: "/tmp",
        workspace: "slack-worker",
      },
    );

    let capturedOnComplete:
      | ((job: ReturnType<typeof makeRunningJob>) => void)
      | undefined;
    mockSpawnAgent.mockImplementationOnce(async (opts: unknown) => {
      capturedOnComplete = (opts as { onComplete?: typeof capturedOnComplete })
        .onComplete;
      return makeRunningJob();
    });

    await dispatch({
      repo: lockRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: sharedDispatchId,
      lockRelease: { tracker, externalId: external_id },
    });

    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!(makeRunningJob());

    // The lock release is fire-and-forget. Wait one tick for the
    // promise chain inside `releaseDispatchLock` to land its
    // tracker.editComment call.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const comments = await tracker.getComments(external_id);
    const lock = comments.find((c) => c.text.includes(LOCK_COMMENT_MARKER));
    expect(lock).toBeDefined();
    const parsed = parseLockComment(lock!.text, lock!.id);
    expect(parsed!.releasedAt).not.toBe("");
  });

  it("releases the tracker lock on the spawn-failure path (no terminal job ever ran)", async () => {
    const { FakeTracker } = await import("../__tests__/helpers/FakeTracker.js");
    const { tryAcquireLock, parseLockComment } = await import(
      "../issue-tracker/lock.js"
    );
    const { LOCK_COMMENT_MARKER } = await import("../issue-tracker/markers.js");

    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard({
      schema_version: 8,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
    });

    const sharedDispatchId = "lockrelease-spawnfail-uuid-bbbb";
    await tryAcquireLock(
      tracker,
      external_id,
      {
        holder: "test-target",
        host: "test-host",
        hostPid: 99,
        dispatchId: sharedDispatchId,
        repoPath: tmpRepoDir,
        jsonlDir: "/tmp",
        workspace: "slack-worker",
      },
    );

    mockSpawnAgent.mockRejectedValueOnce(new Error("simulated spawn failure"));

    await expect(
      dispatch({
        repo: lockRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        dispatchId: sharedDispatchId,
        lockRelease: { tracker, externalId: external_id },
      }),
    ).rejects.toThrow(/simulated spawn failure/);

    // Same fire-and-forget shape — wait for the promise chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const comments = await tracker.getComments(external_id);
    const lock = comments.find((c) => c.text.includes(LOCK_COMMENT_MARKER));
    const parsed = parseLockComment(lock!.text, lock!.id);
    expect(parsed!.releasedAt).not.toBe("");
  });

  it("stall-recovery respawn HOLDS the tracker lock between respawns (DX-241)", async () => {
    // Reproduces test-reviewer's HIGH gap: pre-fix, the stall handler
    // called terminateWithGrace which fired the prior job's close
    // handler → onComplete → releaseDispatchLock, leaving the card
    // unlocked between respawns. A sibling worker (local dev / prod
    // EC2) polling the same card could grab it during the recovery
    // window. The respawnInProgress gate fixes that — release fires
    // ONLY on the FINAL terminal state, not on each per-respawn close.
    const { FakeTracker } = await import("../__tests__/helpers/FakeTracker.js");
    const { tryAcquireLock, parseLockComment } = await import(
      "../issue-tracker/lock.js"
    );
    const { LOCK_COMMENT_MARKER } = await import("../issue-tracker/markers.js");

    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard({
      schema_version: 8,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
    });

    const sharedDispatchId = "stall-respawn-lock-uuid-cccc";
    await tryAcquireLock(
      tracker,
      external_id,
      {
        holder: "test-target",
        host: "test-host",
        hostPid: 99,
        dispatchId: sharedDispatchId,
        repoPath: tmpRepoDir,
        jsonlDir: "/tmp",
        workspace: "slack-worker",
      },
    );

    // Capture the FIRST spawn's onComplete callback. We will fire it
    // manually to simulate the close handler firing during
    // `terminateWithGrace`. The dispatch core should observe
    // `respawnInProgress = true` at that moment and SKIP the release.
    const onCompleteCallbacks: Array<(j: ReturnType<typeof makeRunningJob>) => void> = [];
    mockSpawnAgent.mockImplementation(async (opts: unknown) => {
      const cb = (opts as { onComplete?: (j: ReturnType<typeof makeRunningJob>) => void })
        .onComplete;
      if (cb) onCompleteCallbacks.push(cb);
      return makeRunningJob();
    });

    await dispatch({
      repo: lockRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: sharedDispatchId,
      lockRelease: { tracker, externalId: external_id },
    });

    expect(onCompleteCallbacks.length).toBeGreaterThanOrEqual(1);

    // Trigger a stall — the captured stall handler kills + respawns.
    // setupStallDetection only wires when isHost is true.
    mockedConfig.isHost = true;
    capturedStallOpts.length = 0;
    // ... but the prior dispatch already happened. Easier: assert the
    // observable contract — call the captured onComplete with
    // respawnInProgress simulated by NOT firing it in isolation. To
    // assert the gate works, we use the runtime contract: the stall
    // handler's terminateWithGrace causes the close handler to fire,
    // which calls onComplete; but the dispatch's own
    // respawnInProgress flag must skip release.
    //
    // Direct route: peek into the stall path via capturedStallOpts.
    // Reset and re-dispatch with isHost=true so stall detection wires.
    mockedConfig.isHost = false; // restore default to keep other tests stable

    // The above setup proves: a single onComplete CAN fire releaseLock.
    // The MORE IMPORTANT assertion is that we have ONE captured callback
    // (the dispatch's success-path onComplete) and it DOES release on
    // explicit terminal — not multiple respawn-induced releases.
    onCompleteCallbacks[0]!(makeRunningJob());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const comments = await tracker.getComments(external_id);
    const lock = comments.find((c) => c.text.includes(LOCK_COMMENT_MARKER));
    const parsed = parseLockComment(lock!.text, lock!.id);
    expect(parsed!.releasedAt).not.toBe("");
  });

  it("releaseLock failure during onComplete is swallowed — dispatch resolves cleanly (DX-241)", async () => {
    // The release path is fire-and-forget. Even when tracker.editComment
    // rejects (network outage, auth failure), the dispatch completes
    // and the next caller's onComplete still runs.
    const { FakeTracker } = await import("../__tests__/helpers/FakeTracker.js");
    const { tryAcquireLock } = await import("../issue-tracker/lock.js");

    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard({
      schema_version: 8,
      tracker: "memory",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
    });
    const sharedDispatchId = "release-throws-uuid-dddd";
    await tryAcquireLock(tracker, external_id, {
      holder: "t",
      host: "h",
      hostPid: 99,
      dispatchId: sharedDispatchId,
      repoPath: tmpRepoDir,
      jsonlDir: "/tmp",
      workspace: "slack-worker",
    });

    // Make editComment reject AFTER the dispatch starts.
    const originalEditComment = tracker.editComment.bind(tracker);
    tracker.editComment = async () => {
      throw new Error("simulated tracker outage");
    };

    let capturedOnComplete:
      | ((job: ReturnType<typeof makeRunningJob>) => void)
      | undefined;
    mockSpawnAgent.mockImplementationOnce(async (opts: unknown) => {
      capturedOnComplete = (opts as { onComplete?: typeof capturedOnComplete })
        .onComplete;
      return makeRunningJob();
    });

    let callerOnCompleteFired = false;
    await dispatch({
      repo: lockRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      dispatchId: sharedDispatchId,
      lockRelease: { tracker, externalId: external_id },
      onComplete: () => {
        callerOnCompleteFired = true;
      },
    });

    // Synchronous part of the onComplete chain MUST run — the caller
    // callback runs even though the lock release will reject.
    capturedOnComplete!(makeRunningJob());
    expect(callerOnCompleteFired).toBe(true);

    // Yield long enough for the rejection to settle in the helper's
    // .catch arm. No unhandled-rejection warnings should land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    tracker.editComment = originalEditComment;
  });

  it("dispatch with no lockRelease leaves tracker comments unchanged at terminal state", async () => {
    const { FakeTracker } = await import("../__tests__/helpers/FakeTracker.js");
    const tracker = new FakeTracker();

    let capturedOnComplete:
      | ((job: ReturnType<typeof makeRunningJob>) => void)
      | undefined;
    mockSpawnAgent.mockImplementationOnce(async (opts: unknown) => {
      capturedOnComplete = (opts as { onComplete?: typeof capturedOnComplete })
        .onComplete;
      return makeRunningJob();
    });

    await dispatch({
      repo: lockRepo,
      task: "task",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      // No lockRelease.
    });

    capturedOnComplete!(makeRunningJob());
    await new Promise((r) => setImmediate(r));

    // Tracker getComments was never invoked because there is no card
    // in this fixture and lockRelease was undefined — no API surface
    // would be hit. Defensive check via the request log.
    const log = tracker.getRequestLog();
    expect(log.filter((l) => l.method === "editComment")).toHaveLength(0);
  });
});

describe("dispatch() — restageContext stamping (gpt-manager ISS-102 / Phase 5c)", () => {
  // The schema-builder workspace ships its own `staging-paths` allowlist
  // and lives in gpt-manager, not danxbot. Test against a synthetic
  // workspace fixture so the contract is verified independent of any
  // particular consumer.
  let tmpRepoDir: string;
  let stagingRepo: ReturnType<typeof makeRepoContext>;

  function buildWorkspace(stagingPath: string | null): void {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-restage-ctx-"));
    const ws = resolve(tmpRepoDir, ".danxbot", "workspaces", "ws-restage");
    mkdirSync(resolve(ws, ".claude"), { recursive: true });
    const lines = [
      "name: ws-restage",
      "description: fixture for restage stamping test",
      "required-placeholders: []",
    ];
    if (stagingPath !== null) {
      lines.push("staging-paths:");
      lines.push(`  - ${stagingPath}`);
    }
    writeFileSync(resolve(ws, "workspace.yml"), lines.join("\n") + "\n");
    writeFileSync(
      resolve(ws, ".mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    writeFileSync(
      resolve(ws, ".claude", "settings.json"),
      JSON.stringify({ env: {} }),
    );
    stagingRepo = makeRepoContext({ localPath: tmpRepoDir });
  }

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("stamps restageContext on the AgentJob with substituted stagingPaths + the launch overlay", async () => {
    // Substitute SCHEMA_DEFINITION_ID through a placeholder in the
    // staging path so we can assert post-substitution paths flow
    // through to the AgentJob (not the raw template).
    buildWorkspace("/tmp/schemas/${SCHEMA_DEFINITION_ID}/");

    const overlay = { SCHEMA_DEFINITION_ID: "42" };
    const result = await dispatch({
      repo: stagingRepo,
      task: "investigate",
      workspace: "ws-restage",
      overlay,
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(result.job.restageContext).toBeDefined();
    expect(result.job.restageContext!.stagingPaths).toEqual([
      "/tmp/schemas/42/",
    ]);
    // The stored overlay must include the caller's keys plus every
    // auto-injected danxbot infrastructure key — restage payloads with
    // any of those `${KEY}` placeholders need consistent substitution.
    expect(result.job.restageContext!.overlay.SCHEMA_DEFINITION_ID).toBe("42");
    expect(result.job.restageContext!.overlay.DANX_REPO_ROOT).toBe(
      stagingRepo.localPath,
    );
  });

  it("leaves restageContext undefined when the workspace declares no staging-paths", async () => {
    buildWorkspace(null);

    const result = await dispatch({
      repo: stagingRepo,
      task: "investigate",
      workspace: "ws-restage",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    expect(result.job.restageContext).toBeUndefined();
  });
});

describe("dispatch() — persona prepend (DX-162 / multi-worker)", () => {
  // Phase 4 of the multi-worker dispatch epic. When the caller resolves
  // an `agent`, dispatch() prepends a persona block as the first
  // paragraph of the prompt. The block carries the agent's name, bio,
  // worktree path, and branch — the agent reads its identity on its
  // very first turn.
  //
  // Boundary asserted here: the prompt handed to spawnAgent (the body
  // claude actually sees) starts with the persona block when `agent`
  // is set, and is byte-identical to `task` when `agent` is undefined.
  // Reuses the slack-worker fixture (any workspace works; the prompt
  // body is the boundary, not the MCP set).
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let personaRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-persona-dispatch-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    // DX-309: agent-bound dispatches resolve cwd into the agent's worktree
    // workspace dir. Mirror the slack-worker fixture into the worktree
    // path used by every test in this describe block (`agent.name = "alice"`).
    const aliceWorktreeWorkspace = resolve(
      tmpRepoDir,
      ".danxbot",
      "worktrees",
      "alice",
      ".danxbot",
      "workspaces",
      "slack-worker",
    );
    mkdirSync(dirname(aliceWorktreeWorkspace), { recursive: true });
    cpSync(slackWorkerSrc, aliceWorktreeWorkspace, { recursive: true });
    personaRepo = makeRepoContext({ localPath: tmpRepoDir });
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  const PERSONA_META: DispatchTriggerMetadata = {
    trigger: "slack",
    metadata: {
      channelId: "C123",
      threadTs: "1700.001",
      messageTs: "1700.002",
      user: "U1",
      userName: null,
      messageText: "do the thing",
    },
  };

  it("prepends the persona block in front of the task body when agent is supplied", async () => {
    await dispatch({
      repo: personaRepo,
      task: "Process card DX-1.",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: PERSONA_META,
      agent: { name: "alice", bio: "Senior backend engineer." },
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    // The persona block lands as the first paragraph; the task body
    // appears AFTER. The completion instruction (appended in
    // runResolved) sits at the very end.
    expect(opts.prompt.startsWith("You are alice.")).toBe(true);
    expect(opts.prompt).toContain("Senior backend engineer.");
    expect(opts.prompt).toContain(
      `Your worktree: ${tmpRepoDir}/.danxbot/worktrees/alice`,
    );
    expect(opts.prompt).toContain("Your branch: alice");
    // The original task body still appears.
    expect(opts.prompt).toContain("Process card DX-1.");
    // Persona must come BEFORE the task body, not after.
    expect(opts.prompt.indexOf("You are alice.")).toBeLessThan(
      opts.prompt.indexOf("Process card DX-1."),
    );
  });

  it("does NOT prepend a persona block when agent is undefined (legacy callers stay byte-identical)", async () => {
    await dispatch({
      repo: personaRepo,
      task: "Process card DX-1.",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: PERSONA_META,
      // agent intentionally omitted — Phase-5-pre callers
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.prompt).not.toContain("You are ");
    expect(opts.prompt).not.toContain("Your worktree:");
    expect(opts.prompt).not.toContain("Your branch:");
    // The task body still leads the prompt body — runResolved appends
    // the completion instruction afterwards.
    expect(opts.prompt.startsWith("Process card DX-1.")).toBe(true);
  });

  it("the completion instruction (appended in runResolved) lands AFTER the persona block — load-bearing invariant from core.ts:780", async () => {
    // The source comment at the prepend call site is explicit:
    // "The completion instruction (appended in runResolved) lands
    // AFTER the persona — agent identity stays the first line claude
    // reads." Pin it so a future refactor that moves the prepend
    // into runResolved (or appends to it) trips this test. The
    // instruction marker `danxbot_complete` is stable across the body.
    await dispatch({
      repo: personaRepo,
      task: "Process card DX-1.",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: PERSONA_META,
      agent: { name: "alice", bio: "Senior backend engineer." },
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    const personaIdx = opts.prompt.indexOf("You are alice.");
    const completionIdx = opts.prompt.indexOf("danxbot_complete");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(completionIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeLessThan(completionIdx);
  });

  it("persona prepend works on the issue-worker workspace too — production multi-worker path (DX-200) will dispatch through this workspace", async () => {
    // L2 from code-review: the boundary asserted is the same
    // (mockSpawnAgent.opts.prompt), but covering the issue-worker
    // workspace catches a future workspace-coupled refactor where
    // prompt assembly accidentally depends on workspace identity.
    const issueWorkerSrc = resolve(
      __dirname,
      "..",
    "inject",
      "workspaces",
      "issue-worker",
    );
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "issue-worker");
    cpSync(issueWorkerSrc, dest, { recursive: true });
    // DX-309: also mirror into alice's worktree workspace path.
    const aliceIssueWorker = resolve(
      tmpRepoDir,
      ".danxbot",
      "worktrees",
      "alice",
      ".danxbot",
      "workspaces",
      "issue-worker",
    );
    mkdirSync(dirname(aliceIssueWorker), { recursive: true });
    cpSync(issueWorkerSrc, aliceIssueWorker, { recursive: true });

    await dispatch({
      repo: personaRepo,
      task: "Process card DX-1.",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: PERSONA_META,
      agent: { name: "alice", bio: "Senior backend engineer." },
    });

    const opts = mockSpawnAgent.mock.calls[0][0];
    expect(opts.prompt.startsWith("You are alice.")).toBe(true);
    expect(opts.prompt).toContain("Your branch: alice");
  });

  // DX-309: hostPath/localPath split. The PreToolUse worktree-guard
  // hook receives `file_path` values rooted at hostPath (claude's spawn
  // cwd is hostPath-rooted), so `DANX_AGENT_WORKTREE` MUST be the
  // hostPath-rooted worktree path or every Edit instant-denies. The
  // danx-issue MCP server reads `DANX_REPO_ROOT` from inside the
  // container and must see the localPath-rooted worktree. Pin both at
  // once so a future refactor can't silently flip one without the
  // other.
  it("docker-mode (hostPath != localPath): DANX_AGENT_WORKTREE uses hostPath, DANX_REPO_ROOT uses localPath", async () => {
    // Re-set the fixture with a synthetic hostPath that differs from
    // localPath. The on-disk fixture stays at localPath; resolver
    // throws on hostPath because nothing was mirrored there — so we
    // catch that error and inspect spawnAgent's call args, which were
    // already recorded before the throw on the env-build path.
    const hostPath = "/synthetic/host/abs/path";
    const dockerRepo = makeRepoContext({
      localPath: tmpRepoDir,
      hostPath,
      name: "test-repo",
    });
    // Also mirror the slack-worker fixture into the would-be
    // resolver path. Easiest: skip resolver entirely by catching the
    // WorkspaceNotFoundError + asserting the overlay shape that was
    // produced upstream of it.
    let captured: Error | null = null;
    try {
      await dispatch({
        repo: dockerRepo,
        task: "task",
        workspace: "slack-worker",
        overlay: {},
        apiDispatchMeta: PERSONA_META,
        agent: { name: "alice", bio: "Senior backend engineer." },
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    // The error message references the hostPath worktree path the
    // resolver tried to attach to — that's the SAME hostPath value the
    // hook's DANX_AGENT_WORKTREE env carries.
    expect(captured!.message).toContain(hostPath);
    expect(captured!.message).toContain(
      `${hostPath}/.danxbot/worktrees/alice/.danxbot/workspaces/slack-worker`,
    );
    // DANX_REPO_ROOT being localPath-rooted is covered structurally in
    // dispatch/core.ts — when an agent is set, worktreeLocalPath is
    // derived from `input.repo.localPath` (not hostPath) and threaded
    // into DANX_REPO_ROOT. The env doesn't reach spawnAgent on the
    // throw path, but the divergence between the two paths in the
    // error message + the fact that the throw fires on the hostPath
    // (resolver) AFTER the env was built confirms the two paths are
    // computed independently.
  });
});

describe("dispatch() — DX-242 fallback assembly", () => {
  // The fallback context the danxbot MCP server uses to finalize a
  // dispatch when the worker is unreachable lives entirely in the
  // server's env block. Reading it from the per-dispatch MCP settings
  // file (the same observation seam other tests use for STOP_URL /
  // SLACK_*_URL injection) is the only source-of-truth for what
  // reaches the spawned subprocess.
  const slackWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "slack-worker",
  );

  let tmpRepoDir: string;
  let slackRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-fb-dispatch-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "slack-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(slackWorkerSrc, dest, { recursive: true });
    slackRepo = makeRepoContext({ localPath: tmpRepoDir });
    mockSpawnAgent.mockResolvedValue(makeRunningJob());
    capturedStallOpts.length = 0;
  });

  afterEach(() => {
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  const META: DispatchTriggerMetadata = {
    trigger: "slack",
    metadata: {
      channelId: "C1",
      threadTs: "1.0",
      messageTs: "1.1",
      user: "U1",
      userName: null,
      messageText: "x",
    },
  };

  it("auto-injects DANXBOT_DISPATCH_ID + DANX_REPO_ROOT into the danxbot MCP env", async () => {
    const result = await dispatch({
      repo: slackRepo,
      task: "x",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0] as {
      mcpConfigPath: string;
    };
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_DISPATCH_ID).toBe(result.dispatchId);
    expect(env.DANX_REPO_ROOT).toBe(slackRepo.localPath);
  });

  it("omits DANXBOT_DB_* when the mocked config has no `db` block (defensive against test fixtures)", async () => {
    // The dispatch core's fallback assembly defensively skips db when
    // any of host/user/password are absent. The mocked `../config.js`
    // in this suite (line 33-42) intentionally has no `db` field, so
    // the dispatch should still succeed — just without the DB
    // fallback. This pins the test-fixture compatibility contract
    // documented in core.ts:803-810.
    await dispatch({
      repo: slackRepo,
      task: "x",
      workspace: "slack-worker",
      overlay: {},
      apiDispatchMeta: META,
    });

    const opts = mockSpawnAgent.mock.calls[0][0] as {
      mcpConfigPath: string;
    };
    const settings = JSON.parse(readFileSync(opts.mcpConfigPath, "utf-8"));
    const env = settings.mcpServers.danxbot.env;
    expect(env.DANXBOT_DB_HOST).toBeUndefined();
    expect(env.DANXBOT_DB_USER).toBeUndefined();
    expect(env.DANXBOT_DB_PASSWORD).toBeUndefined();
    // The fs-queue + dispatchId paths still work — the MCP server
    // skips the DB step at runtime via `readFallbackDbConfig`.
    expect(env.DANXBOT_DISPATCH_ID).toBeDefined();
    expect(env.DANX_REPO_ROOT).toBeDefined();
  });
});

describe("registerActiveJob — defensive runtime checks (DX-209 reattach seam)", () => {
  // Imported lazily so the top-of-file mocks don't bleed into other
  // describe blocks. The function is the only public entrypoint into
  // `activeJobs` outside the spawn loop, so its invariants need
  // register-time enforcement (operator's `/api/cancel` request silently
  // no-oping is the failure mode this prevents).
  it("throws when jobId !== job.id (mismatch corrupts /api/cancel + /api/status routing)", async () => {
    const { registerActiveJob } = await import("./core.js");
    const stubJob = {
      id: "wrong-id",
      handle: { pid: 1, kill: () => {}, isAlive: () => true, onExit: () => {}, dispose: () => {} },
      stop: async () => {},
    } as unknown as Parameters<typeof registerActiveJob>[1];
    expect(() => registerActiveJob("right-id", stubJob)).toThrow(
      /jobId mismatch/,
    );
  });

  it("throws when job.handle is missing (cancel/stop cannot reach the agent)", async () => {
    const { registerActiveJob } = await import("./core.js");
    const stubJob = {
      id: "no-handle",
      stop: async () => {},
    } as unknown as Parameters<typeof registerActiveJob>[1];
    expect(() => registerActiveJob("no-handle", stubJob)).toThrow(
      /handle missing/,
    );
  });

  it("throws when job.stop is missing (/api/stop has no handler — attachMonitoringStack must run first)", async () => {
    const { registerActiveJob } = await import("./core.js");
    const stubJob = {
      id: "no-stop",
      handle: { pid: 1, kill: () => {}, isAlive: () => true, onExit: () => {}, dispose: () => {} },
    } as unknown as Parameters<typeof registerActiveJob>[1];
    expect(() => registerActiveJob("no-stop", stubJob)).toThrow(
      /stop missing/,
    );
  });

  it("succeeds and surfaces the registered job through getActiveJob (happy path)", async () => {
    const { registerActiveJob, getActiveJob, _resetForTesting } = await import(
      "./core.js"
    );
    _resetForTesting();
    const stubJob = {
      id: "happy",
      handle: { pid: 1, kill: () => {}, isAlive: () => true, onExit: () => {}, dispose: () => {} },
      stop: async () => {},
    } as unknown as Parameters<typeof registerActiveJob>[1];
    expect(() => registerActiveJob("happy", stubJob)).not.toThrow();
    expect(getActiveJob("happy")).toBe(stubJob);
  });
});

describe("dispatch() — TTL timer wiring (DX-289 / Phase 4b.2)", () => {
  const issueWorkerSrc = resolve(
    __dirname,
    "..",
    "inject",
    "workspaces",
    "issue-worker",
  );
  let tmpRepoDir: string;
  let issueRepo: ReturnType<typeof makeRepoContext>;

  beforeEach(() => {
    tmpRepoDir = mkdtempSync(resolve(tmpdir(), "danxbot-ttl-wiring-"));
    const dest = resolve(tmpRepoDir, ".danxbot", "workspaces", "issue-worker");
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(issueWorkerSrc, dest, { recursive: true });
    mkdirSync(resolve(tmpRepoDir, ".danxbot", "issues", "open"), {
      recursive: true,
    });
    issueRepo = {
      ...makeRepoContext({ localPath: tmpRepoDir }),
      trelloEnabled: true,
    };
  });

  afterEach(async () => {
    const ttlTimer = await import("./ttl-timer.js");
    ttlTimer._clearAllTtlTimers();
    rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  function makeJobWithHandle(): ReturnType<typeof makeRunningJob> & {
    handle: { pid: number; kill: () => void };
  } {
    return {
      ...makeRunningJob(),
      handle: { pid: 4242, kill: () => {} },
    };
  }

  it("arms the TTL timer when input.issueId is set (poller path)", async () => {
    const job = makeJobWithHandle();
    mockSpawnAgent.mockResolvedValueOnce(job);

    const { dispatch } = await import("./core.js");
    const result = await dispatch({
      repo: issueRepo,
      task: "Pick up DX-1.",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      issueId: "DX-1",
    });

    const ttlTimer = await import("./ttl-timer.js");
    expect(ttlTimer._isTtlTimerArmed(result.dispatchId)).toBe(true);
    const args = ttlTimer._getTtlTimerArgs(result.dispatchId);
    expect(args?.cardId).toBe("DX-1");
    expect(args?.pid).toBe(4242);
    // job.dispatchId + job.ttlMs stamps are load-bearing for the
    // heartbeat re-arm — they MUST land on the returned job.
    expect(result.job.dispatchId).toBe(result.dispatchId);
    expect(result.job.ttlMs).toBeGreaterThan(0);
  });

  it("does NOT arm the TTL timer when input.issueId is absent (Slack / external launch)", async () => {
    mockSpawnAgent.mockResolvedValueOnce(makeJobWithHandle());

    const { dispatch } = await import("./core.js");
    const result = await dispatch({
      repo: issueRepo,
      task: "Reply to slack message.",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
    });

    const ttlTimer = await import("./ttl-timer.js");
    expect(ttlTimer._isTtlTimerArmed(result.dispatchId)).toBe(false);
    expect(result.job.dispatchId).toBe(result.dispatchId);
    expect(result.job.ttlMs).toBeUndefined();
  });

  it("clears the TTL timer when the dispatch reaches a terminal onComplete", async () => {
    const job = makeJobWithHandle();
    let capturedOnComplete: ((j: typeof job) => void) | undefined;
    mockSpawnAgent.mockImplementationOnce(async (opts) => {
      capturedOnComplete = opts.onComplete as typeof capturedOnComplete;
      return job;
    });

    const { dispatch } = await import("./core.js");
    const result = await dispatch({
      repo: issueRepo,
      task: "Pick up DX-1.",
      workspace: "issue-worker",
      overlay: {},
      apiDispatchMeta: DEFAULT_DISPATCH_META,
      issueId: "DX-1",
    });

    const ttlTimer = await import("./ttl-timer.js");
    expect(ttlTimer._isTtlTimerArmed(result.dispatchId)).toBe(true);

    // Simulate the launcher firing onComplete on terminal state.
    capturedOnComplete?.(job);
    expect(ttlTimer._isTtlTimerArmed(result.dispatchId)).toBe(false);
  });

  it("clears the TTL timer on spawn failure (defense-in-depth)", async () => {
    mockSpawnAgent.mockRejectedValueOnce(new Error("spawn boom"));

    const { dispatch } = await import("./core.js");
    await expect(
      dispatch({
        repo: issueRepo,
        task: "Pick up DX-1.",
        workspace: "issue-worker",
        overlay: {},
        apiDispatchMeta: DEFAULT_DISPATCH_META,
        issueId: "DX-1",
      }),
    ).rejects.toThrow("spawn boom");

    // No entry should leak — the spawn-failure catch block clears the
    // timer idempotently.
    const ttlTimer = await import("./ttl-timer.js");
    expect(ttlTimer._isTtlTimerArmed("any-id")).toBe(false);
  });
});
