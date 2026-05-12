import { describe, expect, it } from "vitest";
import { pickCardForAgent, pickFreeAgent } from "./pick-agent.js";
import type { AgentRecordWithName } from "../settings-file.js";
import type { Issue } from "../issue-tracker/interface.js";

function alwaysOpenSchedule(): AgentRecordWithName["schedule"] {
  return {
    tz: "America/Chicago",
    always_on: false,
    mon: ["00:00-23:59"],
    tue: ["00:00-23:59"],
    wed: ["00:00-23:59"],
    thu: ["00:00-23:59"],
    fri: ["00:00-23:59"],
    sat: ["00:00-23:59"],
    sun: ["00:00-23:59"],
  };
}

function agent(
  name: string,
  overrides: Partial<AgentRecordWithName> = {},
): AgentRecordWithName {
  return {
    name,
    type: "agent",
    bio: "",
    capabilities: ["issue-worker"],
    schedule: alwaysOpenSchedule(),
    enabled: true,
    broken: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function issue(
  id: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: id,
    description: "",
    priority: 3.0,
    position: null,
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
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    history: [],
    ...overrides,
  };
}

const NOW = new Date("2026-04-20T15:00:00Z"); // Mon 10:00 CDT

describe("pickFreeAgent", () => {
  it("returns the first agent (by name) when multiple are eligible", () => {
    const roster = [agent("bob"), agent("alice"), agent("charlie")];
    const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
    expect(out?.name).toBe("alice");
  });

  it("skips an agent that is in the busy set", () => {
    const roster = [agent("alice"), agent("bob")];
    const out = pickFreeAgent({
      roster,
      busy: new Set(["alice"]),
      now: NOW,
    });
    expect(out?.name).toBe("bob");
  });

  it("returns null when every agent is busy", () => {
    const roster = [agent("alice"), agent("bob")];
    const out = pickFreeAgent({
      roster,
      busy: new Set(["alice", "bob"]),
      now: NOW,
    });
    expect(out).toBeNull();
  });

  it("returns null when every agent is off-hours", () => {
    const closedSchedule = alwaysOpenSchedule();
    closedSchedule.mon = []; // Mon — closed
    const roster = [
      agent("alice", { schedule: closedSchedule }),
      agent("bob", { schedule: closedSchedule }),
    ];
    const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
    expect(out).toBeNull();
  });

  it("skips disabled agents", () => {
    const roster = [
      agent("alice", { enabled: false }),
      agent("bob"),
    ];
    const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
    expect(out?.name).toBe("bob");
  });

  it("skips agents without the issue-worker capability", () => {
    const roster = [
      agent("alice", { capabilities: ["slack"] }),
      agent("bob", { capabilities: ["api"] }),
      agent("charlie", { capabilities: ["issue-worker", "slack"] }),
    ];
    const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
    expect(out?.name).toBe("charlie");
  });

  it("returns null on an empty roster", () => {
    const out = pickFreeAgent({ roster: [], busy: new Set(), now: NOW });
    expect(out).toBeNull();
  });

  // DX-292 Phase 1 — broken agents are excluded from the pickable pool
  // by the same gate that filters busy/disabled/wrong-capability. The
  // operator clears `broken` via the dashboard (set to null) and the
  // agent returns to the pool on the next tick.
  describe("DX-292: broken-agent exclusion", () => {
    const brokenRecord = {
      reason: "Worktree rebase aborted on conflict.",
      suggested_steps: ["cd <worktree>", "git rebase --abort"],
      set_at: "2026-05-12T03:00:00Z",
    };

    it("skips an agent whose broken !== null", () => {
      const roster = [
        agent("alice", { broken: brokenRecord }),
        agent("bob"),
      ];
      const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
      expect(out?.name).toBe("bob");
    });

    it("returns null when every agent is broken", () => {
      const roster = [
        agent("alice", { broken: brokenRecord }),
        agent("bob", { broken: brokenRecord }),
      ];
      const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
      expect(out).toBeNull();
    });

    it("clearing broken (broken = null) returns the agent to the eligible pool", () => {
      // Sanity: broken-alice → bob picked.
      const tickBroken = pickFreeAgent({
        roster: [agent("alice", { broken: brokenRecord }), agent("bob")],
        busy: new Set(),
        now: NOW,
      });
      expect(tickBroken?.name).toBe("bob");

      // After clear: alice (alphabetical first) picked again.
      const tickHealed = pickFreeAgent({
        roster: [agent("alice", { broken: null }), agent("bob")],
        busy: new Set(),
        now: NOW,
      });
      expect(tickHealed?.name).toBe("alice");
    });

    it("disabled + broken — still skipped (enabled gate fires first, ordering invariant)", () => {
      // A disabled AND broken agent must be filtered out regardless of
      // which gate runs first. Pinned so a future refactor that flips
      // the cheapest-first order can't accidentally let a disabled
      // broken agent slip through.
      const roster = [
        agent("alice", { enabled: false, broken: brokenRecord }),
        agent("bob"),
      ];
      const out = pickFreeAgent({ roster, busy: new Set(), now: NOW });
      expect(out?.name).toBe("bob");
    });

    it("broken takes precedence over busy/schedule when filtering (early return — picker never evaluates downstream)", () => {
      // Broken-alice is ALSO in busy + off-hours. The order of filters
      // is an implementation detail, but the user-observable behavior is
      // identical: she is not picked. This test guards against a future
      // refactor that accidentally re-orders the gates such that an
      // off-hours broken agent slips through.
      const closedSchedule = alwaysOpenSchedule();
      closedSchedule.mon = [];
      const roster = [
        agent("alice", { broken: brokenRecord, schedule: closedSchedule }),
        agent("bob"),
      ];
      const out = pickFreeAgent({
        roster,
        busy: new Set(["alice"]),
        now: NOW,
      });
      expect(out?.name).toBe("bob");
    });
  });
});

describe("pickCardForAgent", () => {
  it("returns the first unclaimed card", () => {
    const cards = [issue("DX-1"), issue("DX-2"), issue("DX-3")];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map(),
    });
    expect(out?.id).toBe("DX-1");
  });

  it("skips a card claimed by another agent", () => {
    const cards = [issue("DX-1"), issue("DX-2")];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map([["DX-1", "bob"]]),
    });
    expect(out?.id).toBe("DX-2");
  });

  it("allows the same agent to RE-CLAIM a card it already owns", () => {
    const cards = [issue("DX-1"), issue("DX-2")];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map([["DX-1", "alice"]]),
    });
    expect(out?.id).toBe("DX-1");
  });

  it("returns null when every card is claimed by another agent", () => {
    const cards = [issue("DX-1"), issue("DX-2")];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map([
        ["DX-1", "bob"],
        ["DX-2", "charlie"],
      ]),
    });
    expect(out).toBeNull();
  });

  it("returns null on empty cards list", () => {
    const out = pickCardForAgent({
      cards: [],
      agentName: "alice",
      assigned: new Map(),
    });
    expect(out).toBeNull();
  });

  it("treats the YAML's own assigned_agent as a fallback signal when the DB map is empty", () => {
    const cards = [
      issue("DX-1", { assigned_agent: "bob" }),
      issue("DX-2"),
    ];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map(),
    });
    expect(out?.id).toBe("DX-2");
  });

  it("conservative skip when DB map and YAML disagree (one names other agent → skip)", () => {
    // DB says alice owns DX-1; YAML says bob. Either source dissenting
    // is enough to skip — we can't be certain who's the real owner
    // mid-mirror-window. The picker conservatively passes.
    const cards = [
      issue("DX-1", { assigned_agent: "bob" }),
      issue("DX-2"),
    ];
    const out = pickCardForAgent({
      cards,
      agentName: "alice",
      assigned: new Map([["DX-1", "alice"]]),
    });
    expect(out?.id).toBe("DX-2");
  });
});
