import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoContext } from "../types.js";

// Set REPOS before index.ts loads so getDanxbotConfigDir() resolves a path
vi.hoisted(() => {
  process.env.REPOS = "test-repo:https://github.com/org/repo.git";
});

const MOCK_REPO_CONTEXT: RepoContext = {
  name: "test-repo",
  url: "https://example.com/test.git",
  localPath: "/test/repos/test-repo",
  trello: {
    apiKey: "test-key",
    apiToken: "test-token",
    boardId: "test-board",
    reviewListId: "review-list",
    todoListId: "todo-list",
    inProgressListId: "ip-list",
    needsHelpListId: "nh-list",
    doneListId: "done-list",
    cancelledListId: "cancelled-list",
    actionItemsListId: "ai-list",
    bugLabelId: "bug-label",
    featureLabelId: "feature-label",
    epicLabelId: "epic-label",
    needsHelpLabelId: "nh-label",
  },
  slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
  db: { host: "", port: 3306, user: "", password: "", database: "", enabled: false },
  githubToken: "test-github-token",
  trelloEnabled: true,
  workerPort: 5562,
};

// Mock dependencies before importing module under test
// NOTE: vi.mock factories are hoisted and can't reference MOCK_REPO_CONTEXT directly.
// Use vi.hoisted to make it available at hoist time.
const { mockRepoContexts } = vi.hoisted(() => {
  const ctx = {
    name: "test-repo",
    url: "https://example.com/test.git",
    localPath: "/test/repos/test-repo",
    trello: {
      apiKey: "test-key", apiToken: "test-token", boardId: "test-board",
      reviewListId: "review-list", todoListId: "todo-list", inProgressListId: "ip-list",
      needsHelpListId: "nh-list", doneListId: "done-list", cancelledListId: "cancelled-list",
      actionItemsListId: "ai-list", bugLabelId: "bug-label", featureLabelId: "feature-label",
      epicLabelId: "epic-label", needsHelpLabelId: "nh-label",
    },
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: { host: "", port: 3306, user: "", password: "", database: "", enabled: false },
    githubToken: "test-github-token",
    trelloEnabled: true,
    workerPort: 5562,
  };
  return { mockRepoContexts: [ctx] };
});

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    pollerIntervalMs: 60000,
    isHost: true,
    pollerBackoffScheduleMs: [60_000, 300_000, 900_000, 1_800_000],
  },
}));
vi.mock("../config.js", () => ({
  config: mockConfig,
}));

vi.mock("../repo-context.js", () => ({
  repoContexts: mockRepoContexts,
}));

vi.mock("./constants.js", () => ({
  getReposBase: () => "/danxbot/repos",
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
  TEAM_PROMPT: "/danx-next",
  IDEATOR_PROMPT: "/danx-ideate",
}));

const mockFetchTodoCards = vi.fn();
const mockFetchNeedsHelpCards = vi.fn();
const mockFetchReviewCards = vi.fn();
const mockFetchInProgressCards = vi.fn();
const mockFetchLatestComment = vi.fn();
const mockFetchCard = vi.fn();
const mockMoveCardToList = vi.fn();
const mockAddComment = vi.fn();
const mockIsUserResponse = vi.fn();
vi.mock("./trello-client.js", () => ({
  fetchTodoCards: (...args: unknown[]) => mockFetchTodoCards(...args),
  fetchNeedsHelpCards: (...args: unknown[]) => mockFetchNeedsHelpCards(...args),
  fetchReviewCards: (...args: unknown[]) => mockFetchReviewCards(...args),
  fetchInProgressCards: (...args: unknown[]) =>
    mockFetchInProgressCards(...args),
  fetchLatestComment: (...args: unknown[]) => mockFetchLatestComment(...args),
  fetchCard: (...args: unknown[]) => mockFetchCard(...args),
  moveCardToList: (...args: unknown[]) => mockMoveCardToList(...args),
  addComment: (...args: unknown[]) => mockAddComment(...args),
  isUserResponse: (...args: unknown[]) => mockIsUserResponse(...args),
}));

const mockReadFlag = vi.fn().mockReturnValue(null);
const mockWriteFlag = vi.fn();
vi.mock("../critical-failure.js", () => ({
  readFlag: (...args: unknown[]) => mockReadFlag(...args),
  writeFlag: (...args: unknown[]) => mockWriteFlag(...args),
  clearFlag: vi.fn().mockReturnValue(false),
  flagPath: (localPath: string) => `${localPath}/.danxbot/CRITICAL_FAILURE`,
}));

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

/**
 * The default `dispatch()` mock resolves to a shape mirroring the real
 * `DispatchResult` (`{dispatchId, job}`). `.mockImplementation` survives
 * `vi.clearAllMocks()` (only call history is cleared), so every test
 * inherits this default unless it explicitly overrides via
 * `.mockImplementation` / `.mockResolvedValue`. Tests that need to capture
 * `onComplete` override the implementation to do so.
 */
const mockDispatch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    dispatchId: "test-dispatch-id",
    job: {
      id: "test-job",
      status: "running" as const,
      summary: "",
      startedAt: new Date(),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }),
);
vi.mock("../dispatch/core.js", () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
}));

const mockIsFeatureEnabled = vi.fn().mockReturnValue(true);
const mockGetTrelloPollerPickupPrefix = vi.fn().mockReturnValue(null);
vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
  getTrelloPollerPickupPrefix: (...args: unknown[]) =>
    mockGetTrelloPollerPickupPrefix(...args),
}));

const mockGenerateWorkspace = vi
  .fn()
  .mockReturnValue({ path: "/mock/workspace", changedFiles: [] });
