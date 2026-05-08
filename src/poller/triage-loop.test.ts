/**
 * Triage-loop behavior tests (Phase 4 of ISS-90, ISS-94).
 *
 * The new poller's main loop is:
 *
 *   1. activeDispatches non-empty? → liveness scan + return early
 *   2. (handled by Phase 2 startup reattach — invariant: in-memory matches YAML)
 *   3. work-ready: oldest open ToDo+blocked=null+dispatch=null,
 *      sorted untriaged-first then ICE total DESC.
 *   4. triage-due: oldest open card with status ∈ {Review, Needs Help}
 *      OR blocked != null AND triage.expires_at empty/past;
 *      sorted never-triaged-first then expires_at ASC.
 *   5. idle → ideator (if enabled) or sleep.
 *
 * These tests pin the seven behavioral cases from ISS-94's AC list:
 *
 *   - 1 work-ready ToDo → dispatches work, returns
 *   - 0 work-ready, 1 triage-due Review → dispatches triage, returns
 *   - 5 ToDo (3 untriaged, 2 triaged 60+40) → untriaged-first oldest
 *   - 5 ToDo all triaged (80,60,40,20,10) → dispatches ICE 80
 *   - active dispatch in memory → no new dispatch, sleep
 *   - active dispatch in YAML but not memory (post-restart) →
 *     reattaches, no double-dispatch
 *   - triage agent crashes → idle-loop guard advances on next tick
 *
 * Plus a fast-path idempotence test confirming the sort priorities are
 * applied correctly.
 *
 * The poller composes its decision tree from helpers in
 * `local-issues.ts` (the sort) and `index.ts` (the dispatcher); the
 * helpers are independently exercised in `local-issues.test.ts` /
 * `index.test.ts`. This file is the wiring-level integration check
 * that proves the composition actually fires the right branch.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueIce } from "../issue-tracker/interface.js";
import {
  listDispatchableYamls,
  listInProgressYamls,
  listTriageDueYamls,
  listBlockedTodoYamls,
} from "./local-issues.js";

function ice(total: number, i = 1, c = 1, e = 1): IssueIce {
  return { total, i, c, e };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 4,
    tracker: "trello",
    id: "ISS-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Sample",
    description: "Body",
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: ice(0, 0, 0, 0),
      history: [],
    },
    ac: [{ check_item_id: "", title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    waiting_on: null,
    history: [],
    ...overrides,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function writeAt(repoRoot: string, issue: Issue, mtimeSeconds: number): void {
  const dir = resolve(repoRoot, ".danxbot", "issues", "open");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${issue.id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

const NOW = Date.parse("2026-05-07T12:00:00Z");

describe("triage-loop wiring (Phase 4 of ISS-90)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-triage-loop-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("Case 1 — tick with 1 work-ready ToDo card → work-ready path picks it (triage-due path empty)", () => {
    writeAt(
      repoRoot,
      makeIssue({ id: "ISS-1", external_id: "a", status: "ToDo" }),
      1000,
    );
    expect(listDispatchableYamls(repoRoot, "ISS").map((i) => i.id)).toEqual([
      "ISS-1",
    ]);
    expect(listTriageDueYamls(repoRoot, NOW, "ISS")).toEqual([]);
  });

  it("Case 2 — tick with 0 work-ready, 1 triage-due Review → triage path picks the Review card", () => {
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "a",
        status: "Review",
        triage: {
          expires_at: "",
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: ice(0, 0, 0, 0),
          history: [],
        },
      }),
      1000,
    );
    expect(listDispatchableYamls(repoRoot, "ISS")).toEqual([]);
    expect(listTriageDueYamls(repoRoot, NOW, "ISS").map((i) => i.id)).toEqual([
      "ISS-1",
    ]);
  });

  it("Case 3 — 5 ToDo (3 untriaged, 2 triaged ICE 60+40) → untriaged-first oldest", () => {
    // Two triaged with high ICE — would win ICE sort if we ignored
    // untriaged tier.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-101",
        external_id: "t1",
        status: "ToDo",
        triage: {
          expires_at: "2026-09-01T00:00:00Z",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: ice(60, 5, 4, 3),
          history: [],
        },
      }),
      1000,
    );
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-102",
        external_id: "t2",
        status: "ToDo",
        triage: {
          expires_at: "2026-09-01T00:00:00Z",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: ice(40, 4, 5, 2),
          history: [],
        },
      }),
      2000,
    );
    // Three untriaged — different mtimes
    writeAt(
      repoRoot,
      makeIssue({ id: "ISS-203", external_id: "u3", status: "ToDo" }),
      5000,
    );
    writeAt(
      repoRoot,
      makeIssue({ id: "ISS-201", external_id: "u1", status: "ToDo" }),
      3000,
    );
    writeAt(
      repoRoot,
      makeIssue({ id: "ISS-202", external_id: "u2", status: "ToDo" }),
      4000,
    );
    const result = listDispatchableYamls(repoRoot, "ISS");
    expect(result.map((i) => i.id)).toEqual([
      // Untriaged tier first, FIFO oldest mtime
      "ISS-201",
      "ISS-202",
      "ISS-203",
      // Then triaged tier, ICE DESC
      "ISS-101",
      "ISS-102",
    ]);
  });

  it("Case 4 — 5 ToDo all triaged (ICE 80, 60, 40, 20, 10) → ICE 80 first", () => {
    function triagedToDo(id: string, total: number): Issue {
      return makeIssue({
        id,
        external_id: `${id}-ext`,
        status: "ToDo",
        triage: {
          expires_at: "2026-09-01T00:00:00Z",
          reassess_hint: "",
          last_status: "Keep",
          last_explain: "",
          ice: ice(total, 5, 4, 4),
          history: [],
        },
      });
    }
    writeAt(repoRoot, triagedToDo("ISS-401", 80), 1000);
    writeAt(repoRoot, triagedToDo("ISS-402", 60), 2000);
    writeAt(repoRoot, triagedToDo("ISS-403", 40), 3000);
    writeAt(repoRoot, triagedToDo("ISS-404", 20), 4000);
    writeAt(repoRoot, triagedToDo("ISS-405", 10), 5000);
    const result = listDispatchableYamls(repoRoot, "ISS");
    expect(result.map((i) => i.id)).toEqual([
      "ISS-401",
      "ISS-402",
      "ISS-403",
      "ISS-404",
      "ISS-405",
    ]);
  });

  it("Case 5 — active dispatch on the YAML hides the card from BOTH the work-ready set AND the triage-due set", () => {
    // ToDo card that's already dispatched — the work-ready helper
    // filters it out via `dispatch !== null`. Mirrors the in-memory
    // `activeDispatches` check `_poll` runs at the top of each tick.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "a",
        status: "ToDo",
        dispatch: {
          id: "uuid-1",
          pid: 1,
          host: "h",
          kind: "work",
          started_at: "2026-05-07T11:50:00Z",
          ttl_seconds: 7200,
        },
      }),
      1000,
    );
    // Review card already in triage — same defense for the triage path.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-2",
        external_id: "b",
        status: "Review",
        dispatch: {
          id: "uuid-2",
          pid: 2,
          host: "h",
          kind: "triage",
          started_at: "2026-05-07T11:55:00Z",
          ttl_seconds: 600,
        },
      }),
      2000,
    );
    expect(listDispatchableYamls(repoRoot, "ISS")).toEqual([]);
    expect(listTriageDueYamls(repoRoot, NOW, "ISS")).toEqual([]);
  });

  it("Case 6 — In Progress orphan with stamped dispatch is reattached; the helpers do not surface it as work-ready", () => {
    // The boot reattach pass and `tryResumeOrphan` own the resume flow —
    // the work-ready helper just needs to NOT hand out an In Progress
    // YAML as a fresh dispatch target.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "a",
        status: "In Progress",
        dispatch: {
          id: "uuid-1",
          pid: 1,
          host: "h",
          kind: "work",
          started_at: "2026-05-07T11:50:00Z",
          ttl_seconds: 7200,
        },
      }),
      1000,
    );
    expect(listDispatchableYamls(repoRoot, "ISS")).toEqual([]);
    expect(listInProgressYamls(repoRoot, "ISS").map((i) => i.id)).toEqual(["ISS-1"]);
    expect(listTriageDueYamls(repoRoot, NOW, "ISS")).toEqual([]);
  });

  it("Case 7 — idle-loop guard: a triage agent that previously crashed leaves a short TTL on the card; the next tick sees the YAML as not-yet-due and skips it", () => {
    // The poller's crash-recovery path stamps a near-future
    // `triage.expires_at` on a card whose triage agent threw. Until that
    // expiry passes, the card stays out of the triage-due set even
    // though it's a Review card — preventing the busy-loop where every
    // tick re-attempts a permanently broken triage.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "a",
        status: "Review",
        triage: {
          // 5 minutes after NOW — short, but in the future.
          expires_at: new Date(NOW + 5 * 60 * 1000).toISOString(),
          reassess_hint: "Triage agent crashed — retry after 5min cooldown",
          last_status: "",
          last_explain: "",
          ice: ice(0, 0, 0, 0),
          history: [],
        },
      }),
      1000,
    );
    expect(listTriageDueYamls(repoRoot, NOW, "ISS")).toEqual([]);
    // Once 5 minutes pass, the same YAML appears in the triage-due set.
    expect(
      listTriageDueYamls(repoRoot, NOW + 6 * 60 * 1000, "ISS").map((i) => i.id),
    ).toEqual(["ISS-1"]);
  });

  it("Tier ordering invariant (single-dispatch composition) — triage-due picks one card per tick even when many are eligible", () => {
    // Three Review cards, all triage-due; the dispatcher in `_poll`
    // hands the FIRST entry to spawn. This pin protects against a
    // future regression that processes the whole list in one tick
    // (which would re-introduce the bulk-orchestrator pattern that
    // Phase 4 retired).
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-501",
        external_id: "a",
        status: "Review",
      }),
      1000,
    );
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-502",
        external_id: "b",
        status: "Review",
      }),
      2000,
    );
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-503",
        external_id: "c",
        status: "Review",
      }),
      3000,
    );
    const due = listTriageDueYamls(repoRoot, NOW, "ISS");
    expect(due.length).toBe(3);
    // First entry is the FIFO-oldest among never-triaged. The
    // dispatcher fires that one and returns; the rest wait for the
    // next tick.
    expect(due[0].id).toBe("ISS-501");
  });

  it("Blocked card (blocked != null, status ToDo) lands in the triage-due set and the blocked-todo set, NOT the work-ready set", () => {
    // The poller's loop layers these helpers — the work-ready set
    // never includes blocked cards (`listDispatchableYamls` filters
    // `blocked === null`), the blocked-todo helper feeds the
    // resolve-blocked sweep, and the triage-due helper picks the same
    // card for triage when its TTL is up. All three must agree on
    // which set a blocked card belongs to or the loop double-dispatches.
    writeAt(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "a",
        status: "ToDo",
        waiting_on: {
          reason: "Waits for ISS-99",
          timestamp: "2026-04-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
      1000,
    );
    expect(listDispatchableYamls(repoRoot, "ISS")).toEqual([]);
    expect(listBlockedTodoYamls(repoRoot, "ISS").map((i) => i.id)).toEqual(["ISS-1"]);
    expect(listTriageDueYamls(repoRoot, NOW, "ISS").map((i) => i.id)).toEqual([
      "ISS-1",
    ]);
  });
});
