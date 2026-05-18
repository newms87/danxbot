import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CardTimeline from "./CardTimeline.vue";
import type { IssueDetail } from "../../types";

vi.mock("../../api", () => ({
  fetchLists: vi.fn(async () => ({
    lists: [
      { id: "lst-arc", name: "Backlog",     type: "archived",    order: 0, is_default_for_type: true, color: "#64748b" },
      { id: "lst-rev", name: "Review",      type: "review",      order: 1, is_default_for_type: true, color: "#3b82f6" },
      { id: "lst-rdy", name: "To Do",       type: "ready",       order: 2, is_default_for_type: true, color: "#22d3ee" },
      { id: "lst-blk", name: "Blocked",     type: "blocked",     order: 3, is_default_for_type: true, color: "#ef4444" },
      { id: "lst-wip", name: "In Progress", type: "in_progress", order: 4, is_default_for_type: true, color: "#f59e0b" },
      { id: "lst-don", name: "Done",        type: "completed",   order: 5, is_default_for_type: true, color: "#22c55e" },
      { id: "lst-cnl", name: "Cancelled",   type: "cancelled",   order: 6, is_default_for_type: true, color: "#71717a" },
    ],
    tombstone_ids: [],
  })),
}));

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 11,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Card",
    description: "",
    priority: 3,
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
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    assigned_agent: null,
    updated_at: 0,
    created_at: Date.parse("2026-05-10T00:00:00Z"),
    raw_yaml: "",
    requires_human_child_count: 0,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
    ...overrides,
  };
}

function mountTimeline(detail: IssueDetail) {
  return mount(CardTimeline, { props: { issue: detail, repo: "danxbot" } });
}

