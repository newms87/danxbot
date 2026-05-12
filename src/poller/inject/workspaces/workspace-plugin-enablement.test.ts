/**
 * DX-273 AC 5: every per-workspace `.claude/settings.json` MUST declare
 * `enabledPlugins["danxbot@newms-plugins"]: true`. Without the
 * enablement the dispatched agent inside that workspace cannot load
 * the migrated plugin skills (`danxbot:issue-card-workflow`,
 * `danxbot:halt-flag`, `danxbot:no-false-blockers`,
 * `danxbot:requires-human`, `danxbot:slack-agent`, etc.) — the same
 * surface DX-272 retired from the inject pipeline.
 *
 * The test walks every workspace under `src/poller/inject/workspaces/`,
 * fails loud on:
 *   - a workspace dir missing `.claude/settings.json` (pre-DX-273
 *     board-chat shape — the file is now mandatory),
 *   - `enabledPlugins` missing entirely,
 *   - `enabledPlugins["danxbot@newms-plugins"]` not literally `true`
 *     (false / null / absent are all violations — `null` defers to
 *     parent enablement which the dispatched agent doesn't have).
 *
 * Pinning at the inject SOURCE is sufficient because
 * `mirrorWorkspaceTree` mirrors the file verbatim into every connected
 * repo's workspace target dir.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = resolve(HERE);

const PLUGIN_KEY = "danxbot@newms-plugins";

function listWorkspaceDirs(): string[] {
  return readdirSync(WORKSPACES_ROOT).filter((name) => {
    const path = resolve(WORKSPACES_ROOT, name);
    return statSync(path).isDirectory();
  });
}

describe("workspace plugin enablement (DX-273 AC 5)", () => {
  const workspaces = listWorkspaceDirs();

  it("at least one workspace exists under inject/workspaces/", () => {
    // Sanity anchor — a future refactor that moves the workspaces tree
    // would otherwise pass every `it.each` with zero iterations.
    expect(workspaces.length).toBeGreaterThan(0);
  });

  it.each(workspaces)(
    "workspace `%s` ships a .claude/settings.json",
    (workspace) => {
      const path = resolve(
        WORKSPACES_ROOT,
        workspace,
        ".claude/settings.json",
      );
      expect(statSync(path, { throwIfNoEntry: false })).toBeDefined();
    },
  );

  it.each(workspaces)(
    "workspace `%s` declares enabledPlugins[danxbot@newms-plugins]: true",
    (workspace) => {
      const path = resolve(
        WORKSPACES_ROOT,
        workspace,
        ".claude/settings.json",
      );
      const settings = JSON.parse(readFileSync(path, "utf-8")) as {
        enabledPlugins?: Record<string, unknown>;
      };
      expect(settings.enabledPlugins).toBeDefined();
      expect(settings.enabledPlugins?.[PLUGIN_KEY]).toBe(true);
    },
  );
});
