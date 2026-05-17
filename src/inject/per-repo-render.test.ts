import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoContext } from "../types.js";
import {
  copyFeatures,
  PER_REPO_RENDER_RULE_NAMES,
  renderPerRepoFilesIntoWorkspaces,
} from "./per-repo-render.js";

function buildRepoContext(localPath: string): RepoContext {
  return {
    name: "test-repo",
    url: "https://example.com/test.git",
    localPath,
    hostPath: localPath,
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
      blockedLabelId: "",
      requiresHumanLabelId: "",
    },
    trelloEnabled: false,
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: {
      host: "",
      port: 3306,
      user: "",
      password: "",
      database: "",
      enabled: false,
    },
    githubToken: "",
    workerPort: 5562,
    issuePrefix: "DX",
  };
}

describe("renderPerRepoFilesIntoWorkspaces — DX-512 effort policy", () => {
  let tmpRoot: string;
  let repoLocalPath: string;
  let danxbotConfigDir: string;
  let workspacesDir: string;
  const cfg: Record<string, string> = {
    name: "test-repo",
    url: "https://example.com/test.git",
    runtime: "local",
    language: "typescript",
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "per-repo-render-test-"));
    repoLocalPath = resolve(tmpRoot, "repo");
    danxbotConfigDir = resolve(repoLocalPath, ".danxbot/config");
    workspacesDir = resolve(repoLocalPath, ".danxbot/workspaces");
    mkdirSync(danxbotConfigDir, { recursive: true });
    mkdirSync(resolve(workspacesDir, "alpha"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes danx-effort-policy.md with operator prompt + level table verbatim", () => {
    const operatorPrompt =
      "OPERATOR_PROMPT_BODY_TOKEN — pick effort per these custom rules.";
    writeFileSync(
      resolve(repoLocalPath, ".danxbot/settings.json"),
      JSON.stringify({
        effortAssignmentPrompt: operatorPrompt,
        effortLevels: [
          { name: "min", model: "claude-haiku-4-5", effort: "minimal" },
          { name: "very_low", model: "claude-haiku-4-5", effort: "low" },
          { name: "low", model: "claude-haiku-4-5", effort: "high" },
          { name: "medium", model: "claude-sonnet-4-6", effort: "low" },
          { name: "high", model: "claude-sonnet-4-6", effort: "medium" },
          { name: "very_high", model: "claude-sonnet-4-6", effort: "high" },
          {
            name: "max",
            model: "OPERATOR_MAX_MODEL",
            effort: "OPERATOR_MAX_EFFORT",
          },
        ],
      }),
    );

    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );

    const rendered = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-effort-policy.md"),
      "utf-8",
    );

    expect(rendered).toContain(operatorPrompt);
    expect(rendered).toContain("OPERATOR_MAX_MODEL");
    expect(rendered).toContain("OPERATOR_MAX_EFFORT");

    const idxMin = rendered.indexOf("| min ");
    const idxMax = rendered.indexOf("| max ");
    expect(idxMin).toBeGreaterThan(-1);
    expect(idxMax).toBeGreaterThan(idxMin);
  });

  it("falls back to default prompt + ladder when settings.json is absent", () => {
    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );

    const rendered = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-effort-policy.md"),
      "utf-8",
    );

    expect(rendered).toContain("Pick the LOWEST effort level");
    expect(rendered).toContain("claude-haiku-4-5");
    expect(rendered).toContain("claude-sonnet-4-6");
    expect(rendered).toContain("claude-opus-4-7");
  });

  it("registers danx-effort-policy.md in PER_REPO_RENDER_RULE_NAMES (prune allowlist)", () => {
    expect(PER_REPO_RENDER_RULE_NAMES.has("danx-effort-policy.md")).toBe(true);
  });

  it("renders the AUTO-GENERATED 'do not edit' header so operator hand-edits get squashed each tick", () => {
    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );
    const rendered = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-effort-policy.md"),
      "utf-8",
    );
    expect(rendered.startsWith("<!-- AUTO-GENERATED")).toBe(true);
    expect(rendered).toContain(".danxbot/settings.json");
  });

  it("blends operator prompt with default ladder when only effortAssignmentPrompt is set", () => {
    const operatorPrompt =
      "PARTIAL_OPERATOR_PROMPT — only the prompt is overridden, ladder is default.";
    writeFileSync(
      resolve(repoLocalPath, ".danxbot/settings.json"),
      JSON.stringify({ effortAssignmentPrompt: operatorPrompt }),
    );

    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );

    const rendered = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-effort-policy.md"),
      "utf-8",
    );
    expect(rendered).toContain(operatorPrompt);
    // Default ladder rows lands verbatim — drift guard against the
    // helper inadvertently coupling the two reads.
    expect(rendered).toContain("claude-haiku-4-5");
    expect(rendered).toContain("claude-opus-4-7");
  });

  it("DX-105: every rendered .md per-repo file starts with the HTML banner naming its source", () => {
    writeFileSync(
      resolve(danxbotConfigDir, "overview.md"),
      "# Overview body\n",
    );
    writeFileSync(
      resolve(danxbotConfigDir, "workflow.md"),
      "# Workflow body\n",
    );
    writeFileSync(resolve(danxbotConfigDir, "tools.md"), "tools doc\n");
    writeFileSync(
      resolve(repoLocalPath, ".danxbot/config/config.yml"),
      "name: test-repo\n",
    );

    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );

    const rulesDir = resolve(workspacesDir, "alpha/.claude/rules");
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["danx-repo-config.md", ".danxbot/config/config.yml"],
      ["danx-repo-overview.md", ".danxbot/config/overview.md"],
      ["danx-repo-workflow.md", ".danxbot/config/workflow.md"],
      ["danx-issue-prefix.md", ".danxbot/config/config.yml#issue_prefix"],
      [
        "danx-effort-policy.md",
        ".danxbot/settings.json#effortLevels+effortAssignmentPrompt",
      ],
      ["danx-tools.md", ".danxbot/config/tools.md"],
    ];
    for (const [name, srcRel] of cases) {
      const out = readFileSync(resolve(rulesDir, name), "utf-8");
      expect(out.startsWith("<!-- AUTO-GENERATED by danxbot from ")).toBe(true);
      expect(out).toContain(srcRel);
      // No double-prepend — banner appears exactly once.
      expect(out.match(/AUTO-GENERATED by danxbot/g)?.length).toBe(1);
    }
  });

  it("DX-105: re-running the tick is idempotent (writer no-ops, source unchanged)", () => {
    const sourceOverview = "# Overview body\n";
    writeFileSync(resolve(danxbotConfigDir, "overview.md"), sourceOverview);
    writeFileSync(
      resolve(repoLocalPath, ".danxbot/config/config.yml"),
      "name: test-repo\n",
    );

    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );
    const first = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-repo-overview.md"),
      "utf-8",
    );
    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );
    const second = readFileSync(
      resolve(workspacesDir, "alpha/.claude/rules/danx-repo-overview.md"),
      "utf-8",
    );
    expect(second).toBe(first);
    // Source file content untouched after sync.
    expect(readFileSync(resolve(danxbotConfigDir, "overview.md"), "utf-8")).toBe(
      sourceOverview,
    );
  });

  it("renders the policy file into every workspace dir on a tick", () => {
    mkdirSync(resolve(workspacesDir, "beta"), { recursive: true });
    renderPerRepoFilesIntoWorkspaces(
      buildRepoContext(repoLocalPath),
      danxbotConfigDir,
      cfg,
      workspacesDir,
    );
    for (const ws of ["alpha", "beta"]) {
      const path = resolve(
        workspacesDir,
        ws,
        ".claude/rules/danx-effort-policy.md",
      );
      expect(readFileSync(path, "utf-8")).toContain("Pick the LOWEST");
    }
  });
});

