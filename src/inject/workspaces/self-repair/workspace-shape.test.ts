/**
 * Regression tests for the `self-repair` workspace SOURCE (DX-564 —
 * Phase 4 of DX-560 Self-Repair). `injectDanxWorkspaces` mirrors this
 * directory verbatim into every connected repo's
 * `<repo>/.danxbot/workspaces/self-repair/`, so pinning the source IS
 * pinning the runtime shape.
 *
 * Invariants:
 *   1. `.mcp.json` declares ONLY the `danx-issue` MCP server. Self-
 *      repair runs in-worktree fixes; no Trello, no Slack, no
 *      playwright, no schema MCP. DX-203's "danx-issue reads only
 *      `DANX_REPO_ROOT`" contract applies.
 *   2. `workspace.yml` required-placeholders pin the resolver contract
 *      so a regression that drops a required env doesn't surface as
 *      a mid-dispatch crash. Staging-paths is empty by design — the
 *      agent reads the candidate YAML from the worktree, no staged
 *      files.
 *   3. `.claude/settings.json` enables BOTH `base@newms-plugins` and
 *      `danxbot@newms-plugins` (the latter ships the
 *      `danxbot:self-repair` skill the workspace dispatches into).
 *      The PreToolUse worktree-guard hook gates every Edit/Write/Bash
 *      so an agent that strays outside the candidate's worktree
 *      trips loud.
 *   4. `CLAUDE.md` references the plugin skill by its fully-qualified
 *      name (`danxbot:self-repair`) — a regression that renames the
 *      skill would surface in this file's grep result.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("self-repair workspace shape (DX-564)", () => {
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

  it(".mcp.json does NOT reference Slack / Trello / schema / playwright placeholders", () => {
    const raw = readFileSync(resolve(HERE, ".mcp.json"), "utf-8");
    expect(raw).not.toMatch(/SLACK_/);
    expect(raw).not.toMatch(/TRELLO_/);
    expect(raw).not.toMatch(/SCHEMA_DEFINITION_ID/);
    expect(raw).not.toMatch(/playwright/i);
  });

  it("workspace.yml required-placeholders match the resolver contract", () => {
    const path = resolve(HERE, "workspace.yml");
    const manifest = parseYaml(readFileSync(path, "utf-8")) as {
      "required-placeholders"?: string[];
      "optional-placeholders"?: string[];
      "staging-paths"?: string[];
    };
    const required = manifest["required-placeholders"] ?? [];
    const optional = manifest["optional-placeholders"] ?? [];
    const staging = manifest["staging-paths"] ?? [];
    // Self-repair never stages files into the workspace — the agent
    // reads the candidate YAML from the worktree directly. Empty
    // staging-paths array is load-bearing: a regression that adds
    // a path here would unintentionally widen the staged-files
    // allowlist for self-repair dispatches.
    expect(staging).toEqual([]);
    expect([...required].sort()).toEqual(
      ["DANXBOT_STOP_URL", "DANX_REPO_ROOT"].sort(),
    );
    expect(optional).toEqual([]);
  });

  it(".claude/settings.json enables base + danxbot plugins", () => {
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
    // Matcher MUST gate Edit/Write/MultiEdit/Bash — self-repair
    // agents fall back to Bash for `git log`-style probes + verifier
    // commands, every mutating call must hit the worktree guard.
    expect(guard.matcher).toMatch(/Edit/);
    expect(guard.matcher).toMatch(/Write/);
    expect(guard.matcher).toMatch(/Bash/);
    expect(guard.hooks[0].type).toBe("command");
    expect(guard.hooks[0].command).toMatch(/worktree-guard\.mjs/);
  });

  it("CLAUDE.md references the danxbot:self-repair skill by fully-qualified name", () => {
    const path = resolve(HERE, "CLAUDE.md");
    const raw = readFileSync(path, "utf-8");
    // The skill auto-loads via the plugin (danxbot@newms-plugins is
    // enabled in settings.json), but the workspace's CLAUDE.md is
    // the operator-readable pointer at the contract. A regression
    // that renames the skill would break this grep.
    expect(raw).toMatch(/danxbot:self-repair/);
  });

  it("CLAUDE.md references the Phase-3 finalize verdict parser by file path", () => {
    const path = resolve(HERE, "CLAUDE.md");
    const raw = readFileSync(path, "utf-8");
    // Operator-visible pointer at the load-bearing parser whose
    // contract the verdict prefix MUST match. A move of the parser
    // would surface here.
    expect(raw).toMatch(/src\/system-repair\/finalize\.ts/);
    expect(raw).toMatch(/parseVerdictFromSummary/);
  });
});
