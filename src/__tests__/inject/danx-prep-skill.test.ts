/**
 * The `danx-prep` skill body that ships with the issue-worker workspace.
 * Pins the structural invariants the dispatched agent relies on:
 *
 *   - YAML frontmatter declares `name: danx-prep` and a description
 *     that fires on the `/danx-prep <PREFIX>-N` slash command.
 *   - The seven-step body documented in the parent epic is present.
 *   - The destructive-git ban enumerates `git stash`, `git reset
 *     --hard`, `git checkout <ref>` (branch/commit switch), `git
 *     restore`, `git clean -f`. The narrow per-file orphan-discard
 *     exception in Step 3 is permitted and documented.
 *   - Step 4 branch sync resolves rebase conflicts in place + pushes
 *     with `--force-with-lease` — `git rebase --abort` is forbidden.
 *   - The verdict emission section references
 *     `mcp__danxbot__danxbot_prep_verdict` with the four-verdict
 *     surface (`ok`, `conflict_on`, `blocked`, `abort`) and the
 *     `conflict_with` / `broken_details` arg names. The legacy
 *     `waiting_on` verdict + `blocked_by` arg names are explicitly
 *     forbidden.
 *   - The two prep modes (combined / separate) and the verdict-call-
 *     exactly-once contract are documented in Step 7 / Step 6.
 *   - Step 3's orphan-recovery default mandates an Action Items card
 *     creation via `danx_issue_create`; the narrow B.2 discard window
 *     is gated by four explicit conditions.
 *   - The `agent_blocked` self-block path is documented in Step 5
 *     with a pointer to the `danxbot:issue-blocker` skill gate.
 *   - The skill renders into a dispatched workspace's `.claude/skills/`
 *     via the inject pipeline's `mirrorWorkspaceTree` walk.
 */
import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { syncRepoFiles } from "../../inject/sync.js";
import { makeRepoContext } from "../helpers/fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(
  HERE,
  "../../inject/workspaces/issue-worker/.claude/skills/danx-prep/SKILL.md",
);

function readSkill(): string {
  return readFileSync(SKILL_PATH, "utf-8");
}

function splitFrontmatter(body: string): {
  frontmatter: Record<string, unknown>;
  rest: string;
} {
  const match = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md missing YAML frontmatter");
  return {
    frontmatter: parseYaml(match[1]) as Record<string, unknown>,
    rest: match[2],
  };
}

describe("danx-prep SKILL.md — frontmatter", () => {
  it("declares name: danx-prep", () => {
    const { frontmatter } = splitFrontmatter(readSkill());
    expect(frontmatter.name).toBe("danx-prep");
  });

  it("description triggers on the /danx-prep <PREFIX>-N slash command", () => {
    const { frontmatter } = splitFrontmatter(readSkill());
    const description = frontmatter.description;
    expect(typeof description).toBe("string");
    expect(description as string).toMatch(/\/danx-prep\s+<PREFIX>-N/);
  });

  it("description names the verdict MCP tool", () => {
    const { frontmatter } = splitFrontmatter(readSkill());
    expect(frontmatter.description as string).toContain(
      "mcp__danxbot__danxbot_prep_verdict",
    );
  });

  it("description names the agent_blocked self-block status", () => {
    const { frontmatter } = splitFrontmatter(readSkill());
    expect(frontmatter.description as string).toContain("agent_blocked");
  });
});

