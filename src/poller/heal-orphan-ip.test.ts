/**
 * DX-329 — orphan In Progress heal pass.
 *
 * The pre-existing `healOrphanInvariantViolations` clears stale `dispatch`
 * blocks but never flips `status` back to `ToDo`. A card whose prior
 * dispatch ended in any terminal `DispatchStatus`
 * (`completed`/`failed`/`cancelled`/`recovered`/`throttled` per
 * `src/dashboard/dispatches.ts`) ends up stranded at `status: In Progress`
 * + `dispatch: null` — the picker filter requires `status === "ToDo"` and
 * never sees the card. This file pins the pure-function half of the new
 * heal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { healOrphanInProgress, runOrphanInProgressHeal } from "./heal.js";
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

  return merged;
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const NOW = Date.parse("2026-05-12T20:00:00Z");

function ipHistoryAt(timestamp: string) {
  return [
    {
      timestamp,
      actor: "dispatch:did-prior",
      event: "status_change" as const,
      from: "ToDo" as const,
      to: "In Progress" as const,
    },
  ];
}

describe("healOrphanInProgress — DX-329 orphan In Progress heal", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-orphan-ip-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // -------- AC #1: branch A — heal happens --------

  it("flips IP→ToDo on orphan card with no live dispatch and age > threshold", async () => {
    // Card flipped to IP 10 min ago, dispatch is null, no live row,
    // prior terminal was 'recovered' (the DX-246 stream-idle path).
    const orphan = buildIssue({
      id: "DX-310",
      status: "In Progress",
      assigned_agent: "phil",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-310.yml"), serializeIssue(orphan));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(["phil", "dani"]),
      priorTerminalStatusFor: (id) => (id === "DX-310" ? "recovered" : null),
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.scanned).toBe(1);
    expect(result.healed).toHaveLength(1);
    expect(result.healed[0]).toMatchObject({
      id: "DX-310",
      priorTerminalStatus: "recovered",
      agentPreserved: true,
      staleAgent: null,
    });
    expect(result.errors).toEqual([]);

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-310.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("ToDo");
    expect(reloaded.assigned_agent).toBe("phil");
    expect(reloaded.dispatch).toBeNull();
  });

  // -------- AC #4: comment shape --------

  it("appends a '## Auto-heal — flipped IP → ToDo' comment citing the prior terminal status", async () => {
    const orphan = buildIssue({
      id: "DX-311",
      status: "In Progress",
      assigned_agent: null,
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-311.yml"), serializeIssue(orphan));

    await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => "failed",
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-311.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.comments).toHaveLength(1);
    const comment = reloaded.comments[0];
    expect(comment.author).toBe("danxbot");
    expect(comment.text).toMatch(/^## Auto-heal — flipped IP → ToDo/);
    expect(comment.text).toMatch(/orphan dispatch/i);
    expect(comment.text).toMatch(/failed/);
  });

  it("uses 'never-dispatched' in the comment when no prior dispatch row exists", async () => {
    const orphan = buildIssue({
      id: "DX-312",
      status: "In Progress",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-312.yml"), serializeIssue(orphan));

    await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-312.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.comments[0].text).toMatch(/never-dispatched/);
  });

  // -------- worker:heal history entry --------

  it("appends a worker:heal status_change history entry (In Progress → ToDo)", async () => {
    const orphan = buildIssue({
      id: "DX-313",
      status: "In Progress",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-313.yml"), serializeIssue(orphan));

    await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => "completed",
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-313.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    // Original IP entry + new worker:heal entry.
    expect(reloaded.history).toHaveLength(2);
    const healEntry = reloaded.history[1];
    expect(healEntry.actor).toBe("worker:heal");
    expect(healEntry.event).toBe("status_change");
    expect(healEntry.from).toBe("In Progress");
    expect(healEntry.to).toBe("ToDo");
    expect(healEntry.note).toMatch(/orphan/);
  });

  // -------- AC #3 race guard: live dispatch row --------

  it("skips a card whose id is in liveIssueIds (mid-dispatch paired-write race guard)", async () => {
    const inFlight = buildIssue({
      id: "DX-400",
      status: "In Progress",
      assigned_agent: "phil",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-400.yml"), serializeIssue(inFlight));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(["DX-400"]),
      knownAgents: new Set(["phil"]),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-400.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("In Progress");
  });

  // -------- AC #3 race guard: age threshold --------

  it("skips a card whose age in IP is below the threshold (recent paired-write)", async () => {
    const recent = buildIssue({
      id: "DX-401",
      status: "In Progress",
      assigned_agent: "phil",
      // Flipped to IP 30 seconds ago — well below the 5 min threshold.
      history: ipHistoryAt(new Date(NOW - 30 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-401.yml"), serializeIssue(recent));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(["phil"]),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.scanned).toBe(1);
    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-401.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("In Progress");
  });

  // -------- assigned_agent preserve/clear: AC #3 --------

  it("preserves assigned_agent when the named agent still exists in the roster", async () => {
    const orphan = buildIssue({
      id: "DX-410",
      status: "In Progress",
      assigned_agent: "phil",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-410.yml"), serializeIssue(orphan));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(["phil", "dani"]),
      priorTerminalStatusFor: () => "recovered",
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed[0]).toMatchObject({
      id: "DX-410",
      agentPreserved: true,
      staleAgent: null,
    });
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-410.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.assigned_agent).toBe("phil");
  });

  it("clears assigned_agent when the named agent is missing from the roster (vanished persona)", async () => {
    const orphan = buildIssue({
      id: "DX-411",
      status: "In Progress",
      assigned_agent: "ghost",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-411.yml"), serializeIssue(orphan));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(["phil", "dani"]),
      priorTerminalStatusFor: () => "failed",
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed[0]).toMatchObject({
      id: "DX-411",
      agentPreserved: false,
      staleAgent: "ghost",
    });
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-411.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.assigned_agent).toBeNull();
  });

  // -------- ignore non-orphan shapes --------

  it("ignores ToDo cards", async () => {
    const todo = buildIssue({ id: "DX-500", status: "ToDo" });
    writeFileSync(resolve(openDir, "DX-500.yml"), serializeIssue(todo));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed).toEqual([]);
  });

  it("ignores IP cards that still carry a dispatch{} block (delegated to invariant heal)", async () => {
    const stillDispatching = buildIssue({
      id: "DX-501",
      status: "In Progress",
      dispatch: {
        id: "did-running",
        pid: 1234,
        host: "host-a",
        kind: "work",
        started_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
        ttl_seconds: 7200,
      },
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(
      resolve(openDir, "DX-501.yml"),
      serializeIssue(stillDispatching),
    );

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed).toEqual([]);
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-501.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("In Progress");
    expect(reloaded.dispatch).not.toBeNull();
  });

  // -------- idempotency --------

  it("is idempotent — second pass against an already-healed dir does nothing", async () => {
    const orphan = buildIssue({
      id: "DX-600",
      status: "In Progress",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-600.yml"), serializeIssue(orphan));

    const deps = {
      liveIssueIds: new Set<string>(),
      knownAgents: new Set<string>(),
      priorTerminalStatusFor: () => "recovered" as string,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    };
    const first = await healOrphanInProgress(repoRoot, "DX", deps);
    expect(first.healed).toHaveLength(1);

    const second = await healOrphanInProgress(repoRoot, "DX", deps);
    expect(second.healed).toEqual([]);
  });

  // -------- mtime fallback when history is silent --------

  it("falls back to file mtime when history carries no IP transition", async () => {
    // Card has empty history but file mtime is recent (just touched).
    // Without a fallback the heal would fire on every untimed card —
    // bad. With mtime fallback, recent files are protected.
    const fresh = buildIssue({
      id: "DX-700",
      status: "In Progress",
      history: [],
    });
    writeFileSync(resolve(openDir, "DX-700.yml"), serializeIssue(fresh));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      // Pretend "now" is the same instant the file was written — mtime
      // age ≈ 0 < threshold → skip.
      now: Date.now(),
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed).toEqual([]);
  });

  // -------- malformed YAMLs --------

  it("records parse errors and continues past them", async () => {
    writeFileSync(resolve(openDir, "DX-800.yml"), "not: valid: yaml: :::");
    const orphan = buildIssue({
      id: "DX-801",
      status: "In Progress",
      history: ipHistoryAt(new Date(NOW - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-801.yml"), serializeIssue(orphan));

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result.healed.map((h) => h.id)).toEqual(["DX-801"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("DX-800.yml")).toBe(true);
  });

  // -------- regex filter --------

  it("ignores files outside the <PREFIX>-N regex", async () => {
    writeFileSync(resolve(openDir, "draft-card.yml"), "{}");
    writeFileSync(resolve(openDir, ".swp"), "");
    writeFileSync(resolve(openDir, "README.md"), "ignore me");

    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });

    expect(result).toEqual({ scanned: 0, healed: [], errors: [] });
    expect(existsSync(resolve(openDir, "draft-card.yml"))).toBe(true);
  });

  // -------- empty open dir --------

  it("returns empty result when the open/ dir does not exist (fresh repo)", async () => {
    rmSync(openDir, { recursive: true, force: true });
    const result = await healOrphanInProgress(repoRoot, "DX", {
      liveIssueIds: new Set(),
      knownAgents: new Set(),
      priorTerminalStatusFor: () => null,
      now: NOW,
      ageThresholdMs: FIVE_MIN_MS,
    });
    expect(result).toEqual({ scanned: 0, healed: [], errors: [] });
  });
});

// -------------------------------------------------------------------
// Wrapper coverage — `runOrphanInProgressHeal` glue.
//
// AC #5 (DX-329) — "Wired into runInvariantHeal callsite in
// src/cron/sync-and-audit.ts so it runs once at boot AND every tick".
// The per-tick wiring is pinned in `src/cron/sync-and-audit.test.ts`;
// the boot wiring lives in `src/index.ts` and isn't directly mocked
// in `src/index.test.ts` (pre-existing pattern — `runInvariantHeal`'s
// boot call is also untested there). The wrapper tests below cover
// the contract independently: dep-bundle is consumed correctly, label
// + repo are threaded, and the pure heal runs end-to-end against a
// real tmpdir. Same wrapper is used by BOTH boot + per-tick callsites,
// so green here means the contract holds at both wiring points.
// -------------------------------------------------------------------

describe("runOrphanInProgressHeal — wrapper end-to-end (DX-329 AC #5)", () => {
  let repoRoot: string;
  let openDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-orphan-ip-wrap-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(resolve(repoRoot, ".danxbot/issues/closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const repoCtx = {
    name: "test-repo",
    localPath: "", // filled per-test
    issuePrefix: "DX",
  } as unknown as Parameters<typeof runOrphanInProgressHeal>[0];

  it("calls each dep exactly once with the repo's identifiers", async () => {
    repoCtx.localPath = repoRoot;
    const orphan = buildIssue({
      id: "DX-900",
      status: "In Progress",
      assigned_agent: "phil",
      history: ipHistoryAt(new Date(Date.now() - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-900.yml"), serializeIssue(orphan));

    const liveDispatchIssueIds = vi.fn().mockResolvedValue(new Set<string>());
    const lastTerminalDispatchStatusByIssue = vi
      .fn()
      .mockResolvedValue(new Map<string, string>([["DX-900", "recovered"]]));
    const readAgents = vi.fn().mockReturnValue([{ name: "phil" }]);

    await runOrphanInProgressHeal(repoCtx, "per-tick", {
      liveDispatchIssueIds,
      lastTerminalDispatchStatusByIssue,
      readAgents,
    });

    expect(liveDispatchIssueIds).toHaveBeenCalledWith("test-repo");
    expect(lastTerminalDispatchStatusByIssue).toHaveBeenCalledWith("test-repo");
    expect(readAgents).toHaveBeenCalledWith(repoRoot);

    // End-to-end: the orphan flipped to ToDo, `assigned_agent` preserved
    // (phil is in the roster), and the comment cites the prior status.
    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-900.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("ToDo");
    expect(reloaded.assigned_agent).toBe("phil");
    expect(reloaded.comments[0].text).toMatch(/recovered/);
  });

  it("swallows dep failures so a broken DB does not crash the cron tick", async () => {
    repoCtx.localPath = repoRoot;
    // liveDispatchIssueIds rejecting is the realistic failure mode
    // (transient PG outage). Wrapper must catch + log, not propagate.
    const liveDispatchIssueIds = vi
      .fn()
      .mockRejectedValue(new Error("PG connection refused"));
    const lastTerminalDispatchStatusByIssue = vi
      .fn()
      .mockResolvedValue(new Map<string, string>());
    const readAgents = vi.fn().mockReturnValue([]);

    await expect(
      runOrphanInProgressHeal(repoCtx, "boot", {
        liveDispatchIssueIds,
        lastTerminalDispatchStatusByIssue,
        readAgents,
      }),
    ).resolves.toBeUndefined();
  });

  it("clears assigned_agent at the wrapper layer when the agent is gone from the roster", async () => {
    repoCtx.localPath = repoRoot;
    const orphan = buildIssue({
      id: "DX-901",
      status: "In Progress",
      assigned_agent: "ghost",
      history: ipHistoryAt(new Date(Date.now() - 10 * 60 * 1000).toISOString()),
    });
    writeFileSync(resolve(openDir, "DX-901.yml"), serializeIssue(orphan));

    await runOrphanInProgressHeal(repoCtx, "per-tick", {
      liveDispatchIssueIds: vi.fn().mockResolvedValue(new Set()),
      lastTerminalDispatchStatusByIssue: vi
        .fn()
        .mockResolvedValue(new Map([["DX-901", "failed"]])),
      // Roster has phil but not ghost — orphan stamp should be cleared.
      readAgents: vi.fn().mockReturnValue([{ name: "phil" }]),
    });

    const reloaded = parseIssue(
      readFileSync(resolve(openDir, "DX-901.yml"), "utf-8"),
      { expectedPrefix: "DX" },
    );
    expect(reloaded.status).toBe("ToDo");
    expect(reloaded.assigned_agent).toBeNull();
  });
});