describe("DX-105 — source sweep + chmod preservation", () => {
  // AC: "All 10 sync writers in syncRepoFiles funnel through
  // writeInjectedFile (no remaining bare copyFileSync/writeFileSync in
  // sync path)." The per-writer behavioral tests above cover the banner
  // shape, but a regression that reintroduces a bare `copyFileSync` in a
  // future writer could ship without breaking any of those — the
  // existing-writer tests would still pass while a NEW sibling writer
  // silently sheds its banner. Pin the AC statically as a source sweep
  // on the inject pipeline writer modules.
  it("contains no bare copyFileSync / writeFileSync calls in src/inject/per-repo-render.ts", () => {
    const src = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "per-repo-render.ts",
      ),
      "utf-8",
    );
    // Match a function call shape: `copyFileSync(` or `writeFileSync(`.
    // Imports are bare identifiers ending in `,` / `}` so the call-shape
    // regex skips the import block.
    expect(src).not.toMatch(/\bcopyFileSync\s*\(/);
    expect(src).not.toMatch(/\bwriteFileSync\s*\(/);
  });

  it("preserves the executable bit on tool scripts after migration to writeInjectedFile", () => {
    // `copyRepoToolScripts` migrated from `copyFileSync` to
    // `writeInjectedFile`, but the script files still need +x — the
    // helper itself does NOT chmod, so the caller must continue to.
    // Regression here would cause `bash <repo>/.claude/tools/<script>`
    // invocations from agents to silently fail.
    const tmpRoot = mkdtempSync(resolve(tmpdir(), "tools-chmod-test-"));
    const repoLocalPath = resolve(tmpRoot, "repo");
    const danxbotConfigDir = resolve(repoLocalPath, ".danxbot/config");
    const workspacesDir = resolve(repoLocalPath, ".danxbot/workspaces");
    const toolsSrcDir = resolve(danxbotConfigDir, "tools");
    mkdirSync(toolsSrcDir, { recursive: true });
    mkdirSync(resolve(workspacesDir, "alpha"), { recursive: true });
    writeFileSync(
      resolve(toolsSrcDir, "do-thing.sh"),
      "#!/usr/bin/env bash\necho hi\n",
    );
    try {
      renderPerRepoFilesIntoWorkspaces(
        buildRepoContext(repoLocalPath),
        danxbotConfigDir,
        { name: "test-repo", url: "u", runtime: "local", language: "ts" },
        workspacesDir,
      );
      const dest = resolve(
        workspacesDir,
        "alpha/.claude/tools/do-thing.sh",
      );
      const mode = statSync(dest).mode & 0o777;
      // chmod 0o755 is the inject-pipeline convention (see
      // `chmodExecutable` in `_shared/inject-utils.ts`). Assert owner +x.
      expect(mode & 0o100).toBe(0o100);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("copyFeatures — DX-105 per-tick rewrite", () => {
  let tmpRoot: string;
  let repoLocalPath: string;
  let danxbotConfigDir: string;
  let danxbotDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), "copy-features-test-"));
    repoLocalPath = resolve(tmpRoot, "repo");
    danxbotDir = resolve(repoLocalPath, ".danxbot");
    danxbotConfigDir = resolve(danxbotDir, "config");
    mkdirSync(danxbotConfigDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("is a no-op when the source .danxbot/features.md is absent", () => {
    expect(() => copyFeatures(danxbotConfigDir)).not.toThrow();
  });

  it("writes the destination on the first tick and re-writes (with banner) on a source edit — drops the existsSync(dest) bail", () => {
    // Source-of-truth lives at <repo>/.danxbot/features.md, NOT in the
    // generated copy. Pre-DX-105 a stale generated copy persisted forever
    // because of an `existsSync(dest)` bail; this test pins the new
    // contract: the writer mirrors source -> derived every tick.
    //
    // Caveat: `copyFeatures` writes to the danxbot install root's
    // `docs/features.md` (resolved via `projectRoot` from the test's
    // own module URL). Save + restore the file around the test so a
    // pre-existing checked-in copy survives.
    const installDocsFeatures = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
      "docs",
      "features.md",
    );
    const priorBackup = existsSync(installDocsFeatures)
      ? readFileSync(installDocsFeatures, "utf-8")
      : null;
    try {
      writeFileSync(resolve(danxbotDir, "features.md"), "# v1 features\n");
      copyFeatures(danxbotConfigDir);
      // Edit the source — second tick MUST re-mirror (no existsSync bail).
      writeFileSync(resolve(danxbotDir, "features.md"), "# v2 features\n");
      copyFeatures(danxbotConfigDir);

      const out = readFileSync(installDocsFeatures, "utf-8");
      expect(out).toContain("# v2 features");
      expect(out).toContain(".danxbot/features.md");
      expect(out.startsWith("<!-- AUTO-GENERATED by danxbot from ")).toBe(true);
    } finally {
      if (priorBackup === null) {
        rmSync(installDocsFeatures, { force: true });
      } else {
        writeFileSync(installDocsFeatures, priorBackup);
      }
    }
  });
});