describe("danx-prep SKILL.md — seven-step body", () => {
  // Match on step-number anchor + purpose keyword, not exact heading
  // wording. Pinned order matches the rewritten skill: read context,
  // conflict check, uncommitted recovery, branch sync, self-stuck
  // check, emit verdict, continuation.
  const REQUIRED_STEPS: ReadonlyArray<{ name: string; matcher: RegExp }> = [
    {
      name: "Step 1 — Read context",
      matcher: /^##\s+Step 1\b.*(?:read|context)/im,
    },
    {
      name: "Step 2 — Conflict check",
      matcher: /^##\s+Step 2\b.*(?:conflict|overlap|sibling)/im,
    },
    {
      name: "Step 3 — Uncommitted work recovery + reshuffle",
      matcher: /^##\s+Step 3\b.*(?:uncommitted|recovery|reshuffle)/im,
    },
    {
      name: "Step 4 — Branch sync",
      matcher: /^##\s+Step 4\b.*(?:branch|sync|resolve)/im,
    },
    {
      name: "Step 5 — Self-stuck check",
      matcher: /^##\s+Step 5\b.*(?:self|stuck|sanity)/im,
    },
    {
      name: "Step 6 — Emit verdict",
      matcher: /^##\s+Step 6\b.*(?:verdict|emit)/im,
    },
    {
      name: "Step 7 — Continuation",
      matcher: /^##\s+Step 7\b.*(?:continuation|continue)/im,
    },
  ];

  it.each(REQUIRED_STEPS)("body contains `$name`", ({ matcher }) => {
    expect(readSkill()).toMatch(matcher);
  });
});

describe("danx-prep SKILL.md — destructive-git ban", () => {
  // Bug-class blocker: a future edit removes the ban → autonomous
  // agents start running `git stash` / `git reset --hard` in recovery
  // and destroy uncommitted work. Pin each banned primitive by literal
  // string.
  const BANNED_OPERATIONS = [
    "git stash",
    "git reset --hard",
    "git checkout <ref>",
    "git restore",
    "git clean -f",
    "git push --force",
  ] as const;

  it.each(BANNED_OPERATIONS)("explicitly bans `%s`", (op) => {
    expect(readSkill()).toContain(op);
  });

  it("prescribes commit-first as the default recovery primitive", () => {
    expect(readSkill()).toMatch(/commit[- ]first/i);
  });

  it("documents the narrow per-file orphan-discard window in Step 3", () => {
    const body = readSkill();
    expect(body).toMatch(/orphan[- ]discard/i);
    // Per-file checkout / rm are the only allowed primitives in the
    // narrow window — full-tree reset stays banned.
    expect(body).toMatch(/git checkout HEAD -- <(?:file|path)>/);
  });

  it("Step 4 branch sync resolves rebase conflicts in place + pushes with --force-with-lease", () => {
    const body = readSkill();
    expect(body).toMatch(/--ff-only/);
    expect(body).toMatch(/git rebase origin\/main/);
    expect(body).toMatch(/--force-with-lease/);
    expect(body).toMatch(/do not.*rebase --abort|never.*abort/i);
  });
});

