/**
 * Regression test for the skill-eval workspace inject source.
 *
 * The harness's whole point is to reproduce a faithful copy of the agent
 * tool surface that fires on a production dispatch — if a future change
 * drifts skill-eval's plugin set or MCP server list away from
 * `issue-worker`'s, every probe verdict becomes meaningless (the agent
 * literally has different tools to invoke). This file pins:
 *
 *   1. `.mcp.json` matches `issue-worker`'s server set AND the per-server
 *      `command`/`args`/`env` keys. Pure key-name equality would miss a
 *      transport swap (stdio→http) or a renamed env var; deep parity
 *      catches both.
 *   2. `.claude/settings.json` `enabledPlugins` matches `issue-worker`
 *      exactly — same keys, same booleans. A plugin disabled in
 *      `issue-worker` but absent here (or vice-versa) would silently
 *      change what triggers fire in production vs in a probe.
 *   3. `workspace.yml` declares the exact placeholder + staging contract
 *      the resolver expects.
 *
 * This file lives alongside the workspace fixtures (not under
 * `src/poller/`) for the same reason `issue-worker/workspace-shape.test.ts`
 * does: `injectDanxWorkspaces` mirrors this directory verbatim, so a
 * violation here trips before the next tick can propagate the regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const ISSUE_WORKER = resolve(HERE, "..", "issue-worker");

describe("skill-eval workspace shape", () => {
  it("`.mcp.json` mirrors issue-worker — same server set AND per-server shape", () => {
    const here = JSON.parse(
      readFileSync(resolve(HERE, ".mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    const issueWorker = JSON.parse(
      readFileSync(resolve(ISSUE_WORKER, ".mcp.json"), "utf-8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };

    expect(Object.keys(here.mcpServers).sort()).toEqual(
      Object.keys(issueWorker.mcpServers).sort(),
    );

    // Per-server deep parity catches transport swaps and env-key renames
    // that pure key-set equality misses.
    for (const name of Object.keys(issueWorker.mcpServers)) {
      const a = here.mcpServers[name] ?? {};
      const b = issueWorker.mcpServers[name] ?? {};
      expect({ command: a.command, args: a.args, type: a.type }).toEqual({
        command: b.command,
        args: b.args,
        type: b.type,
      });
      const envA = (a.env ?? {}) as Record<string, unknown>;
      const envB = (b.env ?? {}) as Record<string, unknown>;
      expect(Object.keys(envA).sort()).toEqual(Object.keys(envB).sort());
    }
  });

  it("`.claude/settings.json` enabledPlugins matches issue-worker exactly", () => {
    const here = JSON.parse(
      readFileSync(resolve(HERE, ".claude/settings.json"), "utf-8"),
    ) as { enabledPlugins?: Record<string, boolean> };
    const issueWorker = JSON.parse(
      readFileSync(resolve(ISSUE_WORKER, ".claude/settings.json"), "utf-8"),
    ) as { enabledPlugins?: Record<string, boolean> };

    // Compare the full map — same keys, same boolean values — so a
    // plugin disabled in issue-worker but absent here (or vice-versa)
    // surfaces as a diff. A `=== true` filter would let "omitted vs
    // explicit false" drift through.
    expect(here.enabledPlugins ?? {}).toEqual(issueWorker.enabledPlugins ?? {});
  });

  it("workspace.yml declares the required placeholders for dispatch core", () => {
    const path = resolve(HERE, "workspace.yml");
    const manifest = parseYaml(readFileSync(path, "utf-8")) as {
      "required-placeholders"?: string[];
      "optional-placeholders"?: string[];
      "staging-paths"?: string[];
    };
    const required = manifest["required-placeholders"] ?? [];
    expect([...required].sort()).toEqual(
      ["DANXBOT_STOP_URL", "DANXBOT_WORKER_PORT", "DANX_REPO_ROOT"].sort(),
    );
    expect(manifest["optional-placeholders"] ?? []).toEqual([]);
    expect(manifest["staging-paths"] ?? []).toEqual([]);
  });

  it("CLAUDE.md exists and explains the workspace isolation rationale", () => {
    const body = readFileSync(resolve(HERE, "CLAUDE.md"), "utf-8");
    expect(body).toMatch(/skill-eval/);
    expect(body).toMatch(/isolat|workspace/i);
  });
});
