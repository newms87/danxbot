import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepoContext } from "../types.js";
import {
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
      reviewListId: "",
      todoListId: "",
      inProgressListId: "",
      needsHelpListId: "",
      doneListId: "",
      cancelledListId: "",
      actionItemsListId: "",
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
    expect(rendered).toContain("Source: <repo>/.danxbot/settings.json");
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