describe("danx-prep SKILL.md — verdict emission", () => {
  it("references the MCP tool with the four-verdict surface", () => {
    const body = readSkill();
    expect(body).toContain("mcp__danxbot__danxbot_prep_verdict");
    expect(body).toContain('"ok"');
    expect(body).toContain('"conflict_on"');
    expect(body).toContain('"blocked"');
    expect(body).toContain('"abort"');
  });

  it("uses `conflict_with: [...]` for the overlap path (NOT waiting_on / blocked_by)", () => {
    const body = readSkill();
    expect(body).toMatch(/conflict_with:\s*\[/);
    expect(body).toMatch(/conflict_on/);
    expect(body).toMatch(/renamed|rejects?/i);
  });

  it("Step 2 conflict_on path emits conflict_with array — NOT a status: Blocked stamp", () => {
    const body = readSkill();
    expect(body).toMatch(/file-overlap mutex/i);
    expect(body).toMatch(/conflict_on/);
  });

  it("Step 6 declares the verdict call is exactly-once", () => {
    const body = readSkill();
    expect(body).toMatch(/exactly one|once per verdict/i);
  });
});

describe("danx-prep SKILL.md — forbidden patterns table", () => {
  it("declares a dedicated Forbidden patterns section", () => {
    expect(readSkill()).toMatch(/Forbidden patterns/);
  });

  it("forbids `git rebase --abort` in Step 4", () => {
    expect(readSkill()).toMatch(/rebase --abort/);
  });

  it("forbids enumerating the issues directory for the sibling list", () => {
    expect(readSkill()).toMatch(/[Ee]numerating.*issues.*sibling|do not search/i);
  });

  it("forbids calling mcp__trello__*", () => {
    expect(readSkill()).toMatch(/mcp__trello__/);
  });

  it("forbids returning a verdict without inspecting the siblings", () => {
    expect(readSkill()).toMatch(
      /Returning a verdict without inspecting|verdict accuracy/,
    );
  });

  it("explicitly forbids the legacy `verdict: \"waiting_on\"` arg name", () => {
    const body = readSkill();
    expect(body).toMatch(/`?waiting_on`?.*verdict|verdict.*`?waiting_on`?/i);
  });
});

describe("danx-prep SKILL.md — Step 7 continuation modes", () => {
  it("names both Combined and Separate continuation modes", () => {
    const body = readSkill();
    expect(body).toMatch(/Combined mode/);
    expect(body).toMatch(/Separate mode/);
    expect(body).toMatch(/danxbot_complete/);
  });
});

describe("danx-prep SKILL.md — Step 3 orphan recovery clause", () => {
  it("mandates Action Items card creation via danx_issue_create as the default orphan path", () => {
    const body = readSkill();
    expect(body).toMatch(/no winner|orphan/i);
    expect(body).toContain("danx_issue_create");
  });

  it("gates the narrow B.2 discard window on the 24h timestamp window + junk articulation", () => {
    const body = readSkill();
    expect(body).toMatch(/24h/);
    expect(body).toMatch(/junk|coherent/);
  });

  it("documents the assignment reshuffle (unassign candidate, assign owner)", () => {
    const body = readSkill();
    expect(body).toMatch(/[Uu]nassign yourself/);
    expect(body).toMatch(/assigned_agent: null/);
  });
});

describe("danx-prep SKILL.md — Step 5 self-block via agent_blocked", () => {
  it("documents the agent_blocked self-block path via danxbot_complete", () => {
    const body = readSkill();
    expect(body).toMatch(/agent_blocked/);
    expect(body).toMatch(/danxbot_complete/);
  });

  it("requires loading the danxbot:issue-blocker skill before self-blocking", () => {
    expect(readSkill()).toMatch(/danxbot:issue-blocker/);
  });
});

describe("danx-prep SKILL.md — sibling list comes from prompt body", () => {
  it("instructs the agent to parse `In Progress cards: [...]` from the prompt instead of searching", () => {
    const body = readSkill();
    expect(body).toMatch(/In Progress cards:\s*\[/);
    expect(body).toMatch(/DO NOT enumerate|do not search/i);
  });
});

describe("danx-prep SKILL.md — renders into a workspace dir", () => {
  // End-to-end smoke: drive the real inject pipeline against an empty
  // target dir + a minimal RepoContext, then assert the SKILL.md lands
  // at the mirrored path.
  it("syncRepoFiles mirrors SKILL.md into <repo>/.danxbot/workspaces/issue-worker/.claude/skills/danx-prep/SKILL.md", () => {
    const root = mkdtempSync(resolve(tmpdir(), "danx-prep-smoke-"));
    try {
      const configDir = resolve(root, ".danxbot/config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        resolve(configDir, "config.yml"),
        [
          "name: test-repo",
          "issue_prefix: TR",
          "url: git@example.com:test/test-repo.git",
          "runtime: local",
          "language: typescript",
          "framework: node",
          "commands:",
          "  test: npx vitest run",
          "  lint: npx tsc --noEmit",
          "  type_check: npx tsc --noEmit",
          "  dev: npm run dev",
          "paths:",
          "  source: src",
          "  tests: src",
          "git_mode: main",
          "",
        ].join("\n"),
      );
      writeFileSync(resolve(configDir, "overview.md"), "# overview\n");
      writeFileSync(resolve(configDir, "workflow.md"), "# workflow\n");
      writeFileSync(resolve(configDir, "tools.md"), "# tools\n");

      const repo = makeRepoContext({ localPath: root, hostPath: root });

      syncRepoFiles(repo);

      const expected = resolve(
        root,
        ".danxbot",
        "workspaces",
        "issue-worker",
        ".claude",
        "skills",
        "danx-prep",
        "SKILL.md",
      );
      expect(statSync(expected, { throwIfNoEntry: false })).toBeDefined();

      const mirrored = readFileSync(expected, "utf-8");
      expect(mirrored).toBe(readSkill());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
