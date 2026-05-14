/**
 * Regression tests for the `issue-chat` workspace SOURCE (DX-348
 * Phase 3 / DX-351). `injectDanxWorkspaces` mirrors this directory
 * verbatim into every connected repo's
 * `<repo>/.danxbot/workspaces/issue-chat/`, so pinning the source IS
 * pinning the runtime shape.
 *
 * Invariants:
 *   1. `.mcp.json` declares ONLY the `danx-issue` MCP server (chat is
 *      conversation + targeted YAML edits — no playwright, no trello,
 *      no schema). DX-203's "danx-issue reads only `DANX_REPO_ROOT`"
 *      contract applies here too.
 *   2. `workspace.yml` required-placeholders pin the resolver contract
 *      so a regression that drops a required env doesn't surface as a
 *      mid-dispatch crash.
 *   3. `.claude/settings.json` enables BOTH `base@newms-plugins` and
 *      `danxbot@newms-plugins` (the latter ships the auto-loaded
 *      `danxbot:danx-chat` skill). The PreToolUse worktree-guard hook
 *      gates every Edit/Write/Bash so a chat agent that ignores the
 *      "edit only THIS card's YAML" boundary trips loud.
 *   4. `CLAUDE.md` references the plugin skill by its fully-qualified
 *      name (`danxbot:danx-chat`) — a regression that renames the skill
 *      would surface in this file's grep result.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("issue-chat workspace shape (DX-351)", () => {
  it(".mcp.json declares ONLY the `danx-issue` MCP server", () => {
    const path = resolve(HERE, ".mcp.json");
    const content = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(content.mcpServers).toBeDefined();
    expect(Object.keys(content.mcpServers)).toEqual(["danx-issue"]);
  });

  it(".mcp.json `danx-issue` server declares ONLY DANX_REPO_ROOT (DX-203 contract)", () => {
    const path = resolve(HERE, ".mcp.json");
    const content = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    const danxIssue = content.mcpServers["danx-issue"];
    expect(danxIssue.command).toBe("npx");
    expect(danxIssue.args).toEqual(["-y", "@thehammer/danx-issue-mcp"]);
    expect(Object.keys(danxIssue.env ?? {})).toEqual(["DANX_REPO_ROOT"]);
    for (const value of Object.values(danxIssue.env ?? {})) {
      expect(value).toMatch(/^\$\{[A-Z_]+\}$/);
    }
  });

  it(".mcp.json does NOT reference legacy tracker / schema placeholders", () => {
    const raw = readFileSync(resolve(HERE, ".mcp.json"), "utf-8");
    expect(raw).not.toMatch(/TRELLO_BOARD_ID/);
    expect(raw).not.toMatch(/TRELLO_API_KEY/);
    expect(raw).not.toMatch(/SCHEMA_DEFINITION_ID/);
  });

  it("workspace.yml required-placeholders match the resolver contract", () => {
    const path = resolve(HERE, "workspace.yml");
    const manifest = parseYaml(readFileSync(path, "utf-8")) as {
      "required-placeholders"?: string[];
      "optional-placeholders"?: string[];
    };
    const required = manifest["required-placeholders"] ?? [];
    const optional = manifest["optional-placeholders"] ?? [];
    // Chat dispatches don't need DANXBOT_WORKER_PORT — the worker
    // injects the per-dispatch URLs (`DANXBOT_STOP_URL`) from the
    // dispatch core. Mirrors the board-chat workspace's slimmer set.
    expect([...required].sort()).toEqual(
      ["DANXBOT_STOP_URL", "DANX_REPO_ROOT"].sort(),
    );
    expect(optional).toEqual([]);
  });

  it(".claude/settings.json enables base + danxbot plugins (DX-273 AC 5)", () => {
    const path = resolve(HERE, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(path, "utf-8")) as {
      enabledPlugins?: Record<string, unknown>;
    };
    expect(settings.enabledPlugins).toBeDefined();
    expect(settings.enabledPlugins?.["danxbot@newms-plugins"]).toBe(true);
    expect(settings.enabledPlugins?.["base@newms-plugins"]).toBe(true);
  });

  it(".claude/settings.json wires the worktree-guard PreToolUse hook on every mutating tool", () => {
    const path = resolve(HERE, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(path, "utf-8")) as {
      hooks?: {
        PreToolUse?: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string }>;
        }>;
      };
    };
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    expect(preToolUse.length).toBeGreaterThan(0);
    const guard = preToolUse[0];
    // The matcher MUST include Edit/Write/MultiEdit/NotebookEdit/Bash —
    // chat agents can fall back to Bash for `git log`-style probes and
    // we want every mutation gated.
    expect(guard.matcher).toMatch(/Edit/);
    expect(guard.matcher).toMatch(/Write/);
    expect(guard.matcher).toMatch(/Bash/);
    expect(guard.hooks[0].type).toBe("command");
    expect(guard.hooks[0].command).toMatch(/worktree-guard\.mjs/);
  });

  it("CLAUDE.md references the danxbot:danx-chat skill by fully-qualified name", () => {
    const path = resolve(HERE, "CLAUDE.md");
    const raw = readFileSync(path, "utf-8");
    // The skill auto-loads via the plugin (danxbot@newms-plugins is
    // enabled in settings.json), but the workspace's CLAUDE.md is the
    // operator-readable pointer at the contract. A regression that
    // renames the skill would break this grep.
    expect(raw).toMatch(/danxbot:danx-chat/);
  });
});
