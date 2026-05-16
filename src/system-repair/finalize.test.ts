/**
 * Tests for {@link finalizeSelfRepair} + the verdict parser.
 *
 * The finalize hook fires from `handleStop` AFTER every terminal
 * dispatch carrying an issueId. It is a no-op when the issueId does
 * not match a `system_error_repairs.card_id`; for matches it parses
 * the verdict from the `summary` keyword, reads the last `## Repair
 * Report` comment from the candidate's YAML, writes verdict +
 * report_md + ended_at on the repair row, then flips the linked
 * `system_errors` row based on the verdict.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DX-565: spy on the SSE fan-out so tests can keep asserting db.query
// call counts AND prove finalize fires the publish on terminal verdicts.
const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));
vi.mock("./publish.js", () => ({
  publishRepairErrorUpdated: publishSpy,
}));

import {
  parseVerdictFromSummary,
  computeErrorStatusFromVerdict,
  finalizeSelfRepair,
} from "./finalize.js";

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function mockPool(rows: object[][]): MockPool {
  const fn = vi.fn();
  for (const set of rows) fn.mockResolvedValueOnce({ rows: set });
  return { query: fn };
}

describe("parseVerdictFromSummary", () => {
  it("matches 'fixed' as a word in the first line", () => {
    expect(parseVerdictFromSummary("fixed: see retro")).toBe("fixed");
    expect(parseVerdictFromSummary("FIXED")).toBe("fixed");
    expect(parseVerdictFromSummary("Fixed the null-deref crash")).toBe("fixed");
  });

  it("matches 'unfixable' before 'fixed' (substring trap)", () => {
    expect(parseVerdictFromSummary("unfixable: stack outside our control")).toBe("unfixable");
  });

  it("accepts an explicit `VERDICT:` prefix", () => {
    expect(parseVerdictFromSummary("VERDICT: fixed")).toBe("fixed");
    expect(parseVerdictFromSummary("verdict:unfixable — vendor bug")).toBe("unfixable");
    expect(parseVerdictFromSummary("VERDICT: failed")).toBe("failed");
  });

  it("only scans the FIRST line — prose later in the summary does not flip the verdict", () => {
    expect(parseVerdictFromSummary("attempt failed: lib API changed\nNot unfixable; revisit later.")).toBe("failed");
    expect(parseVerdictFromSummary("fixed the bug\nnot unfixable after all")).toBe("fixed");
  });

  it("uses word boundaries — substring matches do not count", () => {
    // `prefixed` should not match `fixed`.
    expect(parseVerdictFromSummary("prefixed setup before retro")).toBe("failed");
    // `unfixable` only matches as a whole word.
    expect(parseVerdictFromSummary("nonunfixablesubstring")).toBe("failed");
  });

  it("defaults to 'failed' when first line has no verdict keyword", () => {
    expect(parseVerdictFromSummary("nothing useful here")).toBe("failed");
    expect(parseVerdictFromSummary("")).toBe("failed");
    expect(parseVerdictFromSummary(null)).toBe("failed");
  });
});

describe("computeErrorStatusFromVerdict (DX-566 Phase 6 cap)", () => {
  it("fixed → fixed regardless of attempt_n", () => {
    expect(computeErrorStatusFromVerdict("fixed", 1)).toBe("fixed");
    expect(computeErrorStatusFromVerdict("fixed", 3)).toBe("fixed");
  });
  it("unfixable (agent-declared) → unfixable regardless of attempt_n", () => {
    expect(computeErrorStatusFromVerdict("unfixable", 1)).toBe("unfixable");
    expect(computeErrorStatusFromVerdict("unfixable", 3)).toBe("unfixable");
  });
  it("failed + attempt_n < 3 → open (next tick retries)", () => {
    expect(computeErrorStatusFromVerdict("failed", 1)).toBe("open");
    expect(computeErrorStatusFromVerdict("failed", 2)).toBe("open");
  });
  it("failed + attempt_n >= 3 → unfixable (3-attempt cap)", () => {
    expect(computeErrorStatusFromVerdict("failed", 3)).toBe("unfixable");
    expect(computeErrorStatusFromVerdict("failed", 4)).toBe("unfixable");
  });
});

function writeCardYaml(repoLocalPath: string, id: string, comments: Array<{ author: string; text: string }>): void {
  const open = join(repoLocalPath, ".danxbot", "issues", "open");
  mkdirSync(open, { recursive: true });
  const yaml = [
    "schema_version: 9",
    'tracker: "memory"',
    `id: ${id}`,
    'external_id: ""',
    "parent_id: null",
    "children: []",
    "dispatch: null",
    "status: Done",
    "type: Bug",
    'title: "x"',
    'description: ""',
    "priority: 3",
    "position: null",
    "triage:",
    '  expires_at: ""',
    '  reassess_hint: ""',
    '  last_status: ""',
    '  last_explain: ""',
    "  ice: { total: 0, i: 0, c: 0, e: 0 }",
    "  history: []",
    "ac: []",
    "comments:",
    ...comments.flatMap((c, i) => [
      `  - id: c${i}`,
      `    author: ${c.author}`,
      "    timestamp: 2026-05-15T00:00:00Z",
      `    text: ${JSON.stringify(c.text)}`,
    ]),
    "retro: { good: '', bad: '', action_item_ids: [], commits: [] }",
    "assigned_agent: null",
    "waiting_on: null",
    "blocked: null",
    "requires_human: null",
    "conflict_on: []",
    "effort_level: medium",
    "history: []",
    "db_updated_at: 2026-05-15T00:00:00Z",
  ].join("\n");
  writeFileSync(join(open, `${id}.yml`), yaml);
}

describe("finalizeSelfRepair", () => {
  beforeEach(() => {
    publishSpy.mockReset();
    publishSpy.mockResolvedValue(undefined);
  });

  it("no-ops when no repair row matches the issueId", async () => {
    const db = mockPool([[]]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-700", summary: "fixed", repoLocalPath: "/nonexistent" });
    expect(result).toEqual({ kind: "no-match" });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("writes verdict + report_md + ended_at; flips error to 'fixed' on fixed verdict", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-700", [
      { author: "danxbot", text: "## Repair Report\n\nThe bug was a null deref in foo.ts. Patched." },
    ]);
    const db = mockPool([
      [{ id: 11, error_id: 7, attempt_n: 1, card_id: "DX-700", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-700", summary: "fixed", repoLocalPath });
    expect(result).toEqual({
      kind: "finalized",
      attemptId: 11,
      errorId: 7,
      verdict: "fixed",
      nextErrorStatus: "fixed",
    });
    expect(db.query).toHaveBeenCalledTimes(3);

    const [updateSql, updateParams] = db.query.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE system_error_repairs/);
    expect(updateSql).toMatch(/verdict = \$1/);
    expect(updateSql).toMatch(/report_md = \$2/);
    expect(updateSql).toMatch(/ended_at = NOW\(\)/);
    expect(updateParams[0]).toBe("fixed");
    expect(updateParams[1]).toContain("The bug was a null deref");
    expect(updateParams[2]).toBe(11);

    const [flipSql, flipParams] = db.query.mock.calls[2];
    expect(flipSql).toMatch(/UPDATE system_errors SET status = \$1/);
    expect(flipParams).toEqual(["fixed", 7]);
  });

  it("on unfixable verdict, flips error to 'unfixable'", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-701", []);
    const db = mockPool([
      [{ id: 12, error_id: 8, attempt_n: 3, card_id: "DX-701", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-701", summary: "unfixable: stack outside our control", repoLocalPath });
    expect(result).toEqual({
      kind: "finalized",
      attemptId: 12,
      errorId: 8,
      verdict: "unfixable",
      nextErrorStatus: "unfixable",
    });
    const [flipSql, flipParams] = db.query.mock.calls[2];
    expect(flipParams).toEqual(["unfixable", 8]);
  });

  it("DX-566: on failed verdict + attempt_n < 3, flips error back to 'open' so the next tick retries", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-702", []);
    const db = mockPool([
      [{ id: 13, error_id: 9, attempt_n: 2, card_id: "DX-702", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-702", summary: "failed: need more debug info", repoLocalPath });
    expect(result.kind).toBe("finalized");
    if (result.kind === "finalized") {
      expect(result.nextErrorStatus).toBe("open");
    }
    const [flipSql, flipParams] = db.query.mock.calls[2];
    expect(flipSql).toMatch(/UPDATE system_errors SET status = \$1/);
    expect(flipParams).toEqual(["open", 9]);
  });

  it("DX-566: on failed verdict + attempt_n >= 3, flips error to 'unfixable' (3-attempt cap)", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-712", []);
    const db = mockPool([
      [{ id: 23, error_id: 31, attempt_n: 3, card_id: "DX-712", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-712", summary: "failed: still broken after retry", repoLocalPath });
    expect(result.kind).toBe("finalized");
    if (result.kind === "finalized") {
      expect(result.nextErrorStatus).toBe("unfixable");
    }
    const [, flipParams] = db.query.mock.calls[2];
    expect(flipParams).toEqual(["unfixable", 31]);
  });

  it("DX-565: publishes the post-finalize snapshot on every terminal verdict", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-710", []);
    const db = mockPool([
      [{ id: 17, error_id: 21, attempt_n: 1, card_id: "DX-710", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    await finalizeSelfRepair({ db: db as any, issueId: "DX-710", summary: "fixed", repoLocalPath });
    expect(publishSpy).toHaveBeenCalledWith({ db: expect.anything(), errorId: 21 });
  });

  it("no-ops when the repair row is already ended_at (idempotent on duplicate calls)", async () => {
    const db = mockPool([[{ id: 14, error_id: 10, attempt_n: 1, card_id: "DX-703", dispatch_id: null, started_at: new Date(), ended_at: new Date(), verdict: "fixed", report_md: "x" }]]);
    const result = await finalizeSelfRepair({ db: db as any, issueId: "DX-703", summary: "fixed", repoLocalPath: "/nonexistent" });
    expect(result).toEqual({ kind: "already-finalized", attemptId: 14 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to summary when no Repair Report comment is on the card", async () => {
    const repoLocalPath = mkdtempSync(join(tmpdir(), "self-repair-finalize-"));
    writeCardYaml(repoLocalPath, "DX-704", [
      { author: "danxbot", text: "## Done\n\nNot a repair report." },
    ]);
    const db = mockPool([
      [{ id: 15, error_id: 11, attempt_n: 1, card_id: "DX-704", dispatch_id: null, started_at: new Date(), ended_at: null, verdict: null, report_md: null }],
      [],
      [],
    ]);
    await finalizeSelfRepair({ db: db as any, issueId: "DX-704", summary: "fixed: see retro", repoLocalPath });
    const [, params] = db.query.mock.calls[1];
    expect(params[1]).toBe("fixed: see retro");
  });
});
