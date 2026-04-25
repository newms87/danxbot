import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import {
  resolveWorkspace,
  cleanupWorkspaceMcpSettings,
  WorkspaceNotFoundError,
  WorkspaceFileMissingError,
  WorkspaceSettingsError,
  WorkspaceGateError,
  WorkspaceGateUnknownError,
  WorkspaceLegacyFileError,
} from "./resolve.js";
import { PlaceholderError } from "./placeholders.js";
import { WorkspaceManifestError } from "./manifest.js";
import { writeFlag, clearFlag } from "../critical-failure.js";
import type { RepoContext } from "../types.js";

const FIXTURE_ROOT = resolve(
  __dirname,
  "__fixtures__",
  "test-workspace",
);

function setupRepoWithFixture(): {
  repo: RepoContext;
  repoDir: string;
  workspaceDir: string;
} {
  const repoDir = mkdtempSync(resolve(tmpdir(), "danxbot-resolve-test-"));
  const workspaceDir = resolve(
    repoDir,
    ".danxbot",
    "workspaces",
    "test-workspace",
  );
  mkdirSync(resolve(repoDir, ".danxbot", "workspaces"), { recursive: true });
  cpSync(FIXTURE_ROOT, workspaceDir, { recursive: true });
  const repo = makeRepoContext({
    localPath: repoDir,
    name: "test-repo",
    trelloEnabled: true,
  });
  return { repo, repoDir, workspaceDir };
}

function goodOverlay(): Record<string, string> {
  return {
    DANXBOT_STOP_URL: "http://localhost:5562/api/stop/job-1",
    DANXBOT_WORKER_PORT: "5562",
    TEST_API_KEY: "secret-key",
    TEST_OPTIONAL_FLAG: "on",
  };
}

