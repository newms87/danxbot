import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { healLocalYamls } from "./heal.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";

function buildIssue(
  overrides: Partial<Issue> & { id: string; status: IssueStatus },
): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    type: "Feature",
    title: `Title for ${overrides.id}`,
    description: "Body",
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    history: [],
    ...overrides,
  };
}

describe("healLocalYamls (ISS-133, Phase 3 — per-tick self-heal pass)", () => {
  let repoRoot: string;
  let openDir: string;
  let closedDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    closedDir = resolve(repoRoot, ".danxbot/issues/closed");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("moves an open Done YAML to closed/, removing the open copy", () => {
    const issue = buildIssue({ id: "ISS-95", status: "Done" });
    writeFileSync(resolve(openDir, "ISS-95.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot);

    expect(result.healed).toEqual([{ id: "ISS-95", status: "Done" }]);
    expect(result.errors).toEqual([]);
    expect(existsSync(resolve(openDir, "ISS-95.yml"))).toBe(false);
    expect(existsSync(resolve(closedDir, "ISS-95.yml"))).toBe(true);

    // Cancelled is the other terminal status — heal must handle it the
    // same way. Same-test coverage so a regression that only handles
    // "Done" trips this expectation.
    const cancelled = buildIssue({ id: "ISS-96", status: "Cancelled" });
    writeFileSync(resolve(openDir, "ISS-96.yml"), serializeIssue(cancelled));
    const second = healLocalYamls(repoRoot);
    expect(second.healed).toEqual([{ id: "ISS-96", status: "Cancelled" }]);
    expect(existsSync(resolve(openDir, "ISS-96.yml"))).toBe(false);
    expect(existsSync(resolve(closedDir, "ISS-96.yml"))).toBe(true);
  });

  it("is idempotent: closed/<id>.yml already present + no open/<id>.yml → empty result", () => {
    // Stage the post-heal end-state: file in closed/, nothing in open/.
    const issue = buildIssue({ id: "ISS-77", status: "Done" });
    writeFileSync(resolve(closedDir, "ISS-77.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot);

    // Heal scans `open/`; nothing eligible there. Closed/ is untouched.
    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(existsSync(resolve(closedDir, "ISS-77.yml"))).toBe(true);
  });

  it("overwrites a stale closed/<id>.yml with open content (open wins)", () => {
    // The "open wins" rule: a stale closed copy from a prior Done save
    // that the operator manually re-opened (and edited in open/) is
    // overwritten by the open copy on the next terminal save. Heal
    // inherits this rule from `persistAfterSync` — see the contract
    // comment in `moveToClosedIfTerminal`.
    const stale = buildIssue({
      id: "ISS-50",
      status: "Done",
      title: "Stale closed copy",
    });
    writeFileSync(resolve(closedDir, "ISS-50.yml"), serializeIssue(stale));

    const fresh = buildIssue({
      id: "ISS-50",
      status: "Done",
      title: "Fresh open copy",
    });
    writeFileSync(resolve(openDir, "ISS-50.yml"), serializeIssue(fresh));

    const result = healLocalYamls(repoRoot);

    expect(result.healed).toEqual([{ id: "ISS-50", status: "Done" }]);
    expect(existsSync(resolve(openDir, "ISS-50.yml"))).toBe(false);
    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-50.yml"), "utf-8"),
    );
    expect(reloaded.title).toBe("Fresh open copy");
  });

  it("does not touch non-terminal YAMLs (ToDo / In Progress / Needs Help / Needs Approval / blocked)", () => {
    const todo = buildIssue({ id: "ISS-1", status: "ToDo" });
    const inProgress = buildIssue({ id: "ISS-2", status: "In Progress" });
    const needsHelp = buildIssue({ id: "ISS-3", status: "Needs Help" });
    const needsApproval = buildIssue({ id: "ISS-4", status: "Needs Approval" });
    const blocked = buildIssue({
      id: "ISS-5",
      status: "ToDo",
      blocked: {
        reason: "Waiting on ISS-9",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-9"],
      },
    });

    for (const issue of [todo, inProgress, needsHelp, needsApproval, blocked]) {
      writeFileSync(resolve(openDir, `${issue.id}.yml`), serializeIssue(issue));
    }

    const result = healLocalYamls(repoRoot);

    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    for (const issue of [todo, inProgress, needsHelp, needsApproval, blocked]) {
      expect(
        existsSync(resolve(openDir, `${issue.id}.yml`)),
        `${issue.id}.yml should remain in open/`,
      ).toBe(true);
      expect(
        existsSync(resolve(closedDir, `${issue.id}.yml`)),
        `${issue.id}.yml should NOT appear in closed/`,
      ).toBe(false);
    }
  });

  it("returns malformed YAMLs in errors[] without crashing the pass — healthy siblings still move", () => {
    // Malformed YAML with a valid ISS-N filename. The pass must skip
    // this file and continue with the rest.
    writeFileSync(
      resolve(openDir, "ISS-66.yml"),
      "this: is: not: valid: yaml\n  - completely broken\n",
    );

    const healthy = buildIssue({ id: "ISS-67", status: "Done" });
    writeFileSync(resolve(openDir, "ISS-67.yml"), serializeIssue(healthy));

    const result = healLocalYamls(repoRoot);

    // Healthy sibling moved.
    expect(result.healed).toEqual([{ id: "ISS-67", status: "Done" }]);
    expect(existsSync(resolve(openDir, "ISS-67.yml"))).toBe(false);
    expect(existsSync(resolve(closedDir, "ISS-67.yml"))).toBe(true);

    // Malformed file stayed in open/, surfaced via `errors[]` so the
    // caller can log + emit dashboard events without re-reading the
    // file. Path is the absolute path of the offending YAML.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(resolve(openDir, "ISS-66.yml"));
    expect(result.errors[0].message.length).toBeGreaterThan(0);
    expect(existsSync(resolve(openDir, "ISS-66.yml"))).toBe(true);
  });

  it("clears stale dispatch{} on terminal cards before moving (defense against ISS-95-style stuck state)", () => {
    // The exact ISS-95 scenario: agent saved Done while a dispatch{}
    // block lingered (because runSync threw after persistAfterSync was
    // skipped). Heal must clear it so the closed copy is internally
    // consistent (a terminal card with a phantom dispatch is the
    // primary symptom of the bug ISS-130 fixes).
    const issue = buildIssue({
      id: "ISS-95",
      status: "Done",
      dispatch: {
        id: "phantom-dispatch-id",
        pid: 99999,
        host: "ghost-host",
        kind: "work",
        started_at: "2026-05-07T00:00:00.000Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-95.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot);

    expect(result.healed).toEqual([{ id: "ISS-95", status: "Done" }]);
    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-95.yml"), "utf-8"),
    );
    expect(reloaded.dispatch).toBeNull();
  });

  it("ignores files outside the ISS-N regex (drafts, dotfiles, non-yml)", () => {
    // A slug-shaped draft, a dotfile, and a non-yml file should all be
    // ignored. Pattern matches `epic-status` walker semantics.
    writeFileSync(resolve(openDir, "draft-card.yml"), "{}");
    writeFileSync(resolve(openDir, ".swp"), "");
    writeFileSync(resolve(openDir, "README.md"), "ignore me");

    const result = healLocalYamls(repoRoot);

    // No errors (we never tried to parse them) and no healed entries.
    expect(result).toEqual({ healed: [], errors: [] });
    expect(existsSync(resolve(openDir, "draft-card.yml"))).toBe(true);
  });

  it("returns empty result when the open/ dir does not exist (fresh repo)", () => {
    rmSync(openDir, { recursive: true, force: true });
    rmSync(closedDir, { recursive: true, force: true });
    const result = healLocalYamls(repoRoot);
    expect(result).toEqual({ healed: [], errors: [] });
  });
});
