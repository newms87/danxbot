import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  getReposBase,
  IDEATOR_PROMPT,
  loadTrelloIds,
  TEAM_PROMPT,
  TEAM_PROMPT_RESUME,
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

  // DX-231 retired `needsApprovalListId` and `needsApprovalLabelId`
  // from `TrelloConfig`. Phase 3 (DX-234) introduces
  // `requiresHumanLabelId` as the orthogonal-indicator label. The
  // tests below pin both the new field's rollout-optional contract
  // (empty default) and the legacy-keys absence tolerance.

  it("requiresHumanLabelId returns the configured value when labels.requires_human is set (DX-234)", () => {
    writeYml([...baseYml, "  requires_human: rh1"]);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.requiresHumanLabelId).toBe("rh1");
  });

  it("requiresHumanLabelId defaults to '' when labels.requires_human is absent (rollout-optional)", () => {
    // Existing repos predate the line; the loader tolerates absence.
    // setLabels / projectLabels short-circuit on the empty value so
    // legacy boards stay no-op.
    writeYml(baseYml);
    const ids = loadTrelloIds(tempRepo);
    expect(ids.requiresHumanLabelId).toBe("");
  });

  it("loader tolerates trello.yml WITHOUT the legacy lists.needs_approval / labels.needs_approval keys (DX-234 AC)", () => {
    // baseYml contains neither legacy key — DX-232 dropped both reads
    // from loadTrelloIds. This test pins the AC: existing repo
    // trello.yml parses cleanly with no needs_approval rows present.
    writeYml(baseYml);
    expect(() => loadTrelloIds(tempRepo)).not.toThrow();
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

  // ISS-135 — orphan-resume callsite uses TEAM_PROMPT_RESUME instead
  // of TEAM_PROMPT so a future swap to a dedicated `/danx-resume`
  // slash command is a one-line edit. Today the value is identical
  // to TEAM_PROMPT (same /danx-next skill loads, the resume self-
  // check section lives inside it). Pin the value at its source so
  // a rename here does not silently pass the constants suite — the
  // index.test.ts mock is scaffolding, not a value assertion.
  it("TEAM_PROMPT_RESUME is /danx-next today (resume self-check ships in the danx-next skill)", () => {
    expect(TEAM_PROMPT_RESUME).toBe("/danx-next");
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