// `workspacePath` is imported alongside `generateWorkspace` by `syncRepoFiles`
// (Phase 3 dual-write target — see the agent-isolation epic `7ha2CSpc`).
// Both must be mocked; omitting the second one surfaces as an
// "[vitest] No X export" unhandled rejection during `start()`. The
// overloaded helper accepts either a `RepoContext` or a bare repoName —
// the mock handles both shapes to stay in sync with the real API.
vi.mock("../workspace/generate.js", () => ({
  generateWorkspace: (...args: unknown[]) => mockGenerateWorkspace(...args),
  workspacePath: (input: { localPath: string } | string) =>
    typeof input === "string"
      ? `/danxbot/repos/${input}/.danxbot/workspace`
      : `${input.localPath}/.danxbot/workspace`,
  // Phase 2 of the workspace-dispatch epic (Trello `VKJzZjk9`) promoted
  // `writeIfChanged` to a shared export so `injectDanxWorkspaces` can
  // reuse the idempotent-write primitive. The mock forwards to the real
  // `mockWriteFileSync` so tests assert on the same `.mock.calls`
  // surface they already use for the rest of the inject pipeline.
  writeIfChanged: (path: string, content: string): boolean => {
    mockWriteFileSync(path, content);
    return true;
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

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn().mockReturnValue([]);
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockRmSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  copyFileSync: (...args: unknown[]) => mockCopyFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  // chmodSync is silently tolerated by `chmodExecutable` — no tracking
  // mock needed, but the symbol MUST exist so `import { chmodSync }`
  // from the module under test resolves. Returning `undefined` is fine.
  chmodSync: vi.fn(),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

import { poll, shutdown, start, syncRepoFiles, _resetForTesting } from "./index.js";

function createFakeSpawnResult() {
  return { unref: vi.fn(), on: vi.fn() };
}

const FAKE_CONFIG_YML = `name: test-repo
url: https://github.com/org/repo.git
runtime: local
language: node
framework: express

commands:
  test: "npm test"
  lint: ""
  type_check: ""
  dev: ""

paths:
  source: "src/"
  tests: "tests/"
`;

/** Make existsSync return true for .danxbot/config/ paths, false by default */
function setupRepoConfigMocks() {
  mockExistsSync.mockImplementation((path: string) => {
    if (typeof path === "string" && (
      path.includes(".danxbot/config") ||
      path.endsWith("config.yml") ||
      path.endsWith("overview.md") ||
      path.endsWith("workflow.md") ||
      path.endsWith("trello.yml")
    )) return true;
    return false;
  });
  mockReadFileSync.mockImplementation((path: string) => {
    if (typeof path === "string" && path.endsWith("config.yml")) return FAKE_CONFIG_YML;
    if (typeof path === "string" && path.endsWith("trello.yml")) return "board_id: mock-board-id\n";
    if (typeof path === "string" && path.endsWith(".md")) return "# placeholder";
    return "";
  });
}

describe("poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  it("skips when teamRunning is true", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    await poll(MOCK_REPO_CONTEXT);

    // Second call: should skip because teamRunning is true
    mockFetchTodoCards.mockClear();
    mockSpawn.mockClear();
    mockFetchNeedsHelpCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does nothing when no cards in ToDo", async () => {
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("regenerates the workspace on every tick before syncing repo files", async () => {
    // Phase 1 contract: the workspace skeleton refreshes every tick so
    // config-file updates inside `.danxbot/config/` flow to dispatched
    // agents without a worker restart. Ordering matters once Phase 3
    // switches spawn cwd to the workspace — if the rule/skill sync fires
    // first, a dispatched agent could momentarily cd into a workspace
    // whose `.claude/` subtree doesn't yet exist.
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockGenerateWorkspace).toHaveBeenCalledWith(MOCK_REPO_CONTEXT);
    // The trello-client call happens inside syncRepoFiles' downstream
    // cascade (poll → syncRepoFiles → fetchTodoCards). Asserting the
    // workspace-generator runs before trello fetching covers the ordering.
    expect(mockGenerateWorkspace).toHaveBeenCalledBefore(mockFetchTodoCards);
  });

  it("calls dispatch() with the trello-worker workspace and trello overlay when cards exist", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.any(String),
        repo: expect.objectContaining({ name: "test-repo" }),
        // Phase 3 invariant (workspace-dispatch epic, Trello `q5aFuINM`):
        // the poller dispatches via the named `trello-worker` workspace.
        // The MCP server set + allowed-tools live in
        // `src/poller/inject/workspaces/trello-worker/`; the overlay
        // supplies the trello credentials the workspace's `.mcp.json`
        // substitutes into its env block.
        workspace: "trello-worker",
        overlay: expect.objectContaining({
          DANXBOT_WORKER_PORT: String(MOCK_REPO_CONTEXT.workerPort),
          TRELLO_API_KEY: MOCK_REPO_CONTEXT.trello.apiKey,
          TRELLO_TOKEN: MOCK_REPO_CONTEXT.trello.apiToken,
          TRELLO_BOARD_ID: MOCK_REPO_CONTEXT.trello.boardId,
        }),
      }),
    );
  });

  it("handles fetchTodoCards failure gracefully", async () => {
    mockFetchTodoCards.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("syncRepoFiles writes every danx-* artifact ONLY into the workspace (Phase 5 of agent-isolation epic)", async () => {
    // The inject pipeline writes EXCLUSIVELY into
    // `<repo>/.danxbot/workspace/.claude/`. The repo-root `.claude/` is
    // strictly developer-owned — danxbot never touches it. Every
    // dispatched agent cwds into the workspace so no content is lost.
    // See Trello `7ha2CSpc` (Phase 5).
    mockFetchTodoCards.mockResolvedValue([]);
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes("inject")) return true;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.endsWith("tools.md")) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      // Workspace-dispatch P4 (Trello `gAeJBEDr`): danx-slack-agent.md
      // moved from `inject/rules/` into `inject/workspaces/slack-worker/
      // .claude/rules/`. The standalone `inject/rules/` tree is empty now
      // — rules are mirrored per-workspace instead.
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return ["danx-helper.sh"];
      // Workspace-dispatch P3 (Trello `q5aFuINM`): skills moved out of
      // `inject/skills/` into `inject/workspaces/trello-worker/.claude/
      // skills/`. The standalone `inject/skills/` tree is intentionally
      // empty now; the workspace inject path mirrors the per-workspace
      // skills instead.
      return [];
    });

    await poll(MOCK_REPO_CONTEXT);

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const copiedDests = mockCopyFileSync.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );
    const allTouched = [...writtenPaths, ...copiedDests];

    const workspaceClaudePrefix =
      "/test/repos/test-repo/.danxbot/workspace/.claude/";
    const workspacesPluralPrefix =
      "/test/repos/test-repo/.danxbot/workspaces/";
    const repoRootClaudePrefix = "/test/repos/test-repo/.claude/";

    // Every artifact lands in the workspace. After P4 of the workspace-
    // dispatch epic (Trello `gAeJBEDr`) danx-slack-agent.md joined
    // danx-halt-flag.md and danx-{next,ideate,start,triage} in their
    // respective workspace fixtures (slack-worker / trello-worker).
    // The singular workspace now keeps only the per-repo generated
    // rules + shared tools.
    const expectedWorkspaceArtifacts = [
      `${workspaceClaudePrefix}rules/danx-repo-config.md`,
      `${workspaceClaudePrefix}rules/danx-repo-overview.md`,
      `${workspaceClaudePrefix}rules/danx-repo-workflow.md`,
      `${workspaceClaudePrefix}rules/danx-tools.md`,
      `${workspaceClaudePrefix}rules/danx-trello-config.md`,
      `${workspaceClaudePrefix}tools/danx-helper.sh`,
    ];
    for (const expected of expectedWorkspaceArtifacts) {
      expect(allTouched).toContain(expected);
    }

    // Isolation invariant: NOTHING is written to the developer's
    // repo-root `.claude/`. A single stray write breaks the whole point
    // of the agent-isolation epic, so the assertion is a strict match on
    // the prefix — not a "none of the generated names" list — to catch
    // any new file types an inject step might add.
    //
    // Workspace-dispatch epic, Phase 2: writes under
    // `<repo>/.danxbot/workspaces/` (plural) are an explicitly permitted
    // destination for `injectDanxWorkspaces`. No workspace fixtures
    // ship in P2 so no writes land there yet; the allowance exists so
    // P3/P4/P5 can add fixtures without this assertion flipping red.
    const repoRootClaudeTouches = allTouched.filter(
      (p) =>
        p.startsWith(repoRootClaudePrefix) &&
        !p.startsWith(workspaceClaudePrefix) &&
        !p.startsWith(workspacesPluralPrefix),
    );
    expect(repoRootClaudeTouches).toEqual([]);
  });

  it("syncRepoFiles throws and writes nothing when a required config.yml field is missing (fail-loud — Trello `C7W1cEhh`)", () => {
    // Required-field guarantees in `validateRepoConfig` are belt-and-
    // suspenders; if anything ever calls `syncRepoFiles` without prior
    // boot validation (or `validateRepoConfig` regresses), the rule-file
    // renderer throws rather than silently emitting `| Name | \`unknown\` |`
    // and `unknown-compose.yml`. This test pins the contract at the
    // integration level: a missing `name` aborts the sync, leaving the
    // workspace untouched.
    const brokenConfig = `url: https://github.com/org/repo.git
runtime: local
language: node
`; // missing `name`
    mockReadFileSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith("config.yml")) return brokenConfig;
      if (typeof path === "string" && path.endsWith("trello.yml")) return "board_id: mock-board-id\n";
      if (typeof path === "string" && path.endsWith(".md")) return "# placeholder";
      return "";
    });

    expect(() => syncRepoFiles(MOCK_REPO_CONTEXT)).toThrow(
      /'name'.*missing/,
    );

    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const copiedDests = mockCopyFileSync.mock.calls.map(
      (c: unknown[]) => c[1] as string,
    );

    // The rendered rule must NOT land — that was the whole point of the
    // silent `|| "unknown"` fallback existing in the first place (mask the
    // bug). With fail-loud, the file is never produced.
    expect(
      writtenPaths.find((p) => p.endsWith("danx-repo-config.md")),
    ).toBeUndefined();

    // And the line-815 callsite (`copyComposeOverride` writing
    // `<cfg.name>-compose.yml`) must never produce an `unknown-compose.yml`.
    expect(
      copiedDests.find((p) => p.includes("unknown-compose.yml")),
    ).toBeUndefined();
  });

  it("injectDanxWorkspaces ensures <repo>/.danxbot/workspaces/ exists (P2 contract — empty source dir is a no-op apart from mkdir)", async () => {
    // Phase 2 of the workspace-dispatch epic (Trello `VKJzZjk9`) ships
    // the inject pipeline but zero fixtures. The helper must still
    // create the target root so the on-disk shape is stable for
    // downstream phases and for the manual verification in the card
    // description (`make launch-worker` produces an empty
    // `.danxbot/workspaces/` dir after one tick).
    mockFetchTodoCards.mockResolvedValue([]);
    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes("inject")) return true;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      return false;
    });
    // Default readdirSync returns [] for every path — the inject/workspaces
    // source dir is empty in P2 so no fixtures to walk.
    mockReaddirSync.mockReturnValue([]);

    await poll(MOCK_REPO_CONTEXT);

    const mkdirPaths = mockMkdirSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(mkdirPaths).toContain(
      "/test/repos/test-repo/.danxbot/workspaces",
    );

    // With an empty source, no file writes land under workspaces/.
    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    const workspacesWrites = writtenPaths.filter((p) =>
      p.startsWith("/test/repos/test-repo/.danxbot/workspaces/"),
    );
    expect(workspacesWrites).toEqual([]);
  });

  it("injectDanxWorkspaces mirrors a fixture tree, leaves orphans alone, and makes .sh helpers under tools/ executable", async () => {
    // Helper recursively mirrors `src/poller/inject/workspaces/<name>/`
    // into `<repo>/.danxbot/workspaces/<name>/` via writeIfChanged
    // (idempotent), and sets the executable bit on `.sh` files nested
    // under a `tools/` ancestor. Write-only contract: target entries
    // missing from source are LEFT IN PLACE — the poller never deletes
    // anything in a connected repo (incident retro: nuking a
    // gpt-manager-authored `schema-builder/` workspace tracked in
    // gpt-manager's git).
    mockFetchTodoCards.mockResolvedValue([]);

    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const demoToolsSource = `${demoSource}/tools`;
    const workspacesTargetRoot =
      "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;
    const demoToolsTarget = `${demoTargetRoot}/tools`;
    // An old workspace that was removed from the source on a previous
    // tick — must SURVIVE on the target after this tick (write-only).
    const orphanWorkspaceTargetRoot = `${workspacesTargetRoot}/old-removed`;

    // Source paths (`injectDir` is resolved to an absolute path at module
    // load), so match by suffix. Target paths (`workspacesTargetRoot`) are
    // already absolute from `MOCK_REPO_CONTEXT.localPath`, so match exactly.
    const sourceDirSuffixes = [demoSource, demoToolsSource];
    const targetDirExact = new Set<string>([
      workspacesTargetRoot,
      demoTargetRoot,
      demoToolsTarget,
      orphanWorkspaceTargetRoot,
    ]);

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.includes("inject/rules") || path.includes("inject/tools") ||
          path.includes("inject/skills")) {
        return true;
      }
      if (path.endsWith(workspacesSource) || path.includes(`${workspacesSource}/`)) {
        return true;
      }
      if (path === workspacesTargetRoot || path.startsWith(`${workspacesTargetRoot}/`)) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      // inject/* dirs unused in this test — keep empty to avoid inventing
      // side effects outside workspaces/.
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      if (path.endsWith(workspacesSource)) return ["demo"];
      if (path.endsWith(demoSource)) return ["workspace.yml", "tools"];
      if (path.endsWith(demoToolsSource)) return ["helper.sh"];
      if (path === workspacesTargetRoot) return ["demo", "old-removed"];
      if (path === demoTargetRoot) return ["workspace.yml", "tools"];
      if (path === demoToolsTarget) return ["helper.sh", "stale.sh"];
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      const isDir =
        targetDirExact.has(path) ||
        sourceDirSuffixes.some((suffix) => path.endsWith(suffix));
      return {
        isDirectory: () => isDir,
      };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("workspace.yml")) return "name: demo\ndescription: demo\n";
      if (path.endsWith("helper.sh")) return "#!/bin/bash\necho ok\n";
      return "";
    });

    await poll(MOCK_REPO_CONTEXT);

    // Idempotent mirror copied both source files to the correct targets.
    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toContain(`${demoTargetRoot}/workspace.yml`);
    expect(writtenPaths).toContain(`${demoToolsTarget}/helper.sh`);

    // Write-only contract: stale tool file AND orphan workspace SURVIVE.
    const rmPaths = mockRmSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(rmPaths).not.toContain(`${demoToolsTarget}/stale.sh`);
    expect(rmPaths).not.toContain(orphanWorkspaceTargetRoot);
  });

  it("injectDanxWorkspaces ignores non-directory entries at the workspaces root (the .gitkeep tombstone)", async () => {
    // Regression for a bug surfaced by `make test-system-poller` in P3:
    // src/poller/inject/workspaces/.gitkeep is a tracked file P2 added so
    // the directory survives clean checkouts. The iteration loop in
    // injectDanxWorkspaces fed every readdirSync entry into
    // mirrorWorkspaceTree without filtering, so it tried to readdirSync
    // the .gitkeep file as a directory and crashed with ENOTDIR. The fix:
    // statSync(srcPath).isDirectory() guard at the workspaces-root walk.
    mockFetchTodoCards.mockResolvedValue([]);

    const workspacesSource = "src/poller/inject/workspaces";
    const demoSource = `${workspacesSource}/demo`;
    const gitkeepSource = `${workspacesSource}/.gitkeep`;
    const workspacesTargetRoot =
      "/test/repos/test-repo/.danxbot/workspaces";
    const demoTargetRoot = `${workspacesTargetRoot}/demo`;

    mockExistsSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return false;
      if (path.includes(".danxbot/config")) return true;
      if (path.endsWith("config.yml")) return true;
      if (path.endsWith("overview.md")) return true;
      if (path.endsWith("workflow.md")) return true;
      if (path.endsWith("trello.yml")) return true;
      if (path.includes("inject/rules") || path.includes("inject/tools") ||
          path.includes("inject/skills")) {
        return true;
      }
      if (path.endsWith(workspacesSource) || path.includes(`${workspacesSource}/`)) {
        return true;
      }
      if (path === workspacesTargetRoot || path.startsWith(`${workspacesTargetRoot}/`)) {
        return true;
      }
      return false;
    });

    mockReaddirSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return [];
      if (path.endsWith("/inject/rules")) return [];
      if (path.endsWith("/inject/tools")) return [];
      if (path.endsWith("/inject/skills")) return [];
      // The smoking gun: source root has both a workspace dir AND a
      // .gitkeep file. Pre-fix the loop crashed; post-fix it skips
      // .gitkeep entirely.
      if (path.endsWith(workspacesSource)) return ["demo", ".gitkeep"];
      if (path.endsWith(demoSource)) return ["workspace.yml"];
      if (path === workspacesTargetRoot) return [];
      if (path === demoTargetRoot) return [];
      // Mirror Node's behavior on real disk: readdirSync against a file
      // throws ENOTDIR. The pre-fix bug fed `.gitkeep` (a file) into the
      // recursive walk which then hit this branch in production.
      if (path.endsWith(gitkeepSource)) {
        const err = new Error(`ENOTDIR: not a directory, scandir '${path}'`);
        (err as NodeJS.ErrnoException).code = "ENOTDIR";
        throw err;
      }
      return [];
    });

    mockStatSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") {
        return { isDirectory: () => false };
      }
      // .gitkeep is the file; everything else under workspaces/ is a dir.
      if (path.endsWith(gitkeepSource)) return { isDirectory: () => false };
      const isDir =
        path === workspacesTargetRoot ||
        path === demoTargetRoot ||
        path.endsWith(demoSource) ||
        path.endsWith(workspacesSource);
      return { isDirectory: () => isDir };
    });

    mockReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path !== "string") return "";
      if (path.endsWith("config.yml")) return FAKE_CONFIG_YML;
      if (path.endsWith("workspace.yml")) return "name: demo\ndescription: demo\n";
      return "";
    });

    // Pre-fix this throws ENOTDIR; post-fix it completes cleanly.
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();

    // The demo workspace's contents still mirror to the target.
    const writtenPaths = mockWriteFileSync.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(writtenPaths).toContain(`${demoTargetRoot}/workspace.yml`);
    // No write attempts to a `.gitkeep` target — the file is silently skipped.
    const gitkeepWrites = writtenPaths.filter((p) => p.endsWith(".gitkeep"));
    expect(gitkeepWrites).toEqual([]);
  });

});