describe("resolveWorkspace", () => {
  let repoDir: string;
  let repo: RepoContext;
  let mcpDirsToClean: string[];

  beforeEach(() => {
    const setup = setupRepoWithFixture();
    repo = setup.repo;
    repoDir = setup.repoDir;
    mcpDirsToClean = [];
  });

  afterEach(() => {
    for (const dir of mcpDirsToClean) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  function capture(result: ReturnType<typeof resolveWorkspace>) {
    mcpDirsToClean.push(resolve(result.mcpSettingsPath, ".."));
    return result;
  }

  describe("happy path", () => {
    it("returns cwd pointing at the workspace dir", () => {
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      expect(result.cwd).toBe(
        resolve(repoDir, ".danxbot", "workspaces", "test-workspace"),
      );
    });

    it("returns promptDelivery = 'at-file'", () => {
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      expect(result.promptDelivery).toBe("at-file");
    });

    it("substitutes placeholders into .mcp.json at mcpSettingsPath", () => {
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      const written = JSON.parse(
        readFileSync(result.mcpSettingsPath, "utf-8"),
      );
      expect(written.mcpServers.test.env.TEST_API_KEY).toBe("secret-key");
      expect(written.mcpServers.test.env.DANXBOT_STOP_URL).toBe(
        "http://localhost:5562/api/stop/job-1",
      );
    });

    it("materializes mcpSettingsPath inside a fresh temp dir via mkdtempSync", () => {
      const result1 = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      const result2 = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      expect(result1.mcpSettingsPath).not.toBe(result2.mcpSettingsPath);
      expect(existsSync(result1.mcpSettingsPath)).toBe(true);
      expect(existsSync(result2.mcpSettingsPath)).toBe(true);
      expect(result1.mcpSettingsPath.startsWith(tmpdir())).toBe(true);
    });

    it("substitutes placeholders into env from .claude/settings.json", () => {
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      );
      expect(result.env.DANXBOT_WORKER_PORT).toBe("5562");
      expect(result.env.TEST_OPTIONAL_FLAG).toBe("on");
    });

    it("returns empty env when .claude/settings.json has no env key", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({}),
      );
      const overlay = goodOverlay();
      delete overlay.TEST_OPTIONAL_FLAG;
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay,
        }),
      );
      expect(result.env).toEqual({});
    });

    it("returns empty env when .claude/settings.json env is {}", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({ env: {} }),
      );
      const overlay = goodOverlay();
      delete overlay.TEST_OPTIONAL_FLAG;
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay,
        }),
      );
      expect(result.env).toEqual({});
    });

    it("substitutes an absent optional placeholder to empty string", () => {
      // TEST_OPTIONAL_FLAG is declared optional in the fixture manifest;
      // omitting it from overlay must NOT throw — the resolver defaults
      // optional placeholders to "" before substitution.
      const overlay = goodOverlay();
      delete overlay.TEST_OPTIONAL_FLAG;
      const result = capture(
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay,
        }),
      );
      expect(result.env.TEST_OPTIONAL_FLAG).toBe("");
    });

  });

  describe("missing workspace", () => {
    it("throws WorkspaceNotFoundError when the workspace dir is absent", () => {
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "does-not-exist",
          overlay: {},
        }),
      ).toThrow(WorkspaceNotFoundError);
    });

    it("includes the workspace name in the error message", () => {
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "does-not-exist",
          overlay: {},
        }),
      ).toThrow(/does-not-exist/);
    });
  });

  describe("gate validation", () => {
    it("throws WorkspaceGateError when repo.trelloEnabled = true gate fails", () => {
      const disabledRepo = makeRepoContext({
        localPath: repoDir,
        trelloEnabled: false,
      });
      expect(() =>
        resolveWorkspace({
          repo: disabledRepo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceGateError);
    });

    it("includes the failing gate description in the error message", () => {
      const disabledRepo = makeRepoContext({
        localPath: repoDir,
        trelloEnabled: false,
      });
      expect(() =>
        resolveWorkspace({
          repo: disabledRepo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(/repo\.trelloEnabled = true/);
    });

    it("throws when the 'no CRITICAL_FAILURE flag' gate trips", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "no CRITICAL_FAILURE flag"
`,
      );
      writeFlag(repoDir, {
        source: "agent",
        dispatchId: "x",
        reason: "test halt",
      });
      try {
        expect(() =>
          resolveWorkspace({
            repo,
            workspaceName: "test-workspace",
            overlay: {},
          }),
        ).toThrow(/CRITICAL_FAILURE/);
      } finally {
        clearFlag(repoDir);
      }
    });

    it("passes when the 'no CRITICAL_FAILURE flag' gate holds", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "no CRITICAL_FAILURE flag"
`,
      );
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".mcp.json",
        ),
        JSON.stringify({ mcpServers: {} }),
      );
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({ env: {} }),
      );
      expect(() =>
        capture(
          resolveWorkspace({
            repo,
            workspaceName: "test-workspace",
            overlay: {},
          }),
        ),
      ).not.toThrow();
    });

    it("passes the 'settings.slack.enabled ≠ false' gate when slack is enabled (env default true, no override)", () => {
      // The slack-worker workspace (shipped in P4) gates on this string.
      // Default `makeRepoContext` has `slack.enabled = true`; with no
      // `<repo>/.danxbot/settings.json` present, `isFeatureEnabled` uses
      // the env default (true) and the gate passes.
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "settings.slack.enabled ≠ false"
`,
      );
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".mcp.json",
        ),
        JSON.stringify({ mcpServers: {} }),
      );
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({ env: {} }),
      );
      expect(() =>
        capture(
          resolveWorkspace({
            repo,
            workspaceName: "test-workspace",
            overlay: {},
          }),
        ),
      ).not.toThrow();
    });

    it("fails the 'settings.slack.enabled ≠ false' gate when operator flipped overrides.slack.enabled to false", () => {
      // Three-valued settings toggle: overrides.slack.enabled === false
      // is the explicit "off" state. Any dispatch that requires slack must
      // refuse to resolve; the poller-halt contract exists for env-level
      // failures but operator overrides are gated at the workspace entry.
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "settings.slack.enabled ≠ false"
`,
      );
      writeFileSync(
        resolve(repoDir, ".danxbot", "settings.json"),
        JSON.stringify({
          overrides: {
            slack: { enabled: false },
            trelloPoller: { enabled: null },
            dispatchApi: { enabled: null },
          },
          display: {},
          meta: { updatedAt: "2026-04-24T00:00:00Z", updatedBy: "setup" },
        }),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(WorkspaceGateError);
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(/settings\.slack\.enabled/);
    });

    it("throws WorkspaceGateUnknownError for an unregistered gate string", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "some.invented.gate = never"
`,
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(WorkspaceGateUnknownError);
    });
  });

  describe("overlay validation", () => {
    it("throws PlaceholderError when a required placeholder is missing from overlay", () => {
      const partial = goodOverlay();
      delete partial.TEST_API_KEY;
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: partial,
        }),
      ).toThrow(PlaceholderError);
    });
  });

  describe("malformed manifest", () => {
    it("throws WorkspaceManifestError on a bad workspace.yml", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: x
description: "unterminated
`,
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(WorkspaceManifestError);
    });
  });

  describe("malformed .mcp.json", () => {
    it("throws SyntaxError at resolve time (not spawn time) when .mcp.json is not valid JSON", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".mcp.json",
        ),
        "{not json",
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(SyntaxError);
    });

    it("surfaces PlaceholderError when .mcp.json references an overlay key not supplied and not declared optional", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".mcp.json",
        ),
        JSON.stringify({
          mcpServers: {
            test: { env: { EXTRA: "${UNDECLARED_KEY}" } },
          },
        }),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(PlaceholderError);
    });
  });

  describe("missing required workspace files", () => {
    it("throws WorkspaceFileMissingError when workspace.yml is absent", () => {
      rmSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceFileMissingError);
    });

    it("throws WorkspaceFileMissingError when .mcp.json is absent", () => {
      rmSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".mcp.json",
        ),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceFileMissingError);
    });

    it("throws WorkspaceFileMissingError when .claude/settings.json is absent", () => {
      rmSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceFileMissingError);
    });
  });

  describe("legacy allowed-tools.txt rejection", () => {
    it("throws WorkspaceLegacyFileError when a workspace dir contains an allowed-tools.txt file", () => {
      // The allow-tools concept was retired entirely (this card). A stale
      // `allowed-tools.txt` left in a workspace dir MUST fail loudly so an
      // operator notices the migration miss instead of silently losing the
      // (already-broken) gate. No legacy / no backwards compat — the file
      // either doesn't exist or the resolve fails.
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "allowed-tools.txt",
        ),
        "Read\n",
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceLegacyFileError);
    });

    it("includes the workspace path AND the offending filename in the WorkspaceLegacyFileError message so the operator can find and delete it", () => {
      const workspaceDir = resolve(
        repoDir,
        ".danxbot",
        "workspaces",
        "test-workspace",
      );
      writeFileSync(resolve(workspaceDir, "allowed-tools.txt"), "");
      // Run once and inspect the actual message — asserts BOTH the
      // workspace dir path AND the legacy file name appear, which is
      // what an operator needs to fix the failure without running grep.
      let caught: unknown;
      try {
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkspaceLegacyFileError);
      const message = (caught as Error).message;
      expect(message).toContain(workspaceDir);
      expect(message).toContain("allowed-tools.txt");
    });
  });

  describe("malformed .claude/settings.json", () => {
    it("throws WorkspaceSettingsError when env contains a non-string value", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({ env: { X: 42 } }),
      );
      const overlay = goodOverlay();
      delete overlay.TEST_OPTIONAL_FLAG;
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay,
        }),
      ).toThrow(WorkspaceSettingsError);
    });

    it("throws WorkspaceSettingsError when env is an array", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          ".claude",
          "settings.json",
        ),
        JSON.stringify({ env: ["X"] }),
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: goodOverlay(),
        }),
      ).toThrow(WorkspaceSettingsError);
    });
  });

  describe("evaluation order", () => {
    it("runs gates before overlay validation (gate failure reported, not missing-placeholder)", () => {
      const disabledRepo = makeRepoContext({
        localPath: repoDir,
        trelloEnabled: false,
      });
      // overlay is empty — would trigger PlaceholderError if overlay was
      // validated first. Gates must run first so the operator sees
      // "trello disabled" not "missing TRELLO_API_KEY".
      expect(() =>
        resolveWorkspace({
          repo: disabledRepo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(WorkspaceGateError);
      expect(() =>
        resolveWorkspace({
          repo: disabledRepo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).not.toThrow(PlaceholderError);
    });
  });

  describe("gate registry exact-string match", () => {
    it("treats whitespace variants as unknown gates (byte-for-byte match)", () => {
      writeFileSync(
        resolve(
          repoDir,
          ".danxbot",
          "workspaces",
          "test-workspace",
          "workspace.yml",
        ),
        `name: test-workspace
description: test
required-placeholders: []
required-gates:
  - "repo.trelloEnabled=true"
`,
      );
      expect(() =>
        resolveWorkspace({
          repo,
          workspaceName: "test-workspace",
          overlay: {},
        }),
      ).toThrow(WorkspaceGateUnknownError);
    });
  });
});

describe("cleanupWorkspaceMcpSettings", () => {
  it("removes the temp dir that wraps the mcpSettingsPath", () => {
    const repoDir = mkdtempSync(resolve(tmpdir(), "danxbot-cleanup-"));
    const workspaceDir = resolve(
      repoDir,
      ".danxbot",
      "workspaces",
      "test-workspace",
    );
    mkdirSync(resolve(repoDir, ".danxbot", "workspaces"), {
      recursive: true,
    });
    cpSync(FIXTURE_ROOT, workspaceDir, { recursive: true });
    const repo = makeRepoContext({ localPath: repoDir, trelloEnabled: true });
    const result = resolveWorkspace({
      repo,
      workspaceName: "test-workspace",
      overlay: {
        DANXBOT_STOP_URL: "http://localhost:5562/api/stop/x",
        DANXBOT_WORKER_PORT: "5562",
        TEST_API_KEY: "k",
        TEST_OPTIONAL_FLAG: "f",
      },
    });
    const dir = resolve(result.mcpSettingsPath, "..");
    expect(existsSync(dir)).toBe(true);
    cleanupWorkspaceMcpSettings(result.mcpSettingsPath);
    expect(existsSync(dir)).toBe(false);
    // Idempotent — second call does not throw.
    expect(() => cleanupWorkspaceMcpSettings(result.mcpSettingsPath)).not.toThrow();
    rmSync(repoDir, { recursive: true, force: true });
  });
});
