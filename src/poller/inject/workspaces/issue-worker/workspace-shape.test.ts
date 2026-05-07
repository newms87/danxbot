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
 * Phase 3 of ISS-90 (Poller triage rework) added a `danx-issue` MCP server
 * entry — the YAML-first `@thehammer/danx-issue-mcp` package — so the
 * triage agent can call `mcp__danx-issue__danx_issue_get` /
 * `danx_issue_save` directly. That server happens to need `TRELLO_API_KEY`
 * + `TRELLO_API_TOKEN` for outbound sync, so the raw `.mcp.json` now
 * references those keys (declared as `optional-placeholders` in
 * `workspace.yml` so non-trello deploys substitute them to ""). The
 * tracker-agnostic guarantee still holds — the YAML store is the source
 * of truth; Trello is a one-way mirror reached only through the
 * `danx-issue` MCP server.
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

  // Phase 3 of ISS-90: the `danx-issue` MCP server (`@thehammer/danx-issue-mcp`)
  // has its own env contract — `DANX_REPO_ROOT` is required (the server fails
  // loud without it), and the trello triple is optional so non-trello deploys
  // can substitute empty strings without throwing PlaceholderError. Pin the
  // exact required + optional sets so a future agent can't silently flip a
  // required placeholder to optional (which would let the server start with a
  // missing repo root and produce confusing 500s downstream).
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
    expect([...optional].sort()).toEqual(
      ["DANX_TRACKER", "TRELLO_API_KEY", "TRELLO_API_TOKEN"].sort(),
    );
  });

  // Phase 3 of ISS-90: the `danx-issue` MCP server must declare every env var
  // the `@thehammer/danx-issue-mcp` package's `resolveServerContext` reads
  // (DANX_REPO_ROOT required; DANX_TRACKER + TRELLO_API_KEY + TRELLO_API_TOKEN
  // for trello mode). Missing any one would either crash the server at boot
  // or silently fall back to memory tracker — pin the contract here.
  it("`.mcp.json` `danx-issue` server declares every env key the package needs", () => {
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
    expect(Object.keys(danxIssue.env ?? {}).sort()).toEqual(
      ["DANX_REPO_ROOT", "DANX_TRACKER", "TRELLO_API_KEY", "TRELLO_API_TOKEN"].sort(),
    );
    // Each value must be a placeholder reference — concrete values would
    // bake host paths or secrets into the committed file.
    for (const value of Object.values(danxIssue.env ?? {})) {
      expect(value).toMatch(/^\$\{[A-Z_]+\}$/);
    }
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

  // Phase 3 of ISS-90: ship the `danx-triage-card` skill in this workspace.
  // The poller's Phase 4 work (ISS-94) dispatches it on every Review /
  // Needs Help / Blocked card whose `triage.expires_at <= now`. Pinning the
  // skill's presence + per-status TTL contract + ICE rubric scale + the
  // reassess_hint constraint + the routing-precedence rule here means a
  // future agent can't silently delete the skill, flip the TTL numbers,
  // revert the ICE scale, or drop the `blocked != null FIRST` routing rule
  // without a failing test. Each anchor below is a load-bearing AC from
  // ISS-93.
  it("`danx-triage-card/SKILL.md` ships with the per-status TTL contract + ICE rubric + decision enum", () => {
    const path = resolve(
      HERE,
      ".claude/skills/danx-triage-card/SKILL.md",
    );
    const body = readFileSync(path, "utf-8");

    // AC #1 — skill body covers all 3 in-scope cards w/ correct TTL +
    // decision logic.
    expect(body).toMatch(/name:\s*danx-triage-card/);
    expect(body).toMatch(/Review[^|]*\|\s*24h/);
    expect(body).toMatch(/Needs Help[^|]*\|\s*3h/);
    expect(body).toMatch(/Blocked[^|]*\|\s*1h/);
    // Decision-outcome enum — every `triage.last_status` value the schema
    // accepts must be documented somewhere in the body. A regression that
    // deleted (e.g.) the Needs Help "Demote" path would slip past the TTL
    // anchor alone.
    for (const decision of [
      "Keep",
      "Cancel",
      "Approve",
      "Demote",
      "Confirm-Block",
      "Unblock",
    ]) {
      expect(body).toContain(decision);
    }
    // Routing-precedence rule — the agent MUST check `blocked != null`
    // FIRST (worker forces status: ToDo on blocked cards, so a blocked
    // card looks like a dispatchable work card on `status` alone).
    expect(body).toMatch(/blocked\s*!=\s*null/);

    // AC #2 — ICE rubric on the **1–5** scale (NOT the legacy 1–10 from
    // the bulk-triage skill). Schema's `triage.ice` validator caps each
    // dimension at 5; a regression to 1–10 would fail the validator on
    // every Review save. Body says `**1–5** scale` (em-dash, asterisks),
    // so the regex must allow non-whitespace between `5` and `scale`.
    expect(body).toMatch(/\*?\*?1[–-]5\*?\*?[^\n]{0,5}scale|1[–-]5\s*each/i);
    // Product-max anchor — `1–125` (em-dash) appears literally.
    expect(body).toMatch(/1[–-]125/);
    // Formula anchor — `i × c × e` with the multiplication sign.
    expect(body).toMatch(/i\s*[×x*]\s*c\s*[×x*]\s*e/i);

    // AC #3 — reassess_hint contract: ≤120 chars, action-shaped. A
    // regression that dropped the constraint would let the agent emit
    // multi-paragraph hints that defeat the "≤30s rechecks" purpose.
    expect(body).toMatch(/reassess_hint/);
    expect(body).toMatch(/[≤<=]\s*120/);
    expect(body).toMatch(/action.{0,5}shaped/i);

    // AC #6 — Hard Gate audit reuses the `unblock` skill's
    // misclassification logic. Both anchors must appear so a future
    // refactor that drops the `unblock` reference fails the test.
    expect(body).toMatch(/Hard Gate/);
    expect(body).toMatch(/unblock\/SKILL\.md|misclassification/i);
    // Rationalisation detector — the named phrase list is the operational
    // anchor for distinguishing punted Needs Help from genuine ones.
    // Pin one of the canonical phrases so the list survives editing.
    expect(body).toMatch(/operator-driven verification|honest way to verify/);
  });

  // Phase 3 of ISS-90: the `danx-triage` skill body becomes a thin
  // redirect (deprecated stub) pointing at `danx-triage-card`. Pin that
  // shape so a future Phase 5 agent doesn't prematurely delete the
  // redirect, and so a future agent doesn't accidentally re-fill it with
  // bulk-orchestrator content.
  it("`danx-triage/SKILL.md` is a deprecated thin redirect to `danx-triage-card`", () => {
    const path = resolve(HERE, ".claude/skills/danx-triage/SKILL.md");
    const body = readFileSync(path, "utf-8");
    expect(body).toMatch(/DEPRECATED/);
    expect(body).toMatch(/danx-triage-card/);
    // Belt-and-suspenders: the redirect should NOT carry the legacy
    // bulk-orchestrator instructions (ICE 1-10, Step 2 — Per-Card Audit
    // (parallel subagents), etc.). Pinning the absence of the most
    // distinctive phrase is enough to catch a revert.
    expect(body).not.toMatch(/Per-Card Audit \(parallel subagents\)/);
  });

  // Phase 3 of ISS-90: the skill body lives in BOTH the danxbot inject
  // path AND the claude-plugins marketplace source. Drift between the two
  // would cause subtle behavior differences depending on which path the
  // agent loads from. Pin byte-identical content. Skipped if the
  // claude-plugins repo is not mounted at the expected dev path (CI, prod
  // deploys, anyone who hasn't cloned the marketplace locally).
  it("`danx-triage-card/SKILL.md` matches the claude-plugins marketplace mirror byte-for-byte", () => {
    const injectPath = resolve(
      HERE,
      ".claude/skills/danx-triage-card/SKILL.md",
    );
    const marketplacePath =
      "/home/newms/web/claude-plugins/issue-worker/skills/danx-triage-card/SKILL.md";
    if (!statSync(marketplacePath, { throwIfNoEntry: false })) {
      // Marketplace not available (CI, fresh checkout) — skip rather than
      // fail. The drift-prevention is dev-time-only by design.
      return;
    }
    const injectBody = readFileSync(injectPath, "utf-8");
    const marketplaceBody = readFileSync(marketplacePath, "utf-8");
    expect(injectBody).toEqual(marketplaceBody);
  });

  it("`danx-triage/SKILL.md` redirect matches the claude-plugins marketplace mirror byte-for-byte", () => {
    const injectPath = resolve(HERE, ".claude/skills/danx-triage/SKILL.md");
    const marketplacePath =
      "/home/newms/web/claude-plugins/issue-worker/skills/danx-triage/SKILL.md";
    if (!statSync(marketplacePath, { throwIfNoEntry: false })) return;
    const injectBody = readFileSync(injectPath, "utf-8");
    const marketplaceBody = readFileSync(marketplacePath, "utf-8");
    expect(injectBody).toEqual(marketplaceBody);
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
