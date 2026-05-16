/**
 * Fan-out coverage for `publish-issue-update.ts`.
 *
 * Mocks `dbListAllIssues` so the test fixture is process-local. Each test
 * sets up a small repo (3–5 cards), invokes the publisher with one
 * authoritative change, and asserts on the sequence of bus events:
 *   1. the changed card publishes with its projected `IssueListItem`,
 *   2. every other card that references the changed id ALSO publishes
 *      with a freshly-projected item carrying the post-change effective
 *      state.
 *
 * The user-visible bug this exists to lock down: DX-582 → Done must
 * cause DX-584's effective `waiting_on` to flip false in the SSE feed
 * without requiring a refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus, WaitingOn } from "../issue-tracker/interface.js";
import type { DbIssueRow } from "../poller/issues-db.js";
import type { BusEvent } from "./event-bus.js";

let dbRows: DbIssueRow[] = [];

vi.mock("../poller/issues-db.js", () => ({
  dbListAllIssues: vi.fn(async () => dbRows),
}));

import {
  publishIssueRemoved,
  publishIssueUpsert,
} from "./publish-issue-update.js";

function mkIssue(
  id: string,
  status: IssueStatus,
  overrides: Partial<Issue> = {},
): Issue {
  const base = createEmptyIssue({
    id,
    title: `Card ${id}`,
    description: "",
    status,
    type: "Feature",
  });
  return { ...base, ...overrides };
}

function mkRow(issue: Issue, mtimeMs = 0): DbIssueRow {
  return { issue, mirrorUpdatedAtMs: mtimeMs };
}

function mkWaitingOn(by: string[]): WaitingOn {
  return { reason: "needs " + by.join(", "), timestamp: "", by };
}

interface TestBus {
  events: BusEvent[];
  publish: (e: BusEvent) => void;
}

function makeBus(): TestBus {
  const events: BusEvent[] = [];
  return { events, publish: (e) => events.push(e) };
}

beforeEach(() => {
  dbRows = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("publishIssueUpsert — fan-out", () => {
  it("emits projected item for the changed card alone when no other card references it", async () => {
    const lone = mkIssue("DX-1", "ToDo");
    dbRows = [mkRow(lone)];
    const bus = makeBus();

    await publishIssueUpsert("danxbot", lone, 100, bus);

    expect(bus.events).toHaveLength(1);
    const evt = bus.events[0];
    if (evt.topic !== "issue:updated") throw new Error("topic");
    if ("removed" in evt.data && evt.data.removed) throw new Error("variant");
    expect(evt.data.id).toBe("DX-1");
    expect(evt.data.item.title).toBe("Card DX-1");
  });

  it("re-emits a waiting card when its declared dependency transitions to Done", async () => {
    // DX-582 originally ToDo; DX-584 declared `waiting_on.by = [DX-582]`
    // at the time it was created. When DX-582 flips Done the publish
    // should emit BOTH DX-582 (with the new Done state) AND DX-584
    // (with effective `waiting_on === false` because the dep is now
    // terminal). This is the canonical user-reported regression: the
    // pill must clear without a refresh.
    const blocker = mkIssue("DX-582", "Done");
    const waiter = mkIssue("DX-584", "In Progress", {
      waiting_on: mkWaitingOn(["DX-582"]),
    });
    dbRows = [mkRow(blocker), mkRow(waiter)];
    const bus = makeBus();

    await publishIssueUpsert("danxbot", blocker, 100, bus);

    expect(bus.events).toHaveLength(2);
    const byId = new Map<string, BusEvent>();
    for (const e of bus.events) {
      if (e.topic !== "issue:updated") continue;
      if ("removed" in e.data && e.data.removed) continue;
      byId.set(e.data.id, e);
    }
    expect(byId.size).toBe(2);

    const blockerEvt = byId.get("DX-582")!;
    if (blockerEvt.topic !== "issue:updated") throw new Error("topic");
    if ("removed" in blockerEvt.data && blockerEvt.data.removed)
      throw new Error("variant");
    expect(blockerEvt.data.item.status).toBe("Done");

    const waiterEvt = byId.get("DX-584")!;
    if (waiterEvt.topic !== "issue:updated") throw new Error("topic");
    if ("removed" in waiterEvt.data && waiterEvt.data.removed)
      throw new Error("variant");
    expect(waiterEvt.data.item.waiting_on).toBe(false);
    expect(waiterEvt.data.item.waiting_on_by).toEqual([]);
  });

  it("filters terminal deps out of a multi-dep waiter while keeping non-terminal ones", async () => {
    // DX-586 waits on DX-582 (Done) + DX-588 (still In Progress). After
    // DX-582 flips Done, the SSE event for DX-586 must report
    // waiting_on === true with by[] === ["DX-588"] only.
    const done = mkIssue("DX-582", "Done");
    const inflight = mkIssue("DX-588", "In Progress");
    const waiter = mkIssue("DX-586", "ToDo", {
      waiting_on: mkWaitingOn(["DX-582", "DX-588"]),
    });
    dbRows = [mkRow(done), mkRow(inflight), mkRow(waiter)];
    const bus = makeBus();

    await publishIssueUpsert("danxbot", done, 100, bus);

    const waiterEvt = bus.events.find((e) => {
      if (e.topic !== "issue:updated") return false;
      if ("removed" in e.data && e.data.removed) return false;
      return e.data.id === "DX-586";
    });
    expect(waiterEvt).toBeDefined();
    if (!waiterEvt || waiterEvt.topic !== "issue:updated") throw new Error();
    if ("removed" in waiterEvt.data && waiterEvt.data.removed)
      throw new Error("variant");
    expect(waiterEvt.data.item.waiting_on).toBe(true);
    expect(waiterEvt.data.item.waiting_on_by).toEqual(["DX-588"]);
  });

  it("re-emits the parent epic so its children_detail entry for the changed phase refreshes", async () => {
    const epic = mkIssue("DX-575", "In Progress", { children: ["DX-582"] });
    const phase = mkIssue("DX-582", "Done", { parent_id: "DX-575" });
    dbRows = [mkRow(epic), mkRow(phase)];
    const bus = makeBus();

    await publishIssueUpsert("danxbot", phase, 100, bus);

    const ids = bus.events
      .map((e) => (e.topic === "issue:updated" ? e.data.id : null))
      .filter((id): id is string => id !== null);
    expect(new Set(ids)).toEqual(new Set(["DX-575", "DX-582"]));

    const epicEvt = bus.events.find((e) => {
      if (e.topic !== "issue:updated") return false;
      if ("removed" in e.data && e.data.removed) return false;
      return e.data.id === "DX-575";
    });
    if (!epicEvt || epicEvt.topic !== "issue:updated") throw new Error();
    if ("removed" in epicEvt.data && epicEvt.data.removed) throw new Error();
    expect(epicEvt.data.item.children_detail).toHaveLength(1);
    expect(epicEvt.data.item.children_detail[0].id).toBe("DX-582");
    expect(epicEvt.data.item.children_detail[0].status).toBe("Done");
  });

  it("uses the caller-passed authoritative state when the DB snapshot lags behind", async () => {
    // Mirror lag: the DB still has the pre-write DX-1 (status: ToDo);
    // the caller's parsed YAML carries the post-write status In Progress.
    // The override must win.
    const stale = mkIssue("DX-1", "ToDo");
    dbRows = [mkRow(stale)];
    const fresh = mkIssue("DX-1", "In Progress");
    const bus = makeBus();

    await publishIssueUpsert("danxbot", fresh, 200, bus);

    expect(bus.events).toHaveLength(1);
    const evt = bus.events[0];
    if (evt.topic !== "issue:updated") throw new Error();
    if ("removed" in evt.data && evt.data.removed) throw new Error();
    expect(evt.data.item.status).toBe("In Progress");
    expect(evt.data.item.updated_at).toBe(200);
  });

  it("returns the projected item for the caller (used by PATCH route to round-trip)", async () => {
    const issue = mkIssue("DX-7", "ToDo");
    dbRows = [mkRow(issue)];
    const bus = makeBus();

    const item = await publishIssueUpsert("danxbot", issue, 50, bus);
    expect(item.id).toBe("DX-7");
    expect(item.status).toBe("ToDo");
    expect(item.updated_at).toBe(50);
  });
});

describe("publishIssueRemoved — fan-out", () => {
  it("emits removed: true for the deleted id then reprojects referrers", async () => {
    // Removed card was a phase of an epic; the epic's children_detail
    // entry for the gone id must now show missing: true.
    const epic = mkIssue("DX-575", "In Progress", { children: ["DX-582"] });
    dbRows = [mkRow(epic)];
    const bus = makeBus();

    await publishIssueRemoved("danxbot", "DX-582", bus);

    expect(bus.events.length).toBeGreaterThanOrEqual(2);
    const first = bus.events[0];
    if (first.topic !== "issue:updated") throw new Error();
    expect("removed" in first.data && first.data.removed).toBe(true);
    expect(first.data.id).toBe("DX-582");

    const epicEvt = bus.events.find((e) => {
      if (e.topic !== "issue:updated") return false;
      if ("removed" in e.data && e.data.removed) return false;
      return e.data.id === "DX-575";
    });
    if (!epicEvt || epicEvt.topic !== "issue:updated") throw new Error();
    if ("removed" in epicEvt.data && epicEvt.data.removed) throw new Error();
    const childEntry = epicEvt.data.item.children_detail.find(
      (c) => c.id === "DX-582",
    );
    expect(childEntry).toBeDefined();
    expect(childEntry?.missing).toBe(true);
  });
});
