import { describe, expect, it } from "vitest";
import {
  buildReconcileTaskBody,
  findOwnedCard,
  pickCardForAgent,
  pickFreeAgent,
  pickFreeAgentCandidates,
} from "./pick-agent.js";
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
    strikes: { count: 0, history: [] },
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
    schema_version: 8,
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
    effort_level: null,
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
      evaluator_status: "completed" as const,
      evaluator_dispatch_id: null,
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

describe("pickFreeAgentCandidates — DX-368 invariant input", () => {
  it("returns every eligible agent, sorted by name", () => {
    const roster = [agent("charlie"), agent("alice"), agent("bob")];
    const out = pickFreeAgentCandidates({
      roster,
      busy: new Set(),
      now: NOW,
    });
    expect(out.map((a) => a.name)).toEqual(["alice", "bob", "charlie"]);
  });

  it("applies the same filter chain as pickFreeAgent (busy / disabled / wrong capability / off-hours / broken excluded)", () => {
    const closedSchedule = alwaysOpenSchedule();
    closedSchedule.mon = [];
    const roster = [
      agent("alice"), // eligible
      agent("bob", { enabled: false }), // disabled
      agent("charlie", { capabilities: ["slack"] }), // wrong cap
      agent("dani", { schedule: closedSchedule }), // off-hours
      agent("eve", {
        broken: {
          reason: "stale",
          suggested_steps: [],
          set_at: "2026-01-01T00:00:00Z",
          evaluator_status: "pending",
          evaluator_dispatch_id: null,
        },
      }), // broken
      agent("frank"), // eligible
    ];
    const out = pickFreeAgentCandidates({
      roster,
      busy: new Set(["frank"]), // busy → excluded
      now: NOW,
    });
    expect(out.map((a) => a.name)).toEqual(["alice"]);
  });

  it("returns [] when no agent qualifies", () => {
    const out = pickFreeAgentCandidates({
      roster: [agent("alice", { enabled: false })],
      busy: new Set(),
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("pickFreeAgent stays consistent with candidates[0]", () => {
    const roster = [agent("charlie"), agent("alice"), agent("bob")];
    const input = { roster, busy: new Set<string>(), now: NOW };
    const candidates = pickFreeAgentCandidates(input);
    const first = pickFreeAgent(input);
    expect(first?.name).toBe(candidates[0]?.name);
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

// ============================================================
// findOwnedCard (DX-360) — resume-existing-card pre-check.
// ============================================================
describe("findOwnedCard", () => {
  it("returns kind=none when the agent owns no open card", () => {
    const open = [
      issue("DX-1", { assigned_agent: "bob" }),
      issue("DX-2", { assigned_agent: null }),
    ];
    expect(findOwnedCard("alice", open)).toEqual({ kind: "none" });
  });

  it("returns kind=single for the agent's open card regardless of status (ToDo)", () => {
    const open = [issue("DX-1", { assigned_agent: "alice", status: "ToDo" })];
    const out = findOwnedCard("alice", open);
    expect(out.kind).toBe("single");
    if (out.kind === "single") expect(out.card.id).toBe("DX-1");
  });

  it("returns kind=single when status is In Progress", () => {
    const open = [
      issue("DX-1", { assigned_agent: "alice", status: "In Progress" }),
    ];
    const out = findOwnedCard("alice", open);
    expect(out.kind).toBe("single");
    if (out.kind === "single") expect(out.card.id).toBe("DX-1");
  });

  it("returns kind=single when status is Blocked", () => {
    const open = [
      issue("DX-1", {
        assigned_agent: "alice",
        status: "Blocked",
        blocked: { reason: "x", timestamp: "2026-04-20T00:00:00Z" },
      }),
    ];
    const out = findOwnedCard("alice", open);
    expect(out.kind).toBe("single");
    if (out.kind === "single") expect(out.card.id).toBe("DX-1");
  });

  it("returns kind=single when status is Review", () => {
    const open = [
      issue("DX-1", { assigned_agent: "alice", status: "Review" }),
    ];
    const out = findOwnedCard("alice", open);
    expect(out.kind).toBe("single");
    if (out.kind === "single") expect(out.card.id).toBe("DX-1");
  });

  it("ignores cards in terminal status (Done / Cancelled) — audit only", () => {
    const open = [
      issue("DX-1", { assigned_agent: "alice", status: "Done" }),
      issue("DX-2", { assigned_agent: "alice", status: "Cancelled" }),
    ];
    expect(findOwnedCard("alice", open)).toEqual({ kind: "none" });
  });

  it("returns kind=none when nothing names the agent", () => {
    const open = [
      issue("DX-1", { assigned_agent: "bob", status: "In Progress" }),
      issue("DX-2", { assigned_agent: null, status: "ToDo" }),
    ];
    expect(findOwnedCard("alice", open)).toEqual({ kind: "none" });
  });

  // DX-501 — replaces the pre-DX-501 OwnedCardInvariantError throw.
  it("returns kind=duplicates when the agent owns 2+ open cards", () => {
    const a = issue("DX-1", { assigned_agent: "alice", status: "In Progress" });
    const b = issue("DX-2", { assigned_agent: "alice", status: "ToDo" });
    const out = findOwnedCard("alice", [a, b]);
    expect(out.kind).toBe("duplicates");
    if (out.kind === "duplicates") {
      expect(out.cards.map((c) => c.id)).toEqual(["DX-1", "DX-2"]);
    }
  });

  it("preserves input order in kind=duplicates.cards", () => {
    const second = issue("DX-2", {
      assigned_agent: "alice",
      status: "In Progress",
    });
    const first = issue("DX-1", {
      assigned_agent: "alice",
      status: "ToDo",
    });
    const out = findOwnedCard("alice", [second, first]);
    expect(out.kind).toBe("duplicates");
    if (out.kind === "duplicates") {
      expect(out.cards.map((c) => c.id)).toEqual(["DX-2", "DX-1"]);
    }
  });

  it("Done + open mixed → counts only open, returns kind=single", () => {
    const open = [
      issue("DX-1", { assigned_agent: "alice", status: "Done" }),
      issue("DX-2", { assigned_agent: "alice", status: "In Progress" }),
    ];
    const out = findOwnedCard("alice", open);
    expect(out.kind).toBe("single");
    if (out.kind === "single") expect(out.card.id).toBe("DX-2");
  });

  it("empty open list → kind=none", () => {
    expect(findOwnedCard("alice", [])).toEqual({ kind: "none" });
  });
});

// ============================================================
// buildReconcileTaskBody (DX-501) — pure prompt builder.
// ============================================================
describe("buildReconcileTaskBody", () => {
  it("enumerates every owned card by id, title, and status", () => {
    const cards = [
      issue("DX-351", {
        title: "Phase 4 reconcile coverage",
        status: "In Progress",
        assigned_agent: "murphy",
      }),
      issue("DX-354", {
        title: "Phase 7 ideator stub",
        status: "ToDo",
        assigned_agent: "murphy",
      }),
    ];
    const body = buildReconcileTaskBody("murphy", cards);

    expect(body).toContain("You are murphy.");
    expect(body).toContain("2 open cards");
    expect(body).toContain("DX-351");
    expect(body).toContain("DX-354");
    expect(body).toContain("Phase 4 reconcile coverage");
    expect(body).toContain("Phase 7 ideator stub");
    expect(body).toContain("status: In Progress");
    expect(body).toContain("status: ToDo");
  });

  it("instructs the agent to invoke /danx-next on the retained card", () => {
    const body = buildReconcileTaskBody("dani", [
      issue("DX-1", { assigned_agent: "dani" }),
      issue("DX-2", { assigned_agent: "dani" }),
    ]);
    expect(body).toMatch(/\/danx-next <retained-id>/);
    expect(body).toContain("assigned_agent: null");
  });

  it("warns about waiting_on / requires_human / Blocked gates on the retained card (DX-501 review)", () => {
    const body = buildReconcileTaskBody("dani", [
      issue("DX-1", { assigned_agent: "dani" }),
      issue("DX-2", { assigned_agent: "dani" }),
    ]);
    expect(body).toMatch(/waiting_on/);
    expect(body).toMatch(/requires_human/);
    expect(body).toMatch(/Blocked/);
  });

  it("specifies structured comments[] shape rather than raw text append (DX-501 review)", () => {
    const body = buildReconcileTaskBody("dani", [
      issue("DX-1", { assigned_agent: "dani" }),
      issue("DX-2", { assigned_agent: "dani" }),
    ]);
    // Reviewer flagged the original wording "append a one-line comment"
    // as ambiguous against the comments[] schema. New body MUST name
    // the {author, timestamp, text} fields explicitly.
    expect(body).toMatch(/author/);
    expect(body).toMatch(/timestamp/);
    expect(body).toMatch(/text/);
  });

  it("includes the first description line as a hint when present", () => {
    const body = buildReconcileTaskBody("murphy", [
      issue("DX-1", {
        assigned_agent: "murphy",
        description: "Fix the picker reconcile branch\n\nMore detail here.",
      }),
    ]);
    expect(body).toContain("Fix the picker reconcile branch");
  });

  it("omits the hint line when description is empty", () => {
    const body = buildReconcileTaskBody("murphy", [
      issue("DX-1", { assigned_agent: "murphy", description: "" }),
    ]);
    expect(body).not.toContain("hint:");
  });

  it("preserves the order of ownedCards in the enumeration", () => {
    const body = buildReconcileTaskBody("murphy", [
      issue("DX-9", { assigned_agent: "murphy", title: "Second" }),
      issue("DX-1", { assigned_agent: "murphy", title: "First" }),
    ]);
    const ixSecond = body.indexOf("DX-9");
    const ixFirst = body.indexOf("DX-1");
    expect(ixSecond).toBeGreaterThan(-1);
    expect(ixFirst).toBeGreaterThan(ixSecond);
  });
});
