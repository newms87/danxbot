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
import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
    expect(optional).toEqual([]);
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