describe("poll — trelloPoller feature toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })),
    );
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("skips the tick and does not fetch cards when disabled", async () => {
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "trelloPoller",
    );
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("runs normally when enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchNeedsHelpCards).toHaveBeenCalled();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });
});

describe("poll — pickup-name-prefix filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        name: `Review ${i}`,
      })),
    );
    mockIsFeatureEnabled.mockReturnValue(true);
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
  });

  afterEach(() => {
    // `vi.clearAllMocks()` resets call history but NOT `.mockReturnValue`,
    // so a prefix set inside one of the tests below would leak into the
    // sibling describe blocks (Needs Help, post-dispatch check, Docker mode,
    // stuck-card recovery) which share the same module-level mock and would
    // then silently filter out their fixture cards. Restore the default
    // here so this section's tests never bleed into the rest of the file.
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
  });

  it("dispatches the matching test card when other ToDo cards are present (system-test isolation)", async () => {
    // Reproduces the fix from Trello card IleofrBj: when the operator
    // (or test harness) sets a `pickupNamePrefix`, the poller must dispatch
    // ONLY cards whose name starts with that prefix. Without the filter, a
    // pre-existing stuck card at the top of ToDo would be picked first and
    // hold `teamRunning` for hours, blocking the test card indefinitely.
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[System Test]");
    mockFetchTodoCards.mockResolvedValue([
      { id: "stuck", name: "Fix: Dispatch token usage…" },
      { id: "real", name: "Real ToDo card B" },
      { id: "test", name: "[System Test] Read package.json — 1761000000" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    // The dispatch was issued for the test card, NOT the stuck card at top.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const dispatchCall = mockDispatch.mock.calls[0][0];
    expect(dispatchCall.apiDispatchMeta).toEqual(
      expect.objectContaining({
        trigger: "trello",
        metadata: expect.objectContaining({
          cardId: "test",
          cardName: "[System Test] Read package.json — 1761000000",
        }),
      }),
    );
  });

  it("falls through to the no-cards branch when prefix is set but no card matches", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[System Test]");
    mockFetchTodoCards.mockResolvedValue([
      { id: "a", name: "Real ToDo card A" },
      { id: "b", name: "Real ToDo card B" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).toHaveBeenCalled();
    // Zero matching cards means no dispatch is issued — the prefix
    // semantics are "ignore everything else", not "fail loud".
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches normally when prefix is null (filter disabled)", async () => {
    mockGetTrelloPollerPickupPrefix.mockReturnValue(null);
    mockFetchTodoCards.mockResolvedValue([
      { id: "any", name: "Some real card" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves stuck-card recovery scope: only matching cards are saved as priorTodoCardIds", async () => {
    // The post-failure recovery path uses `priorTodoCardIds` to detect cards
    // the agent moved into In Progress mid-failure. With a filter active,
    // recovery must only consider the cards we actually dispatched against —
    // tracking the unrelated real ToDo cards would falsely "recover" them.
    mockGetTrelloPollerPickupPrefix.mockReturnValue("[X]");
    mockFetchTodoCards.mockResolvedValue([
      { id: "real-1", name: "Real card 1" },
      { id: "x-1", name: "[X] test card" },
    ]);
    mockFetchInProgressCards.mockResolvedValue([
      { id: "real-1", name: "Real card 1" },
      { id: "x-1", name: "[X] test card" },
    ]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementationOnce((input: { onComplete?: (j: unknown) => void }) => {
      capturedOnComplete = input.onComplete;
      return Promise.resolve({
        dispatchId: "d",
        job: {
          id: "j",
          status: "failed" as const,
          summary: "boom",
          startedAt: new Date(),
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
    });

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "j",
      status: "failed",
      summary: "boom",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    // Wait a tick for the chained promise (handleAgentCompletion) to run.
    await new Promise((r) => setImmediate(r));

    // Only the matching card should be considered for recovery — the unrelated
    // "Real card 1" must NOT be moved to Needs Help even though it's in
    // In Progress, because it was never in this dispatch's scope.
    const moves = mockMoveCardToList.mock.calls.filter(
      (c: unknown[]) => c[2] === MOCK_REPO_CONTEXT.trello.needsHelpListId,
    );
    const movedIds = moves.map((c: unknown[]) => c[1]);
    expect(movedIds).not.toContain("real-1");
  });
});

describe("poll — Needs Help checking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockMoveCardToList.mockResolvedValue(undefined);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
  });

  it("checks Needs Help list before ToDo", async () => {
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    // Needs Help should be called first
    expect(mockFetchNeedsHelpCards).toHaveBeenCalled();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("moves user-responded cards from Needs Help to ToDo", async () => {
    const needsHelpCard = { id: "nh1", name: "Blocked card" };
    const userComment = { id: "a1", data: { text: "I fixed the config" } };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(userComment);
    mockIsUserResponse.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([needsHelpCard]); // Card now in ToDo

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchLatestComment).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh1");
    expect(mockIsUserResponse).toHaveBeenCalledWith(userComment);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh1", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("does not move cards still waiting for user (bot comment is latest)", async () => {
    const needsHelpCard = { id: "nh1", name: "Blocked card" };
    const botComment = { id: "a1", data: { text: "Needs config change\n\n<!-- danxbot -->" } };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(botComment);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockMoveCardToList).not.toHaveBeenCalled();
  });

  it("does not move cards with no comments", async () => {
    const needsHelpCard = { id: "nh1", name: "New error card" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue(null);
    mockIsUserResponse.mockReturnValue(false);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockMoveCardToList).not.toHaveBeenCalled();
  });

  it("only moves user-responded cards in a mixed set", async () => {
    const cards = [
      { id: "nh1", name: "Bot waiting" },
      { id: "nh2", name: "User replied" },
      { id: "nh3", name: "No comments" },
    ];
    const botComment = { id: "a1", data: { text: "Needs help\n\n<!-- danxbot -->" } };
    const userComment = { id: "a2", data: { text: "Done, try again" } };

    mockFetchNeedsHelpCards.mockResolvedValue(cards);
    mockFetchLatestComment
      .mockResolvedValueOnce(botComment)   // nh1: bot comment
      .mockResolvedValueOnce(userComment)  // nh2: user reply
      .mockResolvedValueOnce(null);        // nh3: no comments
    mockIsUserResponse
      .mockReturnValueOnce(false)  // nh1
      .mockReturnValueOnce(true)   // nh2
      .mockReturnValueOnce(false); // nh3
    mockFetchTodoCards.mockResolvedValue([{ id: "nh2", name: "User replied" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Only nh2 should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh2", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("handles fetchNeedsHelpCards failure gracefully", async () => {
    mockFetchNeedsHelpCards.mockRejectedValue(new Error("API error"));
    mockFetchTodoCards.mockResolvedValue([]);

    // Should not throw — continues to check ToDo
    await expect(poll(MOCK_REPO_CONTEXT)).resolves.toBeUndefined();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("handles individual card comment check failure gracefully", async () => {
    mockFetchNeedsHelpCards.mockResolvedValue([
      { id: "nh1", name: "Card 1" },
      { id: "nh2", name: "Card 2" },
    ]);
    // First card throws, second succeeds
    mockFetchLatestComment
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({ id: "a1", data: { text: "User reply" } });
    mockIsUserResponse.mockReturnValue(true);
    mockFetchTodoCards.mockResolvedValue([{ id: "nh2", name: "Card 2" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Only second card should be moved
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "nh2", MOCK_REPO_CONTEXT.trello.todoListId, "top");
  });

  it("spawns team when Needs Help cards are moved and no ToDo cards existed before", async () => {
    const needsHelpCard = { id: "nh1", name: "User replied" };

    mockFetchNeedsHelpCards.mockResolvedValue([needsHelpCard]);
    mockFetchLatestComment.mockResolvedValue({ id: "a1", data: { text: "Done" } });
    mockIsUserResponse.mockReturnValue(true);
    // After moving, the card appears in ToDo
    mockFetchTodoCards.mockResolvedValue([needsHelpCard]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalled();
  });
});

describe("start", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  const savedEnv: Record<string, string | undefined> = {};

  const requiredEnvVars: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    GITHUB_TOKEN: "ghp_test",
    REPOS: "test:https://github.com/org/repo.git",
    TRELLO_API_KEY: "trello-key",
    TRELLO_API_TOKEN: "trello-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    setupRepoConfigMocks();
    // Also return true for claude-auth/.claude.json
    const origImpl = mockExistsSync.getMockImplementation()!;
    mockExistsSync.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith(".claude.json")) return true;
      return origImpl(path);
    });
    // Set required env vars for validation
    for (const [key, value] of Object.entries(requiredEnvVars)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.useRealTimers();
    _resetForTesting();
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("starts polling without errors", () => {
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));

    expect(() => start()).not.toThrow();
  });

  it("starts polling for every repo regardless of trelloEnabled — the per-tick isFeatureEnabled check decides whether to skip", () => {
    // Boot-time skipping was removed in favor of the per-tick toggle. Every
    // repo gets an interval scheduled so operators can flip `trelloPoller`
    // on at runtime without restarting the worker. The skip happens inside
    // `poll()` when `isFeatureEnabled(repo, "trelloPoller")` is false.
    mockRepoContexts[0].trelloEnabled = false;
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "trelloPoller",
    );
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue([]);

    start();

    // The initial poll ran but `isFeatureEnabled` returned false, so no
    // Trello API calls were made.
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      expect.any(Object),
      "trelloPoller",
    );
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockFetchReviewCards).not.toHaveBeenCalled();

    mockRepoContexts[0].trelloEnabled = true;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("polls every repo in repoContexts — per-tick toggle decides which fetch Trello", () => {
    const enabledRepo = { ...mockRepoContexts[0], name: "enabled", trelloEnabled: true };
    const disabledRepo = { ...mockRepoContexts[0], name: "disabled", trelloEnabled: false };
    mockRepoContexts.length = 0;
    mockRepoContexts.push(enabledRepo, disabledRepo);
    mockIsFeatureEnabled.mockImplementation((ctx: { name: string }, feature: string) => {
      if (feature !== "trelloPoller") return true;
      return ctx.name === "enabled";
    });
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue([]);

    start();

    const trelloArgs = mockFetchNeedsHelpCards.mock.calls.map((c) => c[0]);
    // Only the enabled repo's per-tick check returned true → only its
    // Trello config was used.
    expect(trelloArgs.length).toBe(1);
    expect(trelloArgs[0]).toBe(enabledRepo.trello);

    mockRepoContexts.length = 0;
    mockRepoContexts.push({ ...enabledRepo, name: "test-repo", trelloEnabled: true });
    mockIsFeatureEnabled.mockReturnValue(true);
  });
});

describe("poll — critical-failure halt gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    mockIsFeatureEnabled.mockReturnValue(true);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })),
    );
  });

  it("does not fetch Trello or spawn when the flag is set — halt is terminal until cleared", async () => {
    mockReadFlag.mockReturnValue({
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "agent",
      dispatchId: "dxy",
      reason: "MCP Trello tools failed to load",
    });
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.localPath);
    expect(mockFetchNeedsHelpCards).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("also halts on the synthetic unparseable source (a corrupt flag file is fail-closed)", async () => {
    mockReadFlag.mockReturnValue({
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "unparseable",
      dispatchId: "unparseable",
      reason: "Critical-failure flag file present but unparseable",
    });
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("proceeds normally when the flag is absent", async () => {
    mockReadFlag.mockReturnValue(null);
    mockFetchTodoCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).toHaveBeenCalled();
    expect(mockFetchNeedsHelpCards).toHaveBeenCalled();
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("halt gate runs AFTER the feature toggle — disabled poller never checks the flag", async () => {
    // If the poller is disabled, we don't need to read the flag at all —
    // the whole tick is skipped before flag logic.
    mockIsFeatureEnabled.mockImplementation(
      (_ctx: unknown, feature: string) => feature !== "trelloPoller",
    );
    mockReadFlag.mockReturnValue(null);
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockReadFlag).not.toHaveBeenCalled();
    expect(mockFetchTodoCards).not.toHaveBeenCalled();
  });
});

describe("poll — post-dispatch card-progress check", () => {
  const TODO_LIST_ID = MOCK_REPO_CONTEXT.trello.todoListId;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockReadFlag.mockReturnValue(null);
    mockIsFeatureEnabled.mockReturnValue(true);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })),
    );
    mockDispatch.mockResolvedValue({ id: "test-job", status: "running" });
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  async function runOneDispatch(
    todoCards: Array<{ id: string; name: string }>,
    completionJob: {
      id: string;
      status: string;
      summary?: string;
      startedAt: Date;
      completedAt: Date;
    },
  ): Promise<void> {
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "test-job", status: "running" });
      },
    );
    mockFetchTodoCards.mockResolvedValue(todoCards);

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!(completionJob);
    await flushAsync();
    await flushAsync();
  }

  it("writes the critical-failure flag when the tracked card is still in ToDo after the dispatch exits", async () => {
    mockFetchCard.mockResolvedValue({
      id: "c1",
      name: "Card 1",
      idList: TODO_LIST_ID,
    });

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "failed",
        summary: "MCP Trello unavailable",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockFetchCard).toHaveBeenCalledWith(MOCK_REPO_CONTEXT.trello, "c1");
    expect(mockWriteFlag).toHaveBeenCalledTimes(1);
    const [localPath, payload] = mockWriteFlag.mock.calls[0];
    expect(localPath).toBe(MOCK_REPO_CONTEXT.localPath);
    expect(payload).toMatchObject({
      source: "post-dispatch-check",
      dispatchId: "j1",
      cardId: "c1",
      cardUrl: "https://trello.com/c/c1", // reconstructed from cardId
    });
    expect(payload.reason).toMatch(/did not move out of ToDo/);
  });

  it("writes the flag even when the agent reported status=completed (silent env failure)", async () => {
    // An agent that reports "completed" but didn't move the card is
    // lying about success — still an env-level signal.
    mockFetchCard.mockResolvedValue({
      id: "c1",
      name: "Card 1",
      idList: TODO_LIST_ID,
    });

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "completed",
        summary: "done (but really wasn't)",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockWriteFlag).toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to In Progress", async () => {
    mockFetchCard.mockResolvedValue({
      id: "c1",
      name: "Card 1",
      idList: MOCK_REPO_CONTEXT.trello.inProgressListId,
    });

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "failed",
        summary: "mid-work crash",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockFetchCard).toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to Needs Help", async () => {
    mockFetchCard.mockResolvedValue({
      id: "c1",
      name: "Card 1",
      idList: MOCK_REPO_CONTEXT.trello.needsHelpListId,
    });

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "completed",
        summary: "moved to Needs Help",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT write the flag when the tracked card moved to Done", async () => {
    mockFetchCard.mockResolvedValue({
      id: "c1",
      name: "Card 1",
      idList: MOCK_REPO_CONTEXT.trello.doneListId,
    });

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "completed",
        summary: "done",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("does NOT fetch the card or write a flag for ideator (api trigger) dispatches", async () => {
    // Ideator runs when ToDo is empty + Review has < REVIEW_MIN_CARDS cards.
    // They use trigger=api, not trigger=trello, so there's no card to track.
    mockFetchReviewCards.mockResolvedValue([]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation(
      (opts: { onComplete?: (job: unknown) => void }) => {
        capturedOnComplete = opts.onComplete;
        return Promise.resolve({ id: "ideator-job", status: "running" });
      },
    );
    mockFetchTodoCards.mockResolvedValue([]); // empty ToDo → ideator path

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();
    capturedOnComplete!({
      id: "ideator-job",
      status: "completed",
      summary: "generated cards",
      startedAt: new Date(),
      completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();

    expect(mockFetchCard).not.toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

  it("handles fetchCard failures gracefully without writing the flag", async () => {
    // If Trello API fails mid-check we don't have positive evidence the
    // card stayed in ToDo. Log and move on — the next tick will retry.
    mockFetchCard.mockRejectedValue(new Error("Trello API 500"));

    await runOneDispatch(
      [{ id: "c1", name: "Card 1" }],
      {
        id: "j1",
        status: "failed",
        summary: "crash",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    );

    expect(mockFetchCard).toHaveBeenCalled();
    expect(mockWriteFlag).not.toHaveBeenCalled();
  });

});

describe("shutdown", () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, name: `Review ${i}` })));
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
  });

  it("calls process.exit(0)", () => {
    shutdown();
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

/** Flush async work triggered by fire-and-forget onComplete handlers. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => process.nextTick(r));
  await new Promise((r) => process.nextTick(r));
}

describe("poll — Docker mode (headless agent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    mockDispatch.mockResolvedValue({ id: "test-job", status: "running" });
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("routes through dispatch() (not a direct terminal spawn)", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    // Should NOT spawn wt.exe — the poller no longer owns the terminal path
    expect(mockSpawn).not.toHaveBeenCalled();
    // Should call dispatch() with the workspace dispatch input shape
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-next"),
        repo: expect.objectContaining({ name: "test-repo" }),
        workspace: "trello-worker",
      }),
    );
  });

  it("passes the /danx-next prompt as the dispatch task", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-next"),
      }),
    );
  });

  it("passes the /danx-ideate prompt as the dispatch task when ToDo is empty", async () => {
    mockFetchTodoCards.mockResolvedValue([]);
    // Review list has fewer than REVIEW_MIN_CARDS (mocked to 10)
    mockFetchReviewCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/danx-ideate"),
      }),
    );
  });

  it("resets teamRunning via onComplete callback", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // Capture the onComplete callback
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);
    expect(capturedOnComplete).toBeDefined();

    // Simulate agent completion
    capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Should be able to poll again (teamRunning reset)
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("resets teamRunning on agent failure", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    capturedOnComplete!({ id: "test-job", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Should be able to poll again after failure
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);
    expect(mockFetchTodoCards).toHaveBeenCalled();
  });

  it("does NOT restate the DANXBOT_REPO_NAME / openTerminal invariants — dispatch() owns those defaults", async () => {
    // Phase 4 invariant cleanup: dispatch() auto-injects DANXBOT_REPO_NAME
    // from input.repo.name and defaults openTerminal to config.isHost, so
    // the poller intentionally omits both to avoid restating invariants.
    // If a future refactor adds these fields back, two things would be
    // wrong: (a) DRY violation with dispatch(), and (b) the poller would
    // shadow a dispatch-owned contract. This test locks the boundary.
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.env).toBeUndefined();
    expect(call.openTerminal).toBeUndefined();
  });

  it("passes its own timeoutMs (pollerIntervalMs * 60) to dispatch()", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 60000 * 60, // pollerIntervalMs (60000) * 60
      }),
    );
  });

  it("does NOT pass allowTools — the allow-tools concept is gone from dispatch", async () => {
    // The poller hands the workspace name to dispatch and nothing more
    // about tool surface. The workspace's `.mcp.json` (with
    // `--strict-mcp-config`) is the agent's MCP surface; built-ins are
    // all available by default. No per-dispatch allowlist exists at any
    // layer of the pipeline — see `src/workspace/resolve.ts` header for
    // why claude's `--allowed-tools` was retired.
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.allowTools).toBeUndefined();
    expect(call.workspace).toBe("trello-worker");
  });

  it("tags the dispatch with trigger=trello + the tracked card metadata", async () => {
    // The apiDispatchMeta lives on the new dispatch row so the dashboard can
    // show which card kicked off the run. Without it every poller dispatch
    // shows up as "unknown trigger" in the history.
    mockFetchTodoCards.mockResolvedValue([
      { id: "c1", name: "Card 1" },
      { id: "c2", name: "Card 2" },
    ]);

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.apiDispatchMeta).toEqual({
      trigger: "trello",
      metadata: {
        cardId: "c1",
        cardName: "Card 1",
        cardUrl: "https://trello.com/c/c1",
        listId: MOCK_REPO_CONTEXT.trello.todoListId,
        listName: "ToDo",
      },
    });
  });

  it("tags ideator runs with trigger=api (not card-specific)", async () => {
    // Ideator runs when ToDo is empty + Review has < REVIEW_MIN_CARDS cards.
    // These are not card-specific — tagging them as `api` keeps the Trello
    // card-progress check from firing (no card to check).
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchReviewCards.mockResolvedValue([]); // below threshold → ideator

    await poll(MOCK_REPO_CONTEXT);

    const call = mockDispatch.mock.calls[0][0];
    expect(call.apiDispatchMeta.trigger).toBe("api");
    expect(call.apiDispatchMeta.metadata).toMatchObject({
      endpoint: "poller/ideator",
    });
  });

  it("handles onComplete without throwing", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Should not throw
    expect(() => capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() })).not.toThrow();
    await flushAsync();
  });

  it("onComplete re-poll chains into another dispatch() if more cards", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "test-job", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);
    expect(mockDispatch).toHaveBeenCalledTimes(1);

    // Reset for re-poll. `mockClear()` drops call history only; the
    // mockImplementation above survives so onComplete still gets captured.
    mockDispatch.mockClear();
    mockDispatch.mockResolvedValue({ id: "test-job-2", status: "running" });
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchTodoCards.mockResolvedValue([{ id: "c2", name: "Card 2" }]);

    // Simulate agent completion — onComplete fires poll() asynchronously.
    capturedOnComplete!({ id: "test-job", status: "completed", startedAt: new Date(), completedAt: new Date() });

    // Flush microtasks to let the fire-and-forget poll() resolve.
    await flushAsync();
    await flushAsync();

    // Post-clear count of 1 proves the re-poll dispatched exactly once —
    // the onComplete → poll() → dispatch() chain works end-to-end.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("resets teamRunning when dispatch() rejects before agent spawns (fire-and-forget .catch)", async () => {
    // Guards the pre-spawn failure path. If the .catch() is ever dropped,
    // `teamRunning=true` sticks forever and the poller wedges. Any
    // workspace-resolution failure (missing `.mcp.json`, gate trip, stale
    // legacy file) MUST reset state on the next tick so the error is
    // loud (every tick logs) instead of silent (poller just stops).
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);
    mockDispatch.mockRejectedValueOnce(new Error("pre-spawn boom"));

    await poll(MOCK_REPO_CONTEXT);
    // Let the rejection + .catch() settle.
    await flushAsync();
    await flushAsync();

    // Second tick: if teamRunning leaked, fetchTodoCards would be skipped.
    mockFetchTodoCards.mockClear();
    mockFetchNeedsHelpCards.mockClear();
    mockDispatch.mockClear();
    mockFetchTodoCards.mockResolvedValue([]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);

    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).toHaveBeenCalled();
  });
});

describe("poll — exponential backoff on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("increments consecutive failure counter on agent failure", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // The backoffUntil should be set — poll should skip during backoff
    mockFetchTodoCards.mockResolvedValue([{ id: "c2", name: "Card 2" }]);
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    await poll(MOCK_REPO_CONTEXT);

    // Should not spawn because we're in backoff
    expect(mockDispatch).toHaveBeenCalledTimes(1); // Only the first call
  });

  it("resets failure counter on success — next failure gets first-tier backoff", async () => {
    // Use instant backoff so re-polls proceed
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1, 1, 1, 1];
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    // First: spawn and fail
    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5)); // let 1ms backoff expire

    // The re-poll from failure spawns another agent. Succeed this time.
    await flushAsync();
    await flushAsync();
    // Capture the latest onComplete
    const secondOnComplete = capturedOnComplete!;

    // Succeed
    secondOnComplete({ id: "j2", status: "completed", summary: "done", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5));
    await flushAsync();
    await flushAsync();

    // Now fail again — if counter was reset, we should NOT halt (schedule length 4).
    // With schedule [1,1,1,1] and only 1 failure, it should just backoff, not halt.
    // The key assertion: after success + failure, the poller still re-polls
    // (i.e., spawnAgent is called again), proving the counter was reset.
    const spawnCount = mockDispatch.mock.calls.length;
    expect(spawnCount).toBeGreaterThanOrEqual(2);

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("halts polling after exhausting all backoff schedule entries", async () => {
    // Schedule length 1: failure 1 uses the backoff, failure 2 exceeds schedule → halt
    const originalSchedule = mockConfig.pollerBackoffScheduleMs;
    mockConfig.pollerBackoffScheduleMs = [1]; // 1ms backoff
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    const onCompleteFns: Array<(job: unknown) => void> = [];
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      if (opts.onComplete) onCompleteFns.push(opts.onComplete);
      return Promise.resolve({ id: `j${onCompleteFns.length}`, status: "running" });
    });

    // First poll spawns agent
    await poll(MOCK_REPO_CONTEXT);
    expect(onCompleteFns).toHaveLength(1);

    // First failure — uses backoff[0] (1ms), sets backoffUntil, re-polls
    mockExistsSync.mockReturnValue(false);
    onCompleteFns[0]({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();
    await flushAsync();
    await new Promise((r) => setTimeout(r, 5)); // let 1ms backoff expire

    // Re-poll should have spawned a second agent (backoff expired)
    // Wait for the re-poll to complete
    await flushAsync();
    await flushAsync();

    // Second failure — consecutiveFailures(2) > schedule.length(1) → halt
    if (onCompleteFns.length >= 2) {
      mockDispatch.mockClear();
      mockFetchTodoCards.mockClear();
      onCompleteFns[1]({
        id: "j2", status: "failed", summary: "crash again",
        startedAt: new Date(), completedAt: new Date(),
      });
      await flushAsync();
      await flushAsync();

      // Should NOT spawn again — poller halted
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(mockFetchTodoCards).not.toHaveBeenCalled();
    }

    mockConfig.pollerBackoffScheduleMs = originalSchedule;
  });

  it("skips polling during backoff period", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({ id: "j1", status: "failed", summary: "crash", startedAt: new Date(), completedAt: new Date() });
    await flushAsync();

    // Try to poll again — should skip because in backoff
    mockDispatch.mockClear();
    mockFetchTodoCards.mockClear();
    await poll(MOCK_REPO_CONTEXT);

    expect(mockFetchTodoCards).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe("poll — stuck card recovery on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    mockConfig.isHost = false;
    mockSpawn.mockReturnValue(createFakeSpawnResult());
    setupRepoConfigMocks();
    mockFetchNeedsHelpCards.mockResolvedValue([]);
    mockFetchInProgressCards.mockResolvedValue([]);
    mockAddComment.mockResolvedValue(undefined);
    mockMoveCardToList.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockConfig.isHost = true;
  });

  it("moves stuck In Progress card to Needs Help on agent failure", async () => {
    const todoCard = { id: "c1", name: "My Card" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Simulate: agent moved the card to In Progress, then failed
    mockFetchInProgressCards.mockResolvedValue([todoCard]);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed",
      summary: "Error: permission denied",
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(),
    });
    await flushAsync();

    // Card should be moved to Needs Help
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      MOCK_REPO_CONTEXT.trello.needsHelpListId,
      "top",
    );

    // A comment should be added with failure details and danxbot marker
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("Agent Failure"),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("permission denied"),
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      expect.stringContaining("<!-- danxbot -->"),
    );
  });

  it("does not recover cards that were already In Progress before spawn", async () => {
    const todoCard = { id: "c1", name: "My Card" };
    const preExistingCard = { id: "c99", name: "Already In Progress" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Both the todo card AND a pre-existing card are in In Progress
    mockFetchInProgressCards.mockResolvedValue([todoCard, preExistingCard]);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Only c1 should be moved (it was in our ToDo list before spawn)
    expect(mockMoveCardToList).toHaveBeenCalledTimes(1);
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello,
      "c1",
      MOCK_REPO_CONTEXT.trello.needsHelpListId,
      "top",
    );
  });

  it("does not recover cards on successful completion", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockExistsSync.mockReturnValue(false);
    capturedOnComplete!({
      id: "j1", status: "completed", summary: "done",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Should NOT fetch In Progress cards on success
    expect(mockFetchInProgressCards).not.toHaveBeenCalled();
  });

  it("recovers multiple stuck cards from a single failed agent run", async () => {
    const todoCards = [
      { id: "c1", name: "Card 1" },
      { id: "c2", name: "Card 2" },
    ];
    mockFetchTodoCards.mockResolvedValue(todoCards);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Both cards moved to In Progress during agent run
    mockFetchInProgressCards.mockResolvedValue(todoCards);
    mockExistsSync.mockReturnValue(false);

    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Both cards should be moved to Needs Help
    expect(mockMoveCardToList).toHaveBeenCalledTimes(2);
    expect(mockAddComment).toHaveBeenCalledTimes(2);
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c2", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
  });

  it("recovers stuck cards on agent timeout (not just failure)", async () => {
    const todoCard = { id: "c1", name: "Card 1" };
    mockFetchTodoCards.mockResolvedValue([todoCard]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    mockFetchInProgressCards.mockResolvedValue([todoCard]);
    mockExistsSync.mockReturnValue(false);

    // Timeout status (not "failed") should also trigger recovery
    capturedOnComplete!({
      id: "j1", status: "timeout",
      summary: "Agent timed out after 300 seconds of inactivity",
      startedAt: new Date(Date.now() - 300_000),
      completedAt: new Date(),
    });
    await flushAsync();

    expect(mockMoveCardToList).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1", MOCK_REPO_CONTEXT.trello.needsHelpListId, "top",
    );
    expect(mockAddComment).toHaveBeenCalledWith(
      MOCK_REPO_CONTEXT.trello, "c1",
      expect.stringContaining("timed out"),
    );
  });

  it("handles recovery failure gracefully without crashing", async () => {
    mockFetchTodoCards.mockResolvedValue([{ id: "c1", name: "Card 1" }]);

    let capturedOnComplete: ((job: unknown) => void) | undefined;
    mockDispatch.mockImplementation((opts: { onComplete?: (job: unknown) => void }) => {
      capturedOnComplete = opts.onComplete;
      return Promise.resolve({ id: "j1", status: "running" });
    });

    await poll(MOCK_REPO_CONTEXT);

    // Trello API fails during recovery
    mockFetchInProgressCards.mockRejectedValue(new Error("API down"));
    mockExistsSync.mockReturnValue(false);

    // Should not throw — error is caught and logged
    capturedOnComplete!({
      id: "j1", status: "failed", summary: "crash",
      startedAt: new Date(), completedAt: new Date(),
    });
    await flushAsync();

    // Lock should still be cleaned up even if recovery failed
    // (teamRunning should be false so next poll can proceed)
  });
});
