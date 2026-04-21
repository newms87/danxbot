import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getReposBase, loadTrelloIds } from "./constants.js";

describe("getReposBase", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DANXBOT_REPOS_BASE;
    delete process.env.DANXBOT_REPOS_BASE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DANXBOT_REPOS_BASE;
    } else {
      process.env.DANXBOT_REPOS_BASE = originalEnv;
    }
  });

  it("falls back to project-relative repos/ when DANXBOT_REPOS_BASE is not set", () => {
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
    expect(result).not.toBe("");
  });

  it("returns DANXBOT_REPOS_BASE override when set", () => {
    process.env.DANXBOT_REPOS_BASE = "/danxbot/repos";
    expect(getReposBase()).toBe("/danxbot/repos");
  });

  it("trims whitespace from DANXBOT_REPOS_BASE", () => {
    process.env.DANXBOT_REPOS_BASE = "  /danxbot/repos  ";
    expect(getReposBase()).toBe("/danxbot/repos");
  });

  it("ignores empty DANXBOT_REPOS_BASE and uses project-relative path", () => {
    process.env.DANXBOT_REPOS_BASE = "";
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
  });

  it("ignores whitespace-only DANXBOT_REPOS_BASE and uses project-relative path", () => {
    process.env.DANXBOT_REPOS_BASE = "   ";
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
  });
});

describe("loadTrelloIds", () => {
  let tempRepo: string;

  const baseYml = [
    "board_id: b1",
    "lists:",
    "  review: r1",
    "  todo: t1",
    "  in_progress: p1",
    "  needs_help: n1",
    "  done: d1",
    "  cancelled: c1",
    "  action_items: a1",
    "labels:",
    "  bug: bug1",
    "  feature: feat1",
    "  epic: ep1",
    "  needs_help: nh1",
  ];

  beforeEach(() => {
    tempRepo = mkdtempSync(resolve(tmpdir(), "danxbot-trello-"));
    mkdirSync(resolve(tempRepo, ".danxbot/config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  function writeYml(lines: string[]): void {
    writeFileSync(
      resolve(tempRepo, ".danxbot/config/trello.yml"),
      lines.join("\n") + "\n",
      "utf-8",
    );
  }

  it("returns all required label IDs", () => {
    writeYml(baseYml);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.bugLabelId).toBe("bug1");
    expect(ids.featureLabelId).toBe("feat1");
    expect(ids.epicLabelId).toBe("ep1");
    expect(ids.needsHelpLabelId).toBe("nh1");
  });

  it("returns triagedLabelId when labels.triaged is set", () => {
    writeYml([...baseYml, "  triaged: tri1"]);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.triagedLabelId).toBe("tri1");
  });

  it("returns triagedLabelId undefined when labels.triaged is absent (optional)", () => {
    writeYml(baseYml);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.triagedLabelId).toBeUndefined();
  });

  it("throws when a required label is missing", () => {
    const missingBug = baseYml.filter((line) => !line.includes("bug:"));
    writeYml(missingBug);
    expect(() => loadTrelloIds(tempRepo)).toThrow(/labels\.bug/);
  });

  it("throws when trello.yml is absent", () => {
    // No writeYml call
    expect(() => loadTrelloIds(tempRepo)).toThrow(/Trello config not found/);
  });
});
