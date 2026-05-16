/**
 * Unit tests for `bakeDanxRepoRoot` + `rebakeDanxRepoRoot` — the
 * inject-time substitution that replaces the `${DANX_REPO_ROOT}`
 * placeholder in workspace `.mcp.json` files with the literal repo
 * (or worktree) root path.
 *
 * The bake exists because host-mode dispatch (`src/terminal.ts` →
 * `run-agent.sh`) does NOT export the dispatch overlay env vars into
 * the claude subprocess. Without baking, claude's project-trust walker
 * reads the raw `.mcp.json` with the unresolved `${DANX_REPO_ROOT}`
 * placeholder and `/doctor` warns `Missing environment variables`.
 * Docker mode unaffected (worker spawn passes overlay via env), but
 * baking the literal is correct for both runtimes and removes the
 * dispatch-time substitution requirement for this key.
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { bakeDanxRepoRoot, rebakeDanxRepoRoot } from "./workspaces.js";

function makeWorkspace(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "danxbot-bake-test-"));
  mkdirSync(dir, { recursive: true });
  if (content !== null) {
    writeFileSync(resolve(dir, ".mcp.json"), content);
  }
  return dir;
}

const TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      "danx-issue": {
        type: "stdio",
        command: "npx",
        args: ["-y", "@thehammer/danx-issue-mcp"],
        env: { DANX_REPO_ROOT: "${DANX_REPO_ROOT}" },
      },
    },
  },
  null,
  2,
);

describe("bakeDanxRepoRoot", () => {
  it("substitutes the placeholder with the literal repo root", () => {
    const dir = makeWorkspace(TEMPLATE);

    bakeDanxRepoRoot(dir, "/home/newms/web/gpt-manager");

    const parsed = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
    expect(parsed.mcpServers["danx-issue"].env.DANX_REPO_ROOT).toBe(
      "/home/newms/web/gpt-manager",
    );
    // Placeholder is gone — claude project-trust walker will see literal.
    expect(readFileSync(resolve(dir, ".mcp.json"), "utf-8")).not.toContain(
      "${DANX_REPO_ROOT}",
    );
  });

  it("is a no-op when the file has no placeholder (idempotent re-bake)", () => {
    const baked = TEMPLATE.replace(
      "${DANX_REPO_ROOT}",
      "/home/newms/web/gpt-manager",
    );
    const dir = makeWorkspace(baked);

    bakeDanxRepoRoot(dir, "/home/newms/web/different-repo");

    // Existing literal preserved — caller invoked w/ a different value
    // but bakeDanxRepoRoot only fills placeholders, never overwrites
    // an already-baked literal. Rebake path is rebakeDanxRepoRoot.
    expect(readFileSync(resolve(dir, ".mcp.json"), "utf-8")).toBe(baked);
  });

  it("is a no-op when the workspace has no .mcp.json (operator-authored workspaces)", () => {
    const dir = makeWorkspace(null);

    expect(() => bakeDanxRepoRoot(dir, "/some/path")).not.toThrow();
  });

  it("substitutes every occurrence (defensive: multiple servers, single file)", () => {
    const multi = JSON.stringify(
      {
        mcpServers: {
          a: { env: { DANX_REPO_ROOT: "${DANX_REPO_ROOT}" } },
          b: { env: { DANX_REPO_ROOT: "${DANX_REPO_ROOT}" } },
        },
      },
      null,
      2,
    );
    const dir = makeWorkspace(multi);

    bakeDanxRepoRoot(dir, "/repo");

    const out = readFileSync(resolve(dir, ".mcp.json"), "utf-8");
    expect(out).not.toContain("${DANX_REPO_ROOT}");
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.a.env.DANX_REPO_ROOT).toBe("/repo");
    expect(parsed.mcpServers.b.env.DANX_REPO_ROOT).toBe("/repo");
  });
});

describe("rebakeDanxRepoRoot", () => {
  it("swaps the old literal for the new (worktree-mirror path)", () => {
    const baked = TEMPLATE.replace("${DANX_REPO_ROOT}", "/home/newms/web/gpt-manager");
    const dir = makeWorkspace(baked);

    rebakeDanxRepoRoot(
      dir,
      "/home/newms/web/gpt-manager",
      "/home/newms/web/gpt-manager/.danxbot/worktrees/harry",
    );

    const parsed = JSON.parse(readFileSync(resolve(dir, ".mcp.json"), "utf-8"));
    expect(parsed.mcpServers["danx-issue"].env.DANX_REPO_ROOT).toBe(
      "/home/newms/web/gpt-manager/.danxbot/worktrees/harry",
    );
  });

  it("is a no-op when old === new (same-repo re-bake)", () => {
    const baked = TEMPLATE.replace("${DANX_REPO_ROOT}", "/home/newms/web/gpt-manager");
    const dir = makeWorkspace(baked);

    rebakeDanxRepoRoot(dir, "/home/newms/web/gpt-manager", "/home/newms/web/gpt-manager");

    expect(readFileSync(resolve(dir, ".mcp.json"), "utf-8")).toBe(baked);
  });

  it("is a no-op when the old literal is not present (already-baked w/ different value)", () => {
    const baked = TEMPLATE.replace("${DANX_REPO_ROOT}", "/some/other/repo");
    const dir = makeWorkspace(baked);

    rebakeDanxRepoRoot(dir, "/home/newms/web/gpt-manager", "/worktree/harry");

    // File unchanged — caller passed a stale `oldRepoRoot` that does
    // not match what's on disk. Fail-quiet is the right behavior — the
    // worker should not blindly overwrite a literal that does not match
    // its expectations.
    expect(readFileSync(resolve(dir, ".mcp.json"), "utf-8")).toBe(baked);
  });

  it("is a no-op when the workspace has no .mcp.json", () => {
    const dir = makeWorkspace(null);

    expect(() =>
      rebakeDanxRepoRoot(dir, "/old", "/new"),
    ).not.toThrow();
  });
});