describe("CardTimeline", () => {
  it("renders only Created when the card has no other lifecycle stamps", async () => {
    const w = mountTimeline(makeDetail());
    await flushPromises();
    expect(w.find("[data-test='timeline-node-created']").exists()).toBe(true);
    for (const k of ["archived", "ready", "blocked", "in_progress", "completed", "cancelled"]) {
      expect(w.find(`[data-test='timeline-node-${k}']`).exists()).toBe(false);
    }
  });

  it("renders Ready when ready_at is set", async () => {
    const w = mountTimeline(makeDetail({ ready_at: "2026-05-11T00:00:00Z" }));
    await flushPromises();
    expect(w.find("[data-test='timeline-node-ready']").exists()).toBe(true);
  });

  it("renders Blocked node with the blocked.at timestamp", async () => {
    const w = mountTimeline(
      makeDetail({ blocked: { at: "2026-05-12T00:00:00Z", reason: "x" } }),
    );
    await flushPromises();
    const node = w.find("[data-test='timeline-node-blocked']");
    expect(node.exists()).toBe(true);
    expect(node.attributes("data-greyed")).toBe("false");
    expect(node.attributes("data-iso")).toBe("2026-05-12T00:00:00Z");
  });

  it("renders In Progress when an active dispatch is present", async () => {
    const w = mountTimeline(
      makeDetail({
        dispatch: {
          id: "d1",
          pid: 0,
          host: "",
          kind: "work",
          started_at: "2026-05-13T00:00:00Z",
          ttl_seconds: 7200,
        },
      }),
    );
    await flushPromises();
    expect(w.find("[data-test='timeline-node-in_progress']").exists()).toBe(true);
  });

  it("infers In Progress for a completed card with no active dispatch", async () => {
    const w = mountTimeline(makeDetail({ completed_at: "2026-05-14T00:00:00Z" }));
    await flushPromises();
    expect(w.find("[data-test='timeline-node-in_progress']").exists()).toBe(true);
    expect(w.find("[data-test='timeline-node-completed']").exists()).toBe(true);
  });

  it("renders Cancelled (and not Done) when cancelled_at is set", async () => {
    const w = mountTimeline(makeDetail({ cancelled_at: "2026-05-15T00:00:00Z" }));
    await flushPromises();
    expect(w.find("[data-test='timeline-node-cancelled']").exists()).toBe(true);
    expect(w.find("[data-test='timeline-node-completed']").exists()).toBe(false);
  });

  it("renders the Backlog node only when archived_at is set", async () => {
    const w = mountTimeline(makeDetail({ archived_at: "2026-05-09T00:00:00Z" }));
    await flushPromises();
    expect(w.find("[data-test='timeline-node-archived']").exists()).toBe(true);
  });

  it("applies the default-list colour to reached nodes via useListColors", async () => {
    const w = mountTimeline(makeDetail({ ready_at: "2026-05-11T00:00:00Z" }));
    await flushPromises();
    const dot = w.find("[data-test='timeline-node-ready'] .dot");
    const style = dot.attributes("style") || "";
    expect(style).toContain("#22d3ee");
  });

  it("uses created event from history when present, falling back to file mtime otherwise", async () => {
    const withHistory = mountTimeline(
      makeDetail({
        history: [
          { timestamp: "2026-04-01T00:00:00Z", actor: "setup", event: "created" },
        ],
      }),
    );
    await flushPromises();
    expect(
      withHistory.find("[data-test='timeline-node-created']").attributes("data-iso"),
    ).toBe("2026-04-01T00:00:00Z");

    const fallback = mountTimeline(makeDetail());
    await flushPromises();
    // mtime fallback: created_at=2026-05-10 in makeDetail → rendered ISO carries the same date
    const iso = fallback
      .find("[data-test='timeline-node-created']")
      .attributes("data-iso");
    expect(iso).toContain("2026-05-10T00:00:00");
  });

  it("infers In Progress from history status_change when no dispatch is active", async () => {
    const w = mountTimeline(
      makeDetail({
        history: [
          {
            timestamp: "2026-05-13T01:00:00Z",
            actor: "worker",
            event: "status_change",
            from: "ToDo",
            to: "In Progress",
          },
        ],
      }),
    );
    await flushPromises();
    const node = w.find("[data-test='timeline-node-in_progress']");
    expect(node.exists()).toBe(true);
    expect(node.attributes("data-iso")).toBe("2026-05-13T01:00:00Z");
  });

  it("renders In Progress as reached-without-timestamp when only completed_at is known", async () => {
    const w = mountTimeline(makeDetail({ completed_at: "2026-05-14T00:00:00Z" }));
    await flushPromises();
    const node = w.find("[data-test='timeline-node-in_progress']");
    expect(node.attributes("data-greyed")).toBe("false");
    expect(node.attributes("data-iso")).toBe("");
  });

  it("falls back to a neutral colour when the lists taxonomy is empty", async () => {
    const api = await import("../../api");
    vi.mocked(api.fetchLists).mockResolvedValueOnce({ lists: [], tombstone_ids: [] });
    const w = mountTimeline(makeDetail({ ready_at: "2026-05-11T00:00:00Z" }));
    await flushPromises();
    const dot = w.find("[data-test='timeline-node-ready'] .dot");
    const style = dot.attributes("style") || "";
    // NEUTRAL_NODE_COLOR (#475569) — rendered via CSS so check for the hex.
    expect(style.toLowerCase()).toContain("#475569");
  });

  it("renders nodes.length - 1 connectors", async () => {
    const w = mountTimeline(
      makeDetail({
        ready_at: "2026-05-11T00:00:00Z",
        completed_at: "2026-05-16T00:00:00Z",
      }),
    );
    await flushPromises();
    const nodeCount = w.findAll("[data-test^='timeline-node-']").length;
    const connectorCount = w.findAll(".connector").length;
    expect(connectorCount).toBe(nodeCount - 1);
  });

  it("DanxTooltip carries the ISO timestamp; '(time unknown)' for reached-but-undated nodes", async () => {
    const w = mountTimeline(makeDetail({ ready_at: "2026-05-11T00:00:00Z" }));
    await flushPromises();
    // DanxTooltip mounts its panel via teleport; the prop is on the
    // component instance. findAllComponents returns the wrappers.
    const tooltips = w.findAllComponents({ name: "DanxTooltip" });
    const labels = tooltips.map((t) => String(t.props("tooltip") ?? ""));
    expect(labels.some((l) => l.includes("2026-05-11T00:00:00Z") && l.includes("Ready"))).toBe(true);

    const w2 = mountTimeline(makeDetail({ completed_at: "2026-05-16T00:00:00Z" }));
    await flushPromises();
    const labels2 = w2
      .findAllComponents({ name: "DanxTooltip" })
      .map((t) => String(t.props("tooltip") ?? ""));
    expect(labels2.some((l) => l.includes("In Progress") && l.includes("(time unknown)"))).toBe(true);
  });

  it("skips states the card never reached (Review→ToDo→Done renders no Blocked / Backlog node)", async () => {
    const w = mountTimeline(
      makeDetail({
        ready_at: "2026-05-11T00:00:00Z",
        completed_at: "2026-05-16T00:00:00Z",
      }),
    );
    await flushPromises();
    expect(w.find("[data-test='timeline-node-blocked']").exists()).toBe(false);
    expect(w.find("[data-test='timeline-node-archived']").exists()).toBe(false);
  });

  it("renders Done (not Cancelled) when both completed_at and cancelled_at are set", async () => {
    const w = mountTimeline(
      makeDetail({
        completed_at: "2026-05-16T00:00:00Z",
        cancelled_at: "2026-05-17T00:00:00Z",
      }),
    );
    await flushPromises();
    expect(w.find("[data-test='timeline-node-completed']").exists()).toBe(true);
    expect(w.find("[data-test='timeline-node-cancelled']").exists()).toBe(false);
  });

  it("renders nodes in the canonical order on a fully-populated card", async () => {
    const w = mountTimeline(
      makeDetail({
        archived_at: "2026-05-09T00:00:00Z",
        ready_at: "2026-05-11T00:00:00Z",
        blocked: { at: "2026-05-12T00:00:00Z", reason: "x" },
        dispatch: {
          id: "d1", pid: 0, host: "", kind: "work",
          started_at: "2026-05-13T00:00:00Z", ttl_seconds: 7200,
        },
        completed_at: "2026-05-16T00:00:00Z",
      }),
    );
    await flushPromises();
    const keys = w
      .findAll("[data-test^='timeline-node-']")
      .map((el) => el.attributes("data-test")?.replace("timeline-node-", ""));
    expect(keys).toEqual([
      "created",
      "archived",
      "ready",
      "blocked",
      "in_progress",
      "completed",
    ]);
  });

  it("re-renders nodes when the parent updates :issue (SSE-driven reactivity)", async () => {
    const w = mountTimeline(makeDetail());
    await flushPromises();
    expect(w.find("[data-test='timeline-node-completed']").exists()).toBe(false);
    await w.setProps({
      issue: makeDetail({ completed_at: "2026-05-16T00:00:00Z" }),
    });
    await flushPromises();
    expect(w.find("[data-test='timeline-node-completed']").exists()).toBe(true);
  });
});
