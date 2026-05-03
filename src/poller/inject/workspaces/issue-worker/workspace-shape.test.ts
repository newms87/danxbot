/**
 * Regression test for the Phase 4 cutover of the tracker-agnostic-agents
 * epic. Phase 4 dropped the trello MCP server entry from this workspace's
 * `.mcp.json` and rewrote every SKILL.md to use the YAML + danx_issue_*
 * flow instead of `mcp__trello__*` calls.
 *
 * After Phase 4, NO `mcp__trello__*` reference may appear in any SKILL.md
 * here, and the workspace `.mcp.json` must not declare a `trello` MCP
 * server. A future agent reintroducing either would silently re-pollute
 * the agent's tool surface and break the tracker-agnostic guarantee.
 *
 * This file lives alongside the workspace fixtures (not under `src/poller/`)
 * because `injectDanxWorkspaces` mirrors this directory verbatim into every
 * connected repo. The test must pin the SOURCE of the mirror so a violation
 * here is caught before any tick propagates the regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("issue-worker workspace shape (Phase 4 invariants)", () => {
  it(".mcp.json has no `trello` server entry and keeps `playwright`", () => {
    const path = resolve(HERE, ".mcp.json");
    const content = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(content.mcpServers).toBeDefined();
    expect(Object.keys(content.mcpServers)).not.toContain("trello");
    expect(Object.keys(content.mcpServers)).toContain("playwright");
  });

  it(".mcp.json does NOT reference any TRELLO_* env placeholder", () => {
    const path = resolve(HERE, ".mcp.json");
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toMatch(/TRELLO_API_KEY/);
    expect(raw).not.toMatch(/TRELLO_TOKEN/);
    expect(raw).not.toMatch(/TRELLO_BOARD_ID/);
  });

  // Phase 5 hotfix (Trello 69f7764f...): the manifest's
  // `required-placeholders` list is the dispatch boundary's contract for
  // what overlay keys the resolver insists on. After Phase 4 dropped the
  // trello MCP server entry, no fixture file inside this workspace
  // references TRELLO_API_KEY / TRELLO_TOKEN / TRELLO_BOARD_ID — leaving
  // them in the required-placeholders block was dead weight that broke
  // every non-poller dispatch (HTTP `/api/launch`, the YAML-memory system
  // test) since those callers don't supply Trello creds. Pin the
  // allowlist so a future agent can't silently re-introduce a dead
  // required key — substitute() would still be the loud failure mode at
  // runtime, but a unit-test failure here surfaces it during the edit.
  it("workspace.yml required-placeholders is exactly the keys actually substituted by the resolver", () => {
    const path = resolve(HERE, "workspace.yml");
    const manifest = parseYaml(readFileSync(path, "utf-8")) as {
      "required-placeholders"?: string[];
    };
    const required = manifest["required-placeholders"] ?? [];
    expect([...required].sort()).toEqual(
      ["DANXBOT_STOP_URL", "DANXBOT_WORKER_PORT"].sort(),
    );
  });

  it("no SKILL.md mentions `mcp__trello__*` or the legacy `<!-- danxbot -->` marker", () => {
    const skillsDir = resolve(HERE, ".claude/skills");
    const skillFiles = collectSkillMd(skillsDir);
    expect(skillFiles.length).toBeGreaterThan(0);

    const offenses: string[] = [];
    for (const file of skillFiles) {
      const body = readFileSync(file, "utf-8");
      if (/mcp__trello__/.test(body)) {
        offenses.push(`${file}: contains mcp__trello__ reference`);
      }
      if (/<!--\s*danxbot/.test(body)) {
        offenses.push(`${file}: contains <!-- danxbot --> marker reference`);
      }
    }
    expect(offenses).toEqual([]);
  });
});

function collectSkillMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSkillMd(full));
    } else if (entry === "SKILL.md") {
      out.push(full);
    }
  }
  return out;
}
