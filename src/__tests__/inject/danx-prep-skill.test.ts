/**
 * DX-295 — the `danx-prep` skill body that ships with the issue-worker
 * workspace. Pins the structural invariants the dispatched agent relies
 * on:
 *
 *   - YAML frontmatter declares `name: danx-prep` and a description
 *     that fires on the `/danx-prep <PREFIX>-N` slash command.
 *   - The seven-step body documented in the parent epic (DX-291) is
 *     present.
 *   - The destructive-git ban enumerates `git stash`, `git reset
 *     --hard`, `git checkout <ref>`, `git restore`, `git clean -f`.
 *   - The verdict emission section references
 *     `mcp__danxbot__danxbot_prep_verdict` with the four-verdict
 *     surface (`ok`, `conflict_on`, `blocked`, `abort`) and the
 *     `conflict_with` / `broken_details` arg names. The Forbidden-
 *     patterns table explicitly enumerates the legacy `waiting_on`
 *     verdict + `blocked_by` arg names so an agent learning the old
 *     shape from upstream docs sees the rejection rule before calling.
 *   - The two prep modes (combined / separate) and the verdict-call-
 *     exactly-once contract are documented in Step 7 / Step 6.
 *   - The orphan-recovery branch in Step 2 mandates an Action Items
 *     card creation via `danx_issue_create` — the only sanctioned
 *     out-of-worktree write in the skill.
 *   - The skill renders into a dispatched workspace's `.claude/skills/`
 *     via the inject pipeline's `mirrorWorkspaceTree` walk — the AC #7
 *     end-to-end check exercises the real mirror against a tempdir.
 *
 * Pinning the source body at the inject SOURCE is the same pattern the
 * sibling `workspace-shape.test.ts` uses for `.mcp.json` /
 * `workspace.yml`: the dispatched agent's cwd is the mirror target, so
 * the SOURCE shape IS the runtime shape.
 *
 * Test file home: `src/__tests__/inject/`. Co-locating with the SKILL.md
 * under `src/inject/workspaces/issue-worker/.claude/skills/danx-prep/`
 * would mirror the test file into every connected repo's workspace tree
 * via `mirrorWorkspaceTree` — dead weight + confusing artifact for any
 * operator opening a connected repo's workspace dir to debug. Tests of
 * inject-mirrored content live one directory level up.
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

describe("danx-prep SKILL.md — frontmatter (AC #1, #2)", () => {
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
});

describe("danx-prep SKILL.md — seven-step body (AC #1)", () => {
  // Match on step-number anchor + a purpose keyword, not the exact
  // heading wording. This tolerates cosmetic edits (em-dash → en-dash,
  // "Conflict check" → "File-overlap check") while still failing if
  // the section is removed wholesale. The regex flags `im` give:
  //   - `m` — `^` matches start-of-line (heading anchor).
  //   - `i` — case-insensitive on the purpose keywords.
  const REQUIRED_STEPS: ReadonlyArray<{ name: string; matcher: RegExp }> = [
    {
      name: "Step 1 — Read context",
      matcher: /^##\s+Step 1\b.*(?:read|context|fetch)/im,
    },
    {
      name: "Step 2 — Uncommitted work recovery",
      matcher: /^##\s+Step 2\b.*(?:uncommitted|recovery|wip)/im,
    },
    {
      name: "Step 3 — Branch sync",
      matcher: /^##\s+Step 3\b.*(?:branch|sync)/im,
    },
    {
      name: "Step 4 — Conflict check",
      matcher: /^##\s+Step 4\b.*(?:conflict|overlap)/im,
    },
    {
      name: "Step 5 — Card-itself sanity check",
      matcher: /^##\s+Step 5\b.*(?:card|sanity|self)/im,
    },
    {
      name: "Step 6 — Emit verdict",
      matcher: /^##\s+Step 6\b.*(?:verdict|emit)/im,
    },
    {
      name: "Step 7 — Continuation",
      matcher: /^##\s+Step 7\b.*(?:continuation|continue|exit)/im,
    },
  ];

  it.each(REQUIRED_STEPS)("body contains `$name`", ({ matcher }) => {
    expect(readSkill()).toMatch(matcher);
  });
});

describe("danx-prep SKILL.md — destructive-git ban (AC #3, #4)", () => {
  // Bug-class blocker: a future edit removes the ban → autonomous agents
  // start running `git stash` / `git reset --hard` in recovery and
  // destroy uncommitted work. Pin every banned primitive by literal
  // string so the test fails loud on a hand-typo'd retraction.
  const BANNED_OPERATIONS = [
    "git stash",
    "git reset --hard",
    "git checkout <ref>",
    "git restore",
    "git clean -f",
  ] as const;

  it.each(BANNED_OPERATIONS)("explicitly bans `%s`", (op) => {
    expect(readSkill()).toContain(op);
  });

  it("prescribes commit-first as the only recovery primitive", () => {
    expect(readSkill()).toMatch(/commit[- ]first/i);
  });

  it("Branch sync section prescribes fetch + ff-only OR rebase OR abort (no destructive ops)", () => {
    const body = readSkill();
    expect(body).toMatch(/--ff-only/);
    expect(body).toMatch(/git rebase origin\/main/);
    // The branch-sync table MUST present `abort` as the fallback when
    // either pull or rebase refuses.
    expect(body).toMatch(/verdict `abort`/);
  });
});

describe("danx-prep SKILL.md — verdict emission (AC #5)", () => {
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
    expect(body).toMatch(/rejected|rejects|renamed/i);
  });

  it("conflict_on path emits conflict_with array — NOT a status: Blocked stamp", () => {
    // Belt and suspenders: a future edit that accidentally re-uses the
    // `blocked` verdict for file-scope overlap (the old behaviour) would
    // collapse the two-way conflict gate the poller relies on. The
    // skill body must explicitly call out `conflict_on` as the overlap
    // verdict and `blocked` as the self-stuck verdict.
    const body = readSkill();
    expect(body).toMatch(/file-scope overlap.*conflict_on/is);
    expect(body).toMatch(/self-stuck|self stuck|spec ambiguous/i);
  });

  it("Step 6 declares the verdict call is exactly-once and prohibits retry", () => {
    // The MCP tool route stamps the candidate YAML on each call. A
    // retry from the agent on a transient ack delay would double-stamp.
    // Pin the contract in the skill so a future edit cannot soften
    // "exactly once" to "best effort".
    const body = readSkill();
    expect(body).toMatch(/exactly once/i);
    expect(body).toMatch(/do not loop|do not retry|do NOT retry/i);
  });
});

describe("danx-prep SKILL.md — forbidden patterns section (AC #6)", () => {
  it("declares a dedicated Forbidden patterns section", () => {
    expect(readSkill()).toMatch(/Forbidden patterns/);
  });

  it("forbids writing outside the worktree", () => {
    expect(readSkill()).toMatch(
      /Writing to any path outside the worktree|outside the worktree/,
    );
  });

  it("forbids calling mcp__trello__*", () => {
    expect(readSkill()).toMatch(/mcp__trello__/);
  });

  it("forbids returning a verdict without inspecting in-progress YAMLs", () => {
    expect(readSkill()).toMatch(
      /Returning a verdict without inspecting|without inspecting the in-progress/,
    );
  });

  it("explicitly forbids the legacy `verdict: \"waiting_on\"` and `blocked_by:` arg names", () => {
    // Other danxbot repos and upstream docs that predate the 2026-05-12
    // rename may teach the old shape. The Forbidden-patterns table is
    // where the agent looks when its first call gets rejected — the
    // legacy names need to appear there as banned, not just in passing
    // reject-on-call narration.
    const body = readSkill();
    expect(body).toMatch(/`waiting_on`.*verdict|verdict.*`waiting_on`/i);
    expect(body).toMatch(/`blocked_by:?`/);
  });
});

describe("danx-prep SKILL.md — Step 7 continuation modes", () => {
  it("names both Combined and Separate continuation modes", () => {
    // P5 (DX-296) dispatches the prep skill in two prompt shapes —
    // `/danx-prep <ISS> + /danx-next` for combined, `/danx-prep <ISS>`
    // alone for separate. The agent reads its prompt to decide whether
    // to proceed into work or call `danxbot_complete`. A future edit
    // collapsing the modes or renaming `prepMode` would silently
    // change runtime behaviour without failing any existing test.
    const body = readSkill();
    expect(body).toMatch(/Combined mode/);
    expect(body).toMatch(/Separate mode/);
    expect(body).toMatch(/danxbot_complete/);
  });
});

describe("danx-prep SKILL.md — Step 2 orphan recovery clause", () => {
  it("mandates Action Items card creation via danx_issue_create when no existing YAML scores above 0", () => {
    // The orphan-recovery branch is the only sanctioned out-of-worktree
    // write inside the skill — a future edit removing it would leave
    // recovered work without a durable home, and the "Writing outside
    // the worktree" forbidden-pattern row would become self-
    // contradictory (it explicitly carves out this case).
    const body = readSkill();
    expect(body).toMatch(/no YAML scored above 0|no card scored above 0/i);
    expect(body).toContain("danx_issue_create");
  });
});

describe("danx-prep SKILL.md — renders into a workspace dir (AC #7)", () => {
  // End-to-end smoke: drive the real inject pipeline against an empty
  // target dir + a minimal RepoContext, then assert the SKILL.md lands
  // at the mirrored path. This is the load-bearing acceptance — a
  // regression in `mirrorWorkspaceTree`'s recursion (e.g. skipping
  // `.claude/skills/*` because of an explicit filter) would silently
  // strip the prep skill from every connected repo's workspace.
  it("syncRepoFiles mirrors SKILL.md into <repo>/.danxbot/workspaces/issue-worker/.claude/skills/danx-prep/SKILL.md", () => {
    const root = mkdtempSync(resolve(tmpdir(), "danx-prep-smoke-"));
    try {
      // Stub the minimum `.danxbot/config/` layout `syncRepoFiles`
      // reads BEFORE invoking `injectDanxWorkspaces`. The four files
      // below correspond to the four `existsSync`/`readFileSync` reads
      // the function does upfront — anything more is the skill mirror
      // we're about to assert on, anything less aborts the sync early.
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

      // `makeRepoContext` (shared test helper) fills every required
      // `RepoContext` field with sane defaults — keeps the fixture
      // future-proof against type additions and lets this smoke focus
      // on the assertion that matters (mirror byte-equality).
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
      // Source-equality, not just existence — the mirror must copy
      // verbatim. A future regression that filters SKILL.md content
      // (e.g. via a sanitizer that strips fenced code) would otherwise
      // pass a file-presence assertion.
      expect(mirrored).toBe(readSkill());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
