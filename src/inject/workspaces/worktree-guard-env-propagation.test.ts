/**
 * DX-660 sweep — every workspace that ships the worktree-guard
 * PreToolUse hook MUST propagate `DANX_AGENT_WORKTREE` to the spawned
 * agent's process env, otherwise the hook silently no-ops on agent-
 * bound dispatches (its own `if (!worktree)` guard in
 * `_shared/hooks/worktree-guard.mjs` treats missing env as
 * "non-agent dispatch, nothing to enforce"). When the env var is
 * missing from the workspace's `.claude/settings.json` env block, the
 * dispatch overlay's `DANX_AGENT_WORKTREE` value computed in
 * `src/dispatch/core.ts:1158` never reaches the agent process — only
 * the MCP servers consumed via `.mcp.json` substitution see it. The
 * hook then no-ops on every dispatch and the worktree boundary
 * disappears.
 *
 * The pre-DX-660 failure mode was `issue-worker` declaring only
 * `DANXBOT_WORKER_PORT` in env. The fix added both `DANX_REPO_ROOT`
 * and `DANX_AGENT_WORKTREE`. This sweep catches a future regression
 * (and any sibling workspace that lands the same bug shape) by
 * pinning the invariant at the source: hook-shipping workspace =
 * env block MUST reference `${DANX_AGENT_WORKTREE}` + `workspace.yml`
 * MUST declare `DANX_AGENT_WORKTREE` as an optional placeholder so
 * workspace-mode dispatches (no agent name on overlay) substitute
 * cleanly to `""` instead of throwing `PlaceholderError`.
 *
 * Companion: `workspace-plugin-enablement.test.ts` pins plugin
 * enablement across all workspaces; this file pins the hook
 * propagation contract across all hook-shipping workspaces.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = resolve(HERE);

function listWorkspaceDirs(): string[] {
  return readdirSync(WORKSPACES_ROOT).filter((name) => {
    const path = resolve(WORKSPACES_ROOT, name);
    return statSync(path).isDirectory();
  });
}

function readSettings(workspace: string): {
  env?: Record<string, string>;
  hooks?: {
    PreToolUse?: Array<{
      hooks?: Array<{ command?: string }>;
    }>;
  };
} {
  const path = resolve(WORKSPACES_ROOT, workspace, ".claude/settings.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readManifest(workspace: string): {
  "required-placeholders"?: string[];
  "optional-placeholders"?: string[];
} {
  const path = resolve(WORKSPACES_ROOT, workspace, "workspace.yml");
  return parseYaml(readFileSync(path, "utf-8"));
}

function shipsWorktreeGuard(workspace: string): boolean {
  const settings = readSettings(workspace);
  const hookGroups = settings.hooks?.PreToolUse ?? [];
  for (const group of hookGroups) {
    for (const hook of group.hooks ?? []) {
      if ((hook.command ?? "").includes("worktree-guard.mjs")) return true;
    }
  }
  return false;
}

describe("DX-660 — worktree-guard env propagation sweep", () => {
  const workspaces = listWorkspaceDirs();
  const hookWorkspaces = workspaces.filter(shipsWorktreeGuard);

  it("at least one workspace ships the worktree-guard hook (sanity anchor)", () => {
    expect(hookWorkspaces.length).toBeGreaterThan(0);
  });

  it.each(hookWorkspaces)(
    "workspace `%s` env block references ${DANX_AGENT_WORKTREE} (hook needs it in agent process env)",
    (workspace) => {
      const settings = readSettings(workspace);
      expect(settings.env).toBeDefined();
      expect(settings.env?.DANX_AGENT_WORKTREE).toBe(
        "${DANX_AGENT_WORKTREE}",
      );
    },
  );

  it.each(hookWorkspaces)(
    "workspace `%s` workspace.yml declares DANX_AGENT_WORKTREE as optional placeholder (workspace-mode dispatches substitute to empty string)",
    (workspace) => {
      const manifest = readManifest(workspace);
      const optional = manifest["optional-placeholders"] ?? [];
      expect(optional).toContain("DANX_AGENT_WORKTREE");
    },
  );
});
