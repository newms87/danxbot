import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  getReposBase,
  IDEATOR_PROMPT,
  loadTrelloIds,
  TEAM_PROMPT,
  TRIAGE_CARD_PROMPT,
} from "./constants.js";

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
    "  blocked: blk1",
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
    expect(ids.blockedLabelId).toBe("blk1");
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

  it("defaults needsApprovalListId and needsApprovalLabelId to '' when the trello.yml omits the rollout-optional keys", () => {
    // Phase 1 of the auto-triage epic adds Needs Approval as an OPTIONAL
    // tracker mapping during the rollout — existing repos predate the
    // line and must keep loading. Pin the empty-string default so a
    // future tightening to `req(...)` is caught here, not in production.
    writeYml(baseYml);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.needsApprovalListId).toBe("");
    expect(ids.needsApprovalLabelId).toBe("");
  });

  it("returns configured needsApprovalListId / needsApprovalLabelId when the operator has provisioned them", () => {
    writeYml([
      ...baseYml.slice(0, 7), // up through needs_help line
      "  needs_approval: na1",
      ...baseYml.slice(7), // done, cancelled, action_items, labels, ...
      "  needs_approval: nal1",
    ]);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.needsApprovalListId).toBe("na1");
    expect(ids.needsApprovalLabelId).toBe("nal1");
  });

  it("throws when trello.yml is absent", () => {
    // No writeYml call
    expect(() => loadTrelloIds(tempRepo)).toThrow(/Trello config not found/);
  });
});

describe("agent-mode prompts", () => {
  it("TEAM_PROMPT and IDEATOR_PROMPT are stable slash commands", () => {
    expect(TEAM_PROMPT).toBe("/danx-next");
    expect(IDEATOR_PROMPT).toBe("/danx-ideate");
  });

  describe("TRIAGE_CARD_PROMPT (per-card triage dispatch — ISS-94)", () => {
    it("returns a single-line slash-style command containing the issue id", () => {
      const prompt = TRIAGE_CARD_PROMPT("ISS-7");
      expect(prompt).toContain("ISS-7");
      expect(prompt.split("\n")).toHaveLength(1);
    });

    it("references the danx-triage-card skill so the dispatched agent loads the right per-status decision tree", () => {
      expect(TRIAGE_CARD_PROMPT("ISS-7")).toContain("danx-triage-card");
    });

    it("interpolates the id verbatim so the agent's first action — danx_issue_get — finds the card", () => {
      expect(TRIAGE_CARD_PROMPT("ISS-42")).toBe(
        "Triage card ISS-42 using the danx-triage-card skill.",
      );
    });
  });
});
