/**
 * Regression tests for the issue-worker workspace SOURCE — i.e. what
 * `injectDanxWorkspaces` mirrors into every connected repo's
 * `<repo>/.danxbot/workspaces/issue-worker/`. The dispatched agent's cwd
 * is the target of that mirror, so pinning the source IS pinning the
 * runtime shape.
 *
 * Two eras of invariants live here:
 *
 *   1. **Phase 4 of the tracker-agnostic-agents epic** — workspace's
 *      `.mcp.json` MUST NOT declare a `trello` MCP server, MUST keep
 *      `playwright` + `danx-issue`, and `workspace.yml` MUST pin the
 *      placeholder contract `danx-issue` reads at dispatch time
 *      (`DANX_REPO_ROOT` only — DX-203 retired tracker creds).
 *
 *   2. **Phase 3 of DX-269 (DX-272) — plugin consolidation cutover.**
 *      Every retired inject file MUST be absent from this workspace's
 *      `.claude/{rules,skills}/`. The 1:1 plugin equivalents under
 *      `~/.claude/plugins/marketplaces/newms-plugins/danxbot/` are the
 *      sole loader path for the migrated guidance. Pinning the absence
 *      here catches a regression that resurrects the inject duplicate
 *      before it propagates through `mirrorWorkspaceTree`.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { resolveWorkspace } from "../../../workspace/resolve.js";
import { makeRepoContext } from "../../../__tests__/helpers/fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("issue-worker workspace shape (Phase 4 invariants)", () => {
  it(".mcp.json has no `trello` server entry and keeps `playwright` + `danx-issue`", () => {
    const path = resolve(HERE, ".mcp.json");
    const content = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(content.mcpServers).toBeDefined();
    expect(Object.keys(content.mcpServers)).not.toContain("trello");
    expect(Object.keys(content.mcpServers)).toContain("playwright");
    expect(Object.keys(content.mcpServers)).toContain("danx-issue");
  });

  it(".mcp.json does NOT reference the legacy TRELLO_BOARD_ID env placeholder", () => {
    const path = resolve(HERE, ".mcp.json");
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toMatch(/TRELLO_BOARD_ID/);
  });

  // DX-203: the `danx-issue` MCP server reads ONLY `DANX_REPO_ROOT` —
  // the previous `DANX_TRACKER` / `TRELLO_API_KEY` / `TRELLO_API_TOKEN`
  // triple was retired when the server became purely a YAML manipulator.
  // Pin the exact required + optional sets so a future agent can't
  // silently re-introduce tracker creds (which would re-introduce the
  // "Trello in the agent's critical path" anti-pattern).
  it("workspace.yml required-placeholders + optional-placeholders match the resolver's contract", () => {
    const path = resolve(HERE, "workspace.yml");
    const manifest = parseYaml(readFileSync(path, "utf-8")) as {
      "required-placeholders"?: string[];
      "optional-placeholders"?: string[];
    };
    const required = manifest["required-placeholders"] ?? [];
    const optional = manifest["optional-placeholders"] ?? [];
    expect([...required].sort()).toEqual(
      ["DANXBOT_STOP_URL", "DANXBOT_WORKER_PORT", "DANX_REPO_ROOT"].sort(),
    );
    // DX-660: `DANX_AGENT_WORKTREE` is optional — only the dispatch
    // core's agent-bound path sets it on the overlay (multi-worker
    // dispatches like `phil`). Workspace-mode dispatches like
    // `/api/flesh-out` or `/api/launch` leave it unset and the
    // resolver substitutes the placeholder to `""`. Declaring it as
    // optional is what lets the env block reference `${DANX_AGENT_WORKTREE}`
    // without throwing `PlaceholderError` on workspace-mode dispatches.
    expect(optional).toEqual(["DANX_AGENT_WORKTREE"]);
  });

  // DX-660: the agent's process env is built from
  // `.claude/settings.json`'s `env` block (post-overlay substitution)
  // — see `src/workspace/resolve.ts#resolveEnv` →
  // `src/dispatch/core.ts` `env` build at the spawnAgent call site.
  // `DANX_REPO_ROOT` and `DANX_AGENT_WORKTREE` MUST be declared here
  // so they propagate to the spawned claude process AND the
  // PreToolUse worktree-guard hook (which reads
  // `process.env.DANX_AGENT_WORKTREE` to gate write paths). Without
  // these entries, the hook silently no-ops on agent-bound dispatches
  // (boundary disappears) and the agent's bash shell sees both vars
  // empty (forcing fallback to absolute paths that bypass the
  // workspace's `<worktree>`-relative skill body conventions).
  it(".claude/settings.json env block declares DANX_REPO_ROOT + DANX_AGENT_WORKTREE + DANXBOT_WORKER_PORT (DX-660)", () => {
    const path = resolve(HERE, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(path, "utf-8")) as {
      env?: Record<string, string>;
    };
    expect(settings.env).toBeDefined();
    expect(settings.env?.DANX_REPO_ROOT).toBe("${DANX_REPO_ROOT}");
    expect(settings.env?.DANX_AGENT_WORKTREE).toBe("${DANX_AGENT_WORKTREE}");
    expect(settings.env?.DANXBOT_WORKER_PORT).toBe("${DANXBOT_WORKER_PORT}");
  });

  // DX-203: the `danx-issue` MCP server's env contract shrank to exactly
  // `DANX_REPO_ROOT`. Missing it crashes the server at boot; any extra
  // key (`DANX_TRACKER`, `TRELLO_API_KEY`, `TRELLO_API_TOKEN`) is
  // forbidden — the server reads no tracker creds. Pin the shape so a
  // regression that re-adds tracker creds trips loud.
  it("`.mcp.json` `danx-issue` server declares ONLY DANX_REPO_ROOT", () => {
    const path = resolve(HERE, ".mcp.json");
    const content = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    const danxIssue = content.mcpServers["danx-issue"];
    expect(danxIssue).toBeDefined();
    expect(danxIssue.command).toBe("npx");
    expect(danxIssue.args).toEqual(["-y", "@thehammer/danx-issue-mcp"]);
    expect(Object.keys(danxIssue.env ?? {})).toEqual(["DANX_REPO_ROOT"]);
    // Each value must be a placeholder reference — concrete values would
    // bake host paths or secrets into the committed file.
    for (const value of Object.values(danxIssue.env ?? {})) {
      expect(value).toMatch(/^\$\{[A-Z_]+\}$/);
    }
  });
});

// DX-660: end-to-end integration — copy the actual issue-worker source
// into a temp repo, run `resolveWorkspace` against it, and assert the
// env block the dispatch core feeds to `spawnAgent` carries
// `DANX_REPO_ROOT` and `DANX_AGENT_WORKTREE` after overlay substitution.
// Pairs with the static-content sweep above: the sweep pins what's on
// disk; this integration test pins what reaches the spawned process
// after the resolver runs. The pre-fix bug surface was "settings.json
// declared only DANXBOT_WORKER_PORT, so the agent's bash + the
// PreToolUse worktree-guard hook saw both vars empty" — without this
// integration test, a partial fix that bumps the static contract but
// regresses the resolver substitution path would slip past the sweep.
describe("issue-worker workspace env propagation (DX-660 integration)", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupRepoWithIssueWorkerSource(): {
    repoDir: string;
  } {
    const repoDir = mkdtempSync(resolve(tmpdir(), "danxbot-dx660-"));
    cleanupDirs.push(repoDir);
    const workspaceDir = resolve(
      repoDir,
      ".danxbot",
      "workspaces",
      "issue-worker",
    );
    mkdirSync(resolve(repoDir, ".danxbot", "workspaces"), { recursive: true });
    cpSync(HERE, workspaceDir, { recursive: true });
    return { repoDir };
  }

  function baseOverlay(workerPort: number): Record<string, string> {
    return {
      DANXBOT_STOP_URL: `http://localhost:${workerPort}/api/stop/test`,
      DANXBOT_WORKER_PORT: String(workerPort),
      DANX_REPO_ROOT: "/test/repo/root",
      // Auto-injected by `src/dispatch/core.ts` for every real
      // dispatch — referenced by the workspace's `staging-paths`.
      DANXBOT_DISPATCH_ID: "test-dispatch-id",
    };
  }

  it("agent-bound dispatch (overlay sets DANX_AGENT_WORKTREE) → resolver propagates both vars to the env block", () => {
    const { repoDir } = setupRepoWithIssueWorkerSource();
    const repo = makeRepoContext({ localPath: repoDir });
    const result = resolveWorkspace({
      repo,
      workspaceName: "issue-worker",
      overlay: {
        ...baseOverlay(repo.workerPort),
        DANX_REPO_ROOT: "/agents/phil/worktree",
        DANX_AGENT_WORKTREE: "/agents/phil/worktree",
      },
    });
    cleanupDirs.push(resolve(result.mcpSettingsPath, ".."));
    cleanupDirs.push(resolve(result.settingsPath, ".."));
    expect(result.env.DANX_REPO_ROOT).toBe("/agents/phil/worktree");
    expect(result.env.DANX_AGENT_WORKTREE).toBe("/agents/phil/worktree");
    expect(result.env.DANXBOT_WORKER_PORT).toBe(String(repo.workerPort));
  });

  it("workspace-mode dispatch (overlay omits DANX_AGENT_WORKTREE) → substitutes to empty string (hook no-ops, bash sees `\"\"`)", () => {
    const { repoDir } = setupRepoWithIssueWorkerSource();
    const repo = makeRepoContext({ localPath: repoDir });
    const result = resolveWorkspace({
      repo,
      workspaceName: "issue-worker",
      overlay: baseOverlay(repo.workerPort),
    });
    cleanupDirs.push(resolve(result.mcpSettingsPath, ".."));
    cleanupDirs.push(resolve(result.settingsPath, ".."));
    expect(result.env.DANX_REPO_ROOT).toBe("/test/repo/root");
    // Optional placeholder substitutes to empty string when overlay
    // omits it. This is the documented contract — see
    // `src/workspace/placeholders.ts` "Required vs optional placeholders".
    expect(result.env.DANX_AGENT_WORKTREE).toBe("");
  });
});

describe("issue-worker workspace shape (DX-272 plugin-consolidation invariants)", () => {
  // DX-272 retired 6 rules + 6 skills from the inject pipeline; the
  // 1:1 plugin equivalents under
  // `~/.claude/plugins/marketplaces/newms-plugins/danxbot/` are now
  // the sole loader path. Pin the absence at the inject SOURCE — a
  // regression that resurrects any of these files would propagate to
  // every connected repo's workspace via `mirrorWorkspaceTree` before
  // the sibling unit tests on the prune helpers caught it.
  //
  // `statSync(...).toBeUndefined()` is the strict "missing only" anchor.
  // The inject mirror does not create empty subdirs, so accepting "empty
  // dir" as a pass would let a `mkdir -p` + `.gitkeep` regression slip.

  const RETIRED_RULE_BASENAMES = [
    "danx-comment-style.md",
    "danx-halt-flag.md",
    "danx-no-launch-worker.md",
    "danx-no-false-blockers.md",
    "danx-no-interactive.md",
    "danx-requires-human.md",
  ] as const;

  const RETIRED_SKILL_DIR_BASENAMES = [
    "danx-epic-link",
    "danx-ideate",
    "danx-next",
    "danx-start",
    "danx-triage-card",
    "issue-blocker",
  ] as const;

  it.each(RETIRED_RULE_BASENAMES)(
    "retired inject rule `%s` is absent from .claude/rules/",
    (name) => {
      const path = resolve(HERE, ".claude/rules", name);
      expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
    },
  );

  it.each(RETIRED_SKILL_DIR_BASENAMES)(
    "retired inject skill dir `%s` is absent from .claude/skills/",
    (name) => {
      const path = resolve(HERE, ".claude/skills", name);
      expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
    },
  );

  // Phase 5 of ISS-90 (ISS-95): the legacy `danx-triage` redirect skill
  // was deleted entirely. Kept as a separate anchor so the historical
  // regression target (bulk-orchestrator resurrection) stays visible
  // even though DX-272's retire list now covers it too.
  it("the legacy `danx-triage` skill no longer ships in this workspace", () => {
    const path = resolve(HERE, ".claude/skills/danx-triage");
    expect(statSync(path, { throwIfNoEntry: false })).toBeUndefined();
  });
});
