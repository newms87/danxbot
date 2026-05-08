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

    expect(result.healed).toEqual([
      { id: "ISS-95", status: "Done", direction: "open-to-closed" },
    ]);
    expect(result.errors).toEqual([]);
    expect(existsSync(resolve(openDir, "ISS-95.yml"))).toBe(false);
    expect(existsSync(resolve(closedDir, "ISS-95.yml"))).toBe(true);

    // Cancelled is the other terminal status — heal must handle it the
    // same way. Same-test coverage so a regression that only handles
    // "Done" trips this expectation.
    const cancelled = buildIssue({ id: "ISS-96", status: "Cancelled" });
    writeFileSync(resolve(openDir, "ISS-96.yml"), serializeIssue(cancelled));
    const second = healLocalYamls(repoRoot);
    expect(second.healed).toEqual([
      { id: "ISS-96", status: "Cancelled", direction: "open-to-closed" },
    ]);
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

    expect(result.healed).toEqual([
      { id: "ISS-50", status: "Done", direction: "open-to-closed" },
    ]);
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
    expect(result.healed).toEqual([
      { id: "ISS-67", status: "Done", direction: "open-to-closed" },
    ]);
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

    expect(result.healed).toEqual([
      { id: "ISS-95", status: "Done", direction: "open-to-closed" },
    ]);
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

  // ----- DX-147 — history-append on real status delta only -----

  it("DX-147: typical open → closed move on a terminal YAML appends ZERO history entries (no fake state delta)", () => {
    // Status is already terminal — heal moves the file but doesn't
    // change the issue's state, so no `worker:heal` history entry
    // should be written. Per AC #3: "no filesystem-noise entries".
    const issue = buildIssue({ id: "ISS-77", status: "Done" });
    writeFileSync(resolve(openDir, "ISS-77.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot);
    expect(result.healed).toEqual([
      { id: "ISS-77", status: "Done", direction: "open-to-closed" },
    ]);

    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-77.yml"), "utf-8"),
    );
    expect(reloaded.history).toEqual([]);
  });

  it("DX-147: closed → open inverse heal (operator drifted status to ToDo) appends ONE worker:heal status_change entry", () => {
    // The card was once Done (now in closed/) but its status drifted
    // back to ToDo (operator manually edited or a stale write). Heal
    // must move it back to open/ AND record the reverse transition
    // attributed to `worker:heal`.
    const drifted = buildIssue({
      id: "ISS-50",
      status: "ToDo",
      // Prior status_change to Done lives in history — the inferred
      // `from` for the inverse-heal entry should pick this up rather
      // than blindly defaulting to "Done".
      history: [
        {
          timestamp: "2026-05-01T00:00:00.000Z",
          actor: "dispatch:abc",
          event: "status_change",
          from: "In Progress",
          to: "Done",
        },
      ],
    });
    writeFileSync(resolve(closedDir, "ISS-50.yml"), serializeIssue(drifted));

    const result = healLocalYamls(repoRoot);
    expect(result.healed).toEqual([
      { id: "ISS-50", status: "ToDo", direction: "closed-to-open" },
    ]);
    expect(result.errors).toEqual([]);

    // File moved back: present in open/, absent from closed/.
    expect(existsSync(resolve(openDir, "ISS-50.yml"))).toBe(true);
    expect(existsSync(resolve(closedDir, "ISS-50.yml"))).toBe(false);

    // History carries the prior dispatch entry plus a fresh
    // `worker:heal` status_change.
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-50.yml"), "utf-8"),
    );
    expect(reloaded.history).toHaveLength(2);
    const healEntry = reloaded.history[1];
    expect(healEntry.actor).toBe("worker:heal");
    expect(healEntry.event).toBe("status_change");
    expect(healEntry.from).toBe("Done");
    expect(healEntry.to).toBe("ToDo");
    expect(healEntry.note).toMatch(/closed/);
    expect(healEntry.note).toMatch(/open/);
    expect(Number.isFinite(Date.parse(healEntry.timestamp))).toBe(true);
  });

  it("DX-147: closed → open inverse heal defaults `from` to Done when history carries no prior terminal status", () => {
    // Legacy YAML — history is empty; we still need to satisfy
    // `appendHistory`'s status_change requires-from invariant. The
    // filename-location heuristic falls back to "Done".
    const drifted = buildIssue({
      id: "ISS-60",
      status: "Needs Help",
      history: [],
    });
    writeFileSync(resolve(closedDir, "ISS-60.yml"), serializeIssue(drifted));

    const result = healLocalYamls(repoRoot);
    expect(result.healed).toEqual([
      { id: "ISS-60", status: "Needs Help", direction: "closed-to-open" },
    ]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-60.yml"), "utf-8"),
    );
    expect(reloaded.history).toHaveLength(1);
    expect(reloaded.history[0].from).toBe("Done");
    expect(reloaded.history[0].to).toBe("Needs Help");
  });

  it("DX-147: closed YAML whose status is still terminal is a no-op (idempotency on the inverse pass)", () => {
    // Closed/ YAML with status: Done — file is in the right bucket.
    // The inverse pass must NOT touch it (no move, no history entry).
    const issue = buildIssue({ id: "ISS-200", status: "Done" });
    writeFileSync(resolve(closedDir, "ISS-200.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot);
    expect(result.healed).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-200.yml"), "utf-8"),
    );
    expect(reloaded.history).toEqual([]);
  });

  it("DX-147: closed → open inverse heal infers `from: Cancelled` from prior history", () => {
    // The most-recent-terminal walker has both Done and Cancelled
    // arms. Without a per-Cancelled test, a regression that hardcodes
    // `Done` everywhere ships silently. Pin the Cancelled arm with a
    // YAML whose only terminal `status_change` was to Cancelled.
    const drifted = buildIssue({
      id: "ISS-70",
      status: "ToDo",
      history: [
        {
          timestamp: "2026-04-01T00:00:00.000Z",
          actor: "dispatch:def",
          event: "status_change",
          from: "In Progress",
          to: "Cancelled",
        },
      ],
    });
    writeFileSync(resolve(closedDir, "ISS-70.yml"), serializeIssue(drifted));

    healLocalYamls(repoRoot);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-70.yml"), "utf-8"),
    );
    expect(reloaded.history).toHaveLength(2);
    const healEntry = reloaded.history[1];
    expect(healEntry.actor).toBe("worker:heal");
    expect(healEntry.from).toBe("Cancelled");
    expect(healEntry.to).toBe("ToDo");
  });

  it("DX-147: malformed YAML in closed/ is reported via errors[] and the inverse pass continues for healthy siblings", () => {
    // Drop one malformed and one drifted-status YAML in closed/. The
    // inverse pass must skip the bad file (push to `errors[]`) and
    // still recover the healthy sibling. Mirrors the open/ malformed
    // test at line 169.
    writeFileSync(
      resolve(closedDir, "ISS-80.yml"),
      "this: is: not: valid: yaml\n  - completely broken\n",
    );

    const drifted = buildIssue({ id: "ISS-81", status: "ToDo" });
    writeFileSync(resolve(closedDir, "ISS-81.yml"), serializeIssue(drifted));

    const result = healLocalYamls(repoRoot);

    expect(result.healed).toEqual([
      { id: "ISS-81", status: "ToDo", direction: "closed-to-open" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(resolve(closedDir, "ISS-80.yml"));
    expect(result.errors[0].message.length).toBeGreaterThan(0);

    expect(existsSync(resolve(closedDir, "ISS-80.yml"))).toBe(true);
    expect(existsSync(resolve(openDir, "ISS-81.yml"))).toBe(true);
    expect(existsSync(resolve(closedDir, "ISS-81.yml"))).toBe(false);
  });

  it("DX-147: inverse heal in closed/ ignores filenames outside the ISS-N regex", () => {
    // Mirrors the open/ regex-skip test at line 219. Slug-shaped
    // drafts and dotfiles in closed/ must not be touched by the
    // inverse pass — same `idRegex.test(stem)` guard.
    writeFileSync(resolve(closedDir, "draft-card.yml"), "{}");
    writeFileSync(resolve(closedDir, ".swp"), "");

    const result = healLocalYamls(repoRoot);

    expect(result).toEqual({ healed: [], errors: [] });
    expect(existsSync(resolve(closedDir, "draft-card.yml"))).toBe(true);
  });
});
