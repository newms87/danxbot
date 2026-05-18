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
import {
  clearAssignedAgentOnDeletion,
  healLocalYamls,
  healOrphanInvariantViolations,
} from "./heal.js";
import type { LivenessDeps } from "./dispatch-liveness-yaml.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";

function buildIssue(
  overrides: Partial<Issue> & { id: string; status: IssueStatus },
): Issue {
  const merged: Issue = {
    schema_version: 12,
    tracker: "memory",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    type: "Feature",
    title: `Title for ${overrides.id}`,
    description: "Body",
    priority: 3.0,
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
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
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

    const result = healLocalYamls(repoRoot, "ISS");

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
    const second = healLocalYamls(repoRoot, "ISS");
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

    const result = healLocalYamls(repoRoot, "ISS");

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

    const result = healLocalYamls(repoRoot, "ISS");

    expect(result.healed).toEqual([
      { id: "ISS-50", status: "Done", direction: "open-to-closed" },
    ]);
    expect(existsSync(resolve(openDir, "ISS-50.yml"))).toBe(false);
    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-50.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.title).toBe("Fresh open copy");
  });

  it("does not touch non-terminal YAMLs (ToDo / In Progress / Blocked / waiting_on / requires_human)", () => {
    const todo = buildIssue({ id: "ISS-1", status: "ToDo" });
    const inProgress = buildIssue({ id: "ISS-2", status: "In Progress" });
    const needsHelp = buildIssue({ id: "ISS-3", status: "Blocked" });
    const blocked = buildIssue({
      id: "ISS-5",
      status: "ToDo",
      waiting_on: {
        reason: "Waiting on ISS-9",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-9"],
      },
    });
    // DX-231: a card with `requires_human != null` is a dispatch gate,
    // not a terminal state — heal must leave it in `open/`.
    const requiresHuman = buildIssue({
      id: "ISS-6",
      status: "ToDo",
      requires_human: {
        reason: "Need 3rd-party Stripe key rotation",
        steps: ["Rotate the Stripe secret"],
        set_by: "agent",
        set_at: "2026-05-10T12:00:00.000Z",
      },
    });

    for (const issue of [todo, inProgress, needsHelp, blocked, requiresHuman]) {
      writeFileSync(resolve(openDir, `${issue.id}.yml`), serializeIssue(issue));
    }

    const result = healLocalYamls(repoRoot, "ISS");

    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    for (const issue of [todo, inProgress, needsHelp, blocked, requiresHuman]) {
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

    const result = healLocalYamls(repoRoot, "ISS");

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

    const result = healLocalYamls(repoRoot, "ISS");

    expect(result.healed).toEqual([
      { id: "ISS-95", status: "Done", direction: "open-to-closed" },
    ]);
    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-95.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
  });

  it("ignores files outside the ISS-N regex (drafts, dotfiles, non-yml)", () => {
    // A slug-shaped draft, a dotfile, and a non-yml file should all be
    // ignored. Pattern matches `epic-status` walker semantics.
    writeFileSync(resolve(openDir, "draft-card.yml"), "{}");
    writeFileSync(resolve(openDir, ".swp"), "");
    writeFileSync(resolve(openDir, "README.md"), "ignore me");

    const result = healLocalYamls(repoRoot, "ISS");

    // No errors (we never tried to parse them) and no healed entries.
    expect(result).toEqual({ healed: [], errors: [] });
    expect(existsSync(resolve(openDir, "draft-card.yml"))).toBe(true);
  });

  it("returns empty result when the open/ dir does not exist (fresh repo)", () => {
    rmSync(openDir, { recursive: true, force: true });
    rmSync(closedDir, { recursive: true, force: true });
    const result = healLocalYamls(repoRoot, "ISS");
    expect(result).toEqual({ healed: [], errors: [] });
  });

  // ----- DX-147 — history-append on real status delta only -----

  it("DX-147: typical open → closed move on a terminal YAML appends ZERO history entries (no fake state delta)", () => {
    // Status is already terminal — heal moves the file but doesn't
    // change the issue's state, so no `worker:heal` history entry
    // should be written. Per AC #3: "no filesystem-noise entries".
    const issue = buildIssue({ id: "ISS-77", status: "Done" });
    writeFileSync(resolve(openDir, "ISS-77.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot, "ISS");
    expect(result.healed).toEqual([
      { id: "ISS-77", status: "Done", direction: "open-to-closed" },
    ]);

    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-77.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
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

    const result = healLocalYamls(repoRoot, "ISS");
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
      { expectedPrefix: "ISS" },
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
      status: "Blocked",
      history: [],
    });
    writeFileSync(resolve(closedDir, "ISS-60.yml"), serializeIssue(drifted));

    const result = healLocalYamls(repoRoot, "ISS");
    expect(result.healed).toEqual([
      { id: "ISS-60", status: "Blocked", direction: "closed-to-open" },
    ]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-60.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.history).toHaveLength(1);
    expect(reloaded.history[0].from).toBe("Done");
    expect(reloaded.history[0].to).toBe("Blocked");
  });

  it("DX-147: closed YAML whose status is still terminal is a no-op (idempotency on the inverse pass)", () => {
    // Closed/ YAML with status: Done — file is in the right bucket.
    // The inverse pass must NOT touch it (no move, no history entry).
    const issue = buildIssue({ id: "ISS-200", status: "Done" });
    writeFileSync(resolve(closedDir, "ISS-200.yml"), serializeIssue(issue));

    const result = healLocalYamls(repoRoot, "ISS");
    expect(result.healed).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(closedDir, "ISS-200.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
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

    healLocalYamls(repoRoot, "ISS");

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-70.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
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

    const result = healLocalYamls(repoRoot, "ISS");

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

    const result = healLocalYamls(repoRoot, "ISS");

    expect(result).toEqual({ healed: [], errors: [] });
    expect(existsSync(resolve(closedDir, "draft-card.yml"))).toBe(true);
  });
});

describe("clearAssignedAgentOnDeletion (DX-283 — agent delete cascade)", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-delete-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("clears assigned_agent on every open YAML matching the deleted agent name", async () => {
    const claimed1 = buildIssue({
      id: "ISS-400",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const claimed2 = buildIssue({
      id: "ISS-401",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const other = buildIssue({
      id: "ISS-402",
      status: "ToDo",
      assigned_agent: "murphy",
    });
    writeFileSync(resolve(openDir, "ISS-400.yml"), serializeIssue(claimed1));
    writeFileSync(resolve(openDir, "ISS-401.yml"), serializeIssue(claimed2));
    writeFileSync(resolve(openDir, "ISS-402.yml"), serializeIssue(other));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");

    expect(result.healed.map((h) => h.id).sort()).toEqual(["ISS-400", "ISS-401"]);
    expect(result.healed.every((h) => h.staleAgent === "phil")).toBe(true);

    const r400 = parseIssue(
      readFileSync(resolve(openDir, "ISS-400.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r402 = parseIssue(
      readFileSync(resolve(openDir, "ISS-402.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r400.assigned_agent).toBeNull();
    expect(r402.assigned_agent).toBe("murphy");
  });

  it("clears in-flight dispatch block alongside the assigned_agent (preserves the co-owned-fields invariant)", async () => {
    const inFlight = buildIssue({
      id: "ISS-403",
      status: "In Progress",
      assigned_agent: "phil",
      dispatch: {
        id: "did-1",
        pid: 0,
        host: "h",
        kind: "work" as const,
        started_at: "2026-05-01T00:00:00.000Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-403.yml"), serializeIssue(inFlight));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");

    expect(result.healed.map((h) => h.id)).toEqual(["ISS-403"]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-403.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBeNull();
    expect(reloaded.dispatch).toBeNull();
  });

  it("is idempotent — second invocation after a clean returns healed: []", async () => {
    const claimed = buildIssue({
      id: "ISS-404",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-404.yml"), serializeIssue(claimed));

    const first = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(first.healed).toHaveLength(1);

    const second = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(second.healed).toEqual([]);
  });

  it("ignores YAMLs naming a different agent", async () => {
    const claimedDani = buildIssue({
      id: "ISS-405",
      status: "ToDo",
      assigned_agent: "dani",
    });
    writeFileSync(resolve(openDir, "ISS-405.yml"), serializeIssue(claimedDani));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(result.healed).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-405.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBe("dani");
  });

  it("records parse errors and continues past them", async () => {
    writeFileSync(resolve(openDir, "ISS-406.yml"), "broken: :::");
    const claimed = buildIssue({
      id: "ISS-407",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-407.yml"), serializeIssue(claimed));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(result.healed.map((h) => h.id)).toEqual(["ISS-407"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("ISS-406.yml")).toBe(true);
  });
});

describe("healOrphanInvariantViolations — orphan dispatch scan (co-ownership retired)", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-invariant-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Default deps — current host matches the dispatch host, no PID is alive,
  // current time is far enough past every fixture's `started_at` that TTL
  // checks fall through to the PID branch (which always returns dead).
  const deps: LivenessDeps = {
    currentHost: "host-a",
    now: Date.parse("2026-05-11T08:00:00Z"),
    isPidAlive: () => false,
  };

  // Orphan pre-stamp. dispatch slot occupied with a dead PID and no
  // matching live process — scan clears the dispatch slot. assigned_agent
  // is preserved (durable audit) even though heal cleared dispatch.
  it("clears dispatch slot when PID is dead, preserving assigned_agent", async () => {
    const orphan = buildIssue({
      id: "ISS-286",
      status: "ToDo",
      assigned_agent: "phil",
      dispatch: {
        id: "did-orphan-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:08:27.171Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-286.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([
      {
        id: "ISS-286",
        kind: "dispatch-without-agent",
        staleAgent: null,
        staleDispatchId: "did-orphan-1",
        verdict: "dead-pid",
      },
    ]);
    expect(result.errors).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-286.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
    // assigned_agent persists — durable ownership audit.
    expect(reloaded.assigned_agent).toBe("phil");
  });

  // Co-ownership retired: a card with `assigned_agent: phil` and
  // blocked-with-assignment — agent set status:Blocked but did not null
  // assigned_agent. Operator rule: Blocked = agent declared "done from my
  // side"; staying assigned is invalid (picker's resume-owned-card path
  // would re-dispatch the same Blocked card every tick).
  it("clears assigned_agent when status is Blocked but agent stamp remains", async () => {
    const stuck = buildIssue({
      id: "ISS-901",
      status: "Blocked",
      assigned_agent: "dani",
      dispatch: null,
    });
    writeFileSync(resolve(openDir, "ISS-901.yml"), serializeIssue(stuck));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([
      {
        id: "ISS-901",
        kind: "blocked-with-assignment",
        staleAgent: "dani",
        staleDispatchId: null,
        verdict: null,
      },
    ]);
    expect(result.errors).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-901.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBeNull();
    expect(reloaded.status).toBe("Blocked");
    expect(reloaded.blocked).not.toBeNull();
  });

  // `dispatch: null` is the steady state after a dispatch ends. No
  // heal action.
  it("leaves cards with assigned_agent + null dispatch alone (steady state, not an orphan)", async () => {
    const idle = buildIssue({
      id: "ISS-300",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-300.yml"), serializeIssue(idle));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-300.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBe("phil");
    expect(reloaded.dispatch).toBeNull();
  });

  // Liveness gate — protects in-flight dispatches caught between
  // stampDispatchAndWrite and pairedWriteHostPid. The PID is alive on this
  // host AND the started_at + TTL has not expired, so leave the card alone.
  it("leaves dispatch-without-agent ALONE when the dispatch verdict is alive (in-flight paired-write)", async () => {
    const inflight = buildIssue({
      id: "ISS-287",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-live-1",
        pid: 4242,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-287.yml"), serializeIssue(inflight));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: (pid) => pid === 4242,
    });

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-287.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).not.toBeNull();
    expect(reloaded.dispatch!.pid).toBe(4242);
  });

  // Cross-host verdict still clears — a stamp from another host that has
  // no liveness coordinate from THIS worker must not lock the card forever.
  it("clears dispatch-without-agent when the dispatch verdict is cross-host", async () => {
    const orphan = buildIssue({
      id: "ISS-288",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-cross-1",
        pid: 5555,
        host: "host-b",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-288.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: () => true,
    });

    expect(result.healed[0]?.verdict).toBe("cross-host");
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-288.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
  });

  // TTL expiry — running PID but past the start_at + ttl_seconds budget.
  // The card is stuck and the YAML state is misleading; clear it.
  it("clears dispatch-without-agent when the dispatch verdict is dead-ttl", async () => {
    const orphan = buildIssue({
      id: "ISS-289",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-ttl-1",
        pid: 6666,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T00:00:00Z",
        ttl_seconds: 60,
      },
    });
    writeFileSync(resolve(openDir, "ISS-289.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: () => true,
    });

    expect(result.healed[0]?.verdict).toBe("dead-ttl");
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-289.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
  });

  // Invariant-respecting cards (both null OR both non-null) are left
  // alone. The scan does not touch healthy in-flight dispatches.
  it("leaves invariant-respecting cards untouched (both-null and both-non-null)", async () => {
    const cleanIdle = buildIssue({
      id: "ISS-290",
      status: "ToDo",
      assigned_agent: null,
      dispatch: null,
    });
    const cleanInFlight = buildIssue({
      id: "ISS-291",
      status: "In Progress",
      assigned_agent: "murphy",
      dispatch: {
        id: "did-running-1",
        pid: 7777,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-290.yml"), serializeIssue(cleanIdle));
    writeFileSync(
      resolve(openDir, "ISS-291.yml"),
      serializeIssue(cleanInFlight),
    );

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: (pid) => pid === 7777,
    });

    expect(result.scanned).toBe(2);
    expect(result.healed).toEqual([]);
    const r290 = parseIssue(
      readFileSync(resolve(openDir, "ISS-290.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r291 = parseIssue(
      readFileSync(resolve(openDir, "ISS-291.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r290.assigned_agent).toBeNull();
    expect(r290.dispatch).toBeNull();
    expect(r291.assigned_agent).toBe("murphy");
    expect(r291.dispatch).not.toBeNull();
  });

  // Idempotent — second invocation against an already-healed dir is a
  // no-op. Important because the per-tick wiring will run this scan on
  // every poll interval.
  it("is idempotent — re-running on a clean dir returns healed: []", async () => {
    const orphan = buildIssue({
      id: "ISS-292",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-idempotent-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-292.yml"), serializeIssue(orphan));

    const first = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(first.healed).toHaveLength(1);

    const second = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(second.healed).toEqual([]);
  });

  // Co-ownership retired: `assigned_agent: phil + dispatch: null` is
  // the steady state after a dispatch ends and is left alone. Only the
  // orphan-pre-stamp shape (dispatch set, dead) is healed.
  it("heals only orphan-pre-stamp; leaves steady-state idle owners alone", async () => {
    const idleOwner = buildIssue({
      id: "ISS-293",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const orphanPreStamp = buildIssue({
      id: "ISS-294",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-mixed-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-293.yml"), serializeIssue(idleOwner));
    writeFileSync(resolve(openDir, "ISS-294.yml"), serializeIssue(orphanPreStamp));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    const byKind = result.healed.reduce(
      (acc, h) => {
        acc[h.kind] = (acc[h.kind] ?? []).concat(h.id);
        return acc;
      },
      {} as Record<string, string[]>,
    );
    expect(byKind["agent-without-dispatch"]).toBeUndefined();
    expect(byKind["dispatch-without-agent"]).toEqual(["ISS-294"]);

    const r293 = parseIssue(
      readFileSync(resolve(openDir, "ISS-293.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r294 = parseIssue(
      readFileSync(resolve(openDir, "ISS-294.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r293.assigned_agent).toBe("phil");
    expect(r293.dispatch).toBeNull();
    expect(r294.assigned_agent).toBeNull();
    expect(r294.dispatch).toBeNull();
  });

  it("records parse errors and continues past them", async () => {
    writeFileSync(resolve(openDir, "ISS-295.yml"), "not: valid: yaml: :::");
    const orphan = buildIssue({
      id: "ISS-296",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-after-bad-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-296.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.healed.map((h) => h.id)).toEqual(["ISS-296"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("ISS-295.yml")).toBe(true);
  });

  // AC #3 — boot reattach should find ZERO orphans on a healthy worker.
  // Verified at the heal level: after the scan, no card carries a
  // dispatch{} block whose verdict would later trip
  // `buildReattachPlan(...).cleared` — equivalent to "no dead-pid log
  // line on next boot."
  it("AC #3: post-scan, no card carries a dispatch{} block that boot reattach would clear", async () => {
    const orphans = [
      { id: "ISS-260", agent: null, pid: 0 },
      { id: "ISS-262", agent: null, pid: 0 },
      { id: "ISS-264", agent: null, pid: 0 },
      { id: "ISS-265", agent: null, pid: 0 },
      { id: "ISS-276", agent: null, pid: 0 },
      { id: "ISS-281", agent: null, pid: 0 },
    ];
    for (const o of orphans) {
      const issue = buildIssue({
        id: o.id,
        status: "ToDo",
        assigned_agent: o.agent,
        dispatch: {
          id: `did-${o.id}`,
          pid: o.pid,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      });
      writeFileSync(resolve(openDir, `${o.id}.yml`), serializeIssue(issue));
    }

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(result.healed).toHaveLength(orphans.length);

    // Verify zero dispatch{} blocks remain that boot reattach would
    // re-clear (i.e. zero "verdict=dead-pid" log lines on next boot).
    for (const o of orphans) {
      const reloaded = parseIssue(
        readFileSync(resolve(openDir, `${o.id}.yml`), "utf-8"),
        { expectedPrefix: "ISS" },
      );
      expect(reloaded.dispatch).toBeNull();
      expect(reloaded.assigned_agent).toBeNull();
    }
  });
});

describe("clearAssignedAgentOnDeletion (DX-283 — agent delete cascade)", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-delete-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("clears assigned_agent on every open YAML matching the deleted agent name", async () => {
    const claimed1 = buildIssue({
      id: "ISS-400",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const claimed2 = buildIssue({
      id: "ISS-401",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const other = buildIssue({
      id: "ISS-402",
      status: "ToDo",
      assigned_agent: "murphy",
    });
    writeFileSync(resolve(openDir, "ISS-400.yml"), serializeIssue(claimed1));
    writeFileSync(resolve(openDir, "ISS-401.yml"), serializeIssue(claimed2));
    writeFileSync(resolve(openDir, "ISS-402.yml"), serializeIssue(other));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");

    expect(result.healed.map((h) => h.id).sort()).toEqual(["ISS-400", "ISS-401"]);
    expect(result.healed.every((h) => h.staleAgent === "phil")).toBe(true);

    const r400 = parseIssue(
      readFileSync(resolve(openDir, "ISS-400.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r402 = parseIssue(
      readFileSync(resolve(openDir, "ISS-402.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r400.assigned_agent).toBeNull();
    expect(r402.assigned_agent).toBe("murphy");
  });

  it("clears in-flight dispatch block alongside the assigned_agent (preserves the co-owned-fields invariant)", async () => {
    const inFlight = buildIssue({
      id: "ISS-403",
      status: "In Progress",
      assigned_agent: "phil",
      dispatch: {
        id: "did-1",
        pid: 0,
        host: "h",
        kind: "work" as const,
        started_at: "2026-05-01T00:00:00.000Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-403.yml"), serializeIssue(inFlight));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");

    expect(result.healed.map((h) => h.id)).toEqual(["ISS-403"]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-403.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBeNull();
    expect(reloaded.dispatch).toBeNull();
  });

  it("is idempotent — second invocation after a clean returns healed: []", async () => {
    const claimed = buildIssue({
      id: "ISS-404",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-404.yml"), serializeIssue(claimed));

    const first = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(first.healed).toHaveLength(1);

    const second = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(second.healed).toEqual([]);
  });

  it("ignores YAMLs naming a different agent", async () => {
    const claimedDani = buildIssue({
      id: "ISS-405",
      status: "ToDo",
      assigned_agent: "dani",
    });
    writeFileSync(resolve(openDir, "ISS-405.yml"), serializeIssue(claimedDani));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(result.healed).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-405.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBe("dani");
  });

  it("records parse errors and continues past them", async () => {
    writeFileSync(resolve(openDir, "ISS-406.yml"), "broken: :::");
    const claimed = buildIssue({
      id: "ISS-407",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-407.yml"), serializeIssue(claimed));

    const result = await clearAssignedAgentOnDeletion(repoRoot, "ISS", "phil");
    expect(result.healed.map((h) => h.id)).toEqual(["ISS-407"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("ISS-406.yml")).toBe(true);
  });
});

describe("healOrphanInvariantViolations — orphan dispatch scan (co-ownership retired)", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-invariant-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // Default deps — current host matches the dispatch host, no PID is alive,
  // current time is far enough past every fixture's `started_at` that TTL
  // checks fall through to the PID branch (which always returns dead).
  const deps: LivenessDeps = {
    currentHost: "host-a",
    now: Date.parse("2026-05-11T08:00:00Z"),
    isPidAlive: () => false,
  };

  // Orphan pre-stamp duplicate-block coverage (this test file has a
  // second `describe` mirror — preserve the same assertions).
  it("clears dispatch slot when PID is dead, preserving assigned_agent (mirror)", async () => {
    const orphan = buildIssue({
      id: "ISS-286",
      status: "ToDo",
      assigned_agent: "phil",
      dispatch: {
        id: "did-orphan-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:08:27.171Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-286.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([
      {
        id: "ISS-286",
        kind: "dispatch-without-agent",
        staleAgent: null,
        staleDispatchId: "did-orphan-1",
        verdict: "dead-pid",
      },
    ]);
    expect(result.errors).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-286.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
    expect(reloaded.assigned_agent).toBe("phil");
  });

  it("leaves cards with assigned_agent + null dispatch alone (steady state, mirror)", async () => {
    const idle = buildIssue({
      id: "ISS-300",
      status: "ToDo",
      assigned_agent: "phil",
    });
    writeFileSync(resolve(openDir, "ISS-300.yml"), serializeIssue(idle));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-300.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.assigned_agent).toBe("phil");
    expect(reloaded.dispatch).toBeNull();
  });

  // Liveness gate — protects in-flight dispatches caught between
  // stampDispatchAndWrite and pairedWriteHostPid. The PID is alive on this
  // host AND the started_at + TTL has not expired, so leave the card alone.
  it("leaves dispatch-without-agent ALONE when the dispatch verdict is alive (in-flight paired-write)", async () => {
    const inflight = buildIssue({
      id: "ISS-287",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-live-1",
        pid: 4242,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-287.yml"), serializeIssue(inflight));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: (pid) => pid === 4242,
    });

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-287.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).not.toBeNull();
    expect(reloaded.dispatch!.pid).toBe(4242);
  });

  // Cross-host verdict still clears — a stamp from another host that has
  // no liveness coordinate from THIS worker must not lock the card forever.
  it("clears dispatch-without-agent when the dispatch verdict is cross-host", async () => {
    const orphan = buildIssue({
      id: "ISS-288",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-cross-1",
        pid: 5555,
        host: "host-b",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-288.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: () => true,
    });

    expect(result.healed[0]?.verdict).toBe("cross-host");
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-288.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
  });

  // TTL expiry — running PID but past the start_at + ttl_seconds budget.
  // The card is stuck and the YAML state is misleading; clear it.
  it("clears dispatch-without-agent when the dispatch verdict is dead-ttl", async () => {
    const orphan = buildIssue({
      id: "ISS-289",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-ttl-1",
        pid: 6666,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T00:00:00Z",
        ttl_seconds: 60,
      },
    });
    writeFileSync(resolve(openDir, "ISS-289.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: () => true,
    });

    expect(result.healed[0]?.verdict).toBe("dead-ttl");
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "ISS-289.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(reloaded.dispatch).toBeNull();
  });

  // Invariant-respecting cards (both null OR both non-null) are left
  // alone. The scan does not touch healthy in-flight dispatches.
  it("leaves invariant-respecting cards untouched (both-null and both-non-null)", async () => {
    const cleanIdle = buildIssue({
      id: "ISS-290",
      status: "ToDo",
      assigned_agent: null,
      dispatch: null,
    });
    const cleanInFlight = buildIssue({
      id: "ISS-291",
      status: "In Progress",
      assigned_agent: "murphy",
      dispatch: {
        id: "did-running-1",
        pid: 7777,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-290.yml"), serializeIssue(cleanIdle));
    writeFileSync(
      resolve(openDir, "ISS-291.yml"),
      serializeIssue(cleanInFlight),
    );

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", {
      currentHost: "host-a",
      now: Date.parse("2026-05-11T08:00:00Z"),
      isPidAlive: (pid) => pid === 7777,
    });

    expect(result.scanned).toBe(2);
    expect(result.healed).toEqual([]);
    const r290 = parseIssue(
      readFileSync(resolve(openDir, "ISS-290.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r291 = parseIssue(
      readFileSync(resolve(openDir, "ISS-291.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r290.assigned_agent).toBeNull();
    expect(r290.dispatch).toBeNull();
    expect(r291.assigned_agent).toBe("murphy");
    expect(r291.dispatch).not.toBeNull();
  });

  // Idempotent — second invocation against an already-healed dir is a
  // no-op. Important because the per-tick wiring will run this scan on
  // every poll interval.
  it("is idempotent — re-running on a clean dir returns healed: []", async () => {
    const orphan = buildIssue({
      id: "ISS-292",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-idempotent-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-292.yml"), serializeIssue(orphan));

    const first = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(first.healed).toHaveLength(1);

    const second = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(second.healed).toEqual([]);
  });

  // Co-ownership retired: `assigned_agent: phil + dispatch: null` is
  // the steady state after a dispatch ends and is left alone. Only the
  // orphan-pre-stamp shape (dispatch set, dead) is healed.
  it("heals only orphan-pre-stamp; leaves steady-state idle owners alone", async () => {
    const idleOwner = buildIssue({
      id: "ISS-293",
      status: "ToDo",
      assigned_agent: "phil",
    });
    const orphanPreStamp = buildIssue({
      id: "ISS-294",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-mixed-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-293.yml"), serializeIssue(idleOwner));
    writeFileSync(resolve(openDir, "ISS-294.yml"), serializeIssue(orphanPreStamp));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    const byKind = result.healed.reduce(
      (acc, h) => {
        acc[h.kind] = (acc[h.kind] ?? []).concat(h.id);
        return acc;
      },
      {} as Record<string, string[]>,
    );
    expect(byKind["agent-without-dispatch"]).toBeUndefined();
    expect(byKind["dispatch-without-agent"]).toEqual(["ISS-294"]);

    const r293 = parseIssue(
      readFileSync(resolve(openDir, "ISS-293.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    const r294 = parseIssue(
      readFileSync(resolve(openDir, "ISS-294.yml"), "utf-8"),
      { expectedPrefix: "ISS" },
    );
    expect(r293.assigned_agent).toBe("phil");
    expect(r293.dispatch).toBeNull();
    expect(r294.assigned_agent).toBeNull();
    expect(r294.dispatch).toBeNull();
  });

  it("records parse errors and continues past them", async () => {
    writeFileSync(resolve(openDir, "ISS-295.yml"), "not: valid: yaml: :::");
    const orphan = buildIssue({
      id: "ISS-296",
      status: "ToDo",
      assigned_agent: null,
      dispatch: {
        id: "did-after-bad-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    });
    writeFileSync(resolve(openDir, "ISS-296.yml"), serializeIssue(orphan));

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);

    expect(result.healed.map((h) => h.id)).toEqual(["ISS-296"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("ISS-295.yml")).toBe(true);
  });

  // AC #3 — boot reattach should find ZERO orphans on a healthy worker.
  // Verified at the heal level: after the scan, no card carries a
  // dispatch{} block whose verdict would later trip
  // `buildReattachPlan(...).cleared` — equivalent to "no dead-pid log
  // line on next boot."
  it("AC #3: post-scan, no card carries a dispatch{} block that boot reattach would clear", async () => {
    const orphans = [
      { id: "ISS-260", agent: null, pid: 0 },
      { id: "ISS-262", agent: null, pid: 0 },
      { id: "ISS-264", agent: null, pid: 0 },
      { id: "ISS-265", agent: null, pid: 0 },
      { id: "ISS-276", agent: null, pid: 0 },
      { id: "ISS-281", agent: null, pid: 0 },
    ];
    for (const o of orphans) {
      const issue = buildIssue({
        id: o.id,
        status: "ToDo",
        assigned_agent: o.agent,
        dispatch: {
          id: `did-${o.id}`,
          pid: o.pid,
          host: "host-a",
          kind: "work",
          started_at: "2026-05-11T07:00:00Z",
          ttl_seconds: 7200,
        },
      });
      writeFileSync(resolve(openDir, `${o.id}.yml`), serializeIssue(issue));
    }

    const result = await healOrphanInvariantViolations(repoRoot, "ISS", deps);
    expect(result.healed).toHaveLength(orphans.length);

    // Verify zero dispatch{} blocks remain that boot reattach would
    // re-clear (i.e. zero "verdict=dead-pid" log lines on next boot).
    for (const o of orphans) {
      const reloaded = parseIssue(
        readFileSync(resolve(openDir, `${o.id}.yml`), "utf-8"),
        { expectedPrefix: "ISS" },
      );
      expect(reloaded.dispatch).toBeNull();
      expect(reloaded.assigned_agent).toBeNull();
    }
  });
});
