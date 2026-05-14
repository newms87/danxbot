import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { Issue, IssueListItem, IssueStatus } from "../types";

// ─── Mocks (declared before importing the SUT) ───────────────────────────────

const mockFetchIssues = vi.fn();
const mockFetchIssueDetail = vi.fn();
const mockPatchIssue = vi.fn();

vi.mock("../api", () => ({
  fetchIssues: (...args: unknown[]) => mockFetchIssues(...args),
  fetchIssueDetail: (...args: unknown[]) => mockFetchIssueDetail(...args),
  patchIssue: (...args: unknown[]) => mockPatchIssue(...args),
}));

// useStream is mocked with a capturing handle so tests can push events on
// demand AND inspect subscription lifecycle (DX-226 — the composable now
// subscribes to the `issue:updated` topic instead of polling).
type Handler = (e: { topic: string; data: unknown }) => void;
type StreamMock = {
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(topic: string, data: unknown): void;
  handlerCount(topic: string): number;
};

function makeStreamMock(): StreamMock {
  const handlers = new Map<string, Set<Handler>>();
  return {
    connectionState: ref<"connecting" | "connected" | "disconnected">(
      "connected",
    ),
    subscribe: vi.fn().mockImplementation((topic: string, h: Handler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    disconnect: vi.fn(),
    emit(topic, data) {
      handlers.get(topic)?.forEach((h) => h({ topic, data }));
    },
    handlerCount(topic) {
      return handlers.get(topic)?.size ?? 0;
    },
  };
}

let currentStream: StreamMock;
vi.mock("./useStream", async () => {
  const actual =
    await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

import { useIssues, applyIssueEvent } from "./useIssues";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeIssue(
  id: string,
  status: IssueStatus = "ToDo",
): IssueListItem {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    status,
    type: "Feature",
    priority: 3,
    assigned_agent: null,
    parent_id: null,
    children_detail: [],
    waiting_on: null,
    waiting_on_reason: null,
    waiting_on_by: [],
    blocked: null,
    requires_human: null,
    ac_done: 0,
    ac_total: 0,
    has_retro: false,
    comments_count: 0,
    created_at: 0,
    updated_at: 0,
  } as unknown as IssueListItem;
}

function makeIssueSnapshot(
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
    title: `Card ${id}`,
    description: "",
    priority: 3,
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
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    assigned_agent: null,
    ...overrides,
  };
}

function mountWithIssues(repo: Ref<string>) {
  const exposed = { ret: null as ReturnType<typeof useIssues> | null };
  const Host = defineComponent({
    setup() {
      exposed.ret = useIssues(repo);
      return () => h("div");
    },
  });
  const wrapper = mount(Host);
  return {
    wrapper,
    get ret() {
      return exposed.ret!;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentStream = makeStreamMock();
});

// ─── Pure reducer ────────────────────────────────────────────────────────────

describe("applyIssueEvent — reducer", () => {
  it("upserts a known id by merging the patchable fields from Issue", () => {
    const state = [makeIssue("DX-1"), makeIssue("DX-2")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: {
        repoName: "danxbot",
        id: "DX-1",
        issue: makeIssueSnapshot("DX-1", {
          title: "Renamed",
          status: "In Progress",
        }),
      },
    });
    expect(next).not.toBe(state);
    expect(next.find((i) => i.id === "DX-1")!.title).toBe("Renamed");
    expect(next.find((i) => i.id === "DX-1")!.status).toBe("In Progress");
    // Sibling untouched.
    expect(next.find((i) => i.id === "DX-2")!.title).toBe("Card DX-2");
  });

  it("appends a freshly-projected row when the upsert id is not in state", () => {
    const state = [makeIssue("DX-1")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: {
        repoName: "danxbot",
        id: "DX-99",
        issue: makeIssueSnapshot("DX-99", { title: "Fresh" }),
      },
    });
    expect(next).toHaveLength(2);
    expect(next.find((i) => i.id === "DX-99")!.title).toBe("Fresh");
  });

  it("drops the matching row on removed:true", () => {
    const state = [makeIssue("DX-1"), makeIssue("DX-2"), makeIssue("DX-3")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: { repoName: "danxbot", id: "DX-2", removed: true },
    });
    expect(next.map((i) => i.id)).toEqual(["DX-1", "DX-3"]);
  });

  it("removed:true for an unknown id is a no-op (same array reference)", () => {
    const state = [makeIssue("DX-1")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: { repoName: "danxbot", id: "DX-NOPE", removed: true },
    });
    expect(next).toBe(state);
  });

  it("ignores non-issue:updated topics (same array reference)", () => {
    const state = [makeIssue("DX-1")];
    const next = applyIssueEvent(state, {
      topic: "dispatch:created",
      data: { id: "job-1" },
    });
    expect(next).toBe(state);
  });

  // DX-516 — the SPA-side projection deep-copies the triage block from
  // the Issue snapshot so the IssueCard chip renders ICE total + most
  // recent history timestamp without a per-row detail fetch, and so a
  // downstream mutation can't leak into the SSE input.
  it("round-trips the triage block on upsert (ice total + history)", () => {
    const state = [makeIssue("DX-1")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: {
        repoName: "danxbot",
        id: "DX-1",
        issue: makeIssueSnapshot("DX-1", {
          triage: {
            expires_at: "2026-06-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "high",
            ice: { total: 80, i: 4, c: 5, e: 4 },
            history: [
              {
                timestamp: "2026-05-13T10:00:00Z",
                status: "Keep",
                explain: "scored",
                expires_at: "2026-06-01T00:00:00Z",
                ice: { total: 80, i: 4, c: 5, e: 4 },
              },
            ],
          },
        }),
      },
    });
    const t = next.find((i) => i.id === "DX-1")!.triage!;
    expect(t.ice.total).toBe(80);
    expect(t.history).toHaveLength(1);
    expect(t.history[0].timestamp).toBe("2026-05-13T10:00:00Z");
  });

  it("round-trips the triage block when projecting a fresh id (append path)", () => {
    const state: IssueListItem[] = [];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: {
        repoName: "danxbot",
        id: "DX-9",
        issue: makeIssueSnapshot("DX-9", {
          triage: {
            expires_at: "",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: { total: 12, i: 3, c: 2, e: 2 },
            history: [
              {
                timestamp: "2026-05-13T11:00:00Z",
                status: "Keep",
                explain: "",
                expires_at: "",
                ice: { total: 12, i: 3, c: 2, e: 2 },
              },
            ],
          },
        }),
      },
    });
    const t = next.find((i) => i.id === "DX-9")!.triage!;
    expect(t.ice.total).toBe(12);
    expect(t.history[0].timestamp).toBe("2026-05-13T11:00:00Z");
  });

  it("deep-copies the triage block — mutating the result does not leak into the input", () => {
    const issue = makeIssueSnapshot("DX-1", {
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "Keep",
        last_explain: "",
        ice: { total: 45, i: 3, c: 5, e: 3 },
        history: [
          {
            timestamp: "2026-05-13T10:00:00Z",
            status: "Keep",
            explain: "x",
            expires_at: "",
            ice: { total: 45, i: 3, c: 5, e: 3 },
          },
        ],
      },
    });
    const state = [makeIssue("DX-1")];
    const next = applyIssueEvent(state, {
      topic: "issue:updated",
      data: { repoName: "danxbot", id: "DX-1", issue },
    });
    const t = next.find((i) => i.id === "DX-1")!.triage!;
    t.ice.total = -1;
    t.history[0].ice.total = -1;
    expect(issue.triage.ice.total).toBe(45);
    expect(issue.triage.history[0].ice.total).toBe(45);
  });
});

// ─── Source-check guard ──────────────────────────────────────────────────────

describe("useIssues — no setInterval polling (DX-226 source guard)", () => {
  it("source has no setInterval", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "useIssues.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });
});

// ─── Hydrate + SSE integration ───────────────────────────────────────────────

describe("useIssues — hydrate + subscribe", () => {
  it("hydrates via REST on mount and subscribes to issue:updated", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1"), makeIssue("DX-2")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    expect(mockFetchIssues).toHaveBeenCalledWith("danxbot");
    expect(ret.issues.value.map((i) => i.id)).toEqual(["DX-1", "DX-2"]);
    expect(currentStream.handlerCount("issue:updated")).toBe(1);
    wrapper.unmount();
  });

  it("applies an issue:updated upsert event", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1", "ToDo")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    currentStream.emit("issue:updated", {
      repoName: "danxbot",
      id: "DX-1",
      issue: makeIssueSnapshot("DX-1", { status: "In Progress" }),
    });

    expect(ret.issues.value[0].status).toBe("In Progress");
    wrapper.unmount();
  });

  it("applies an issue:updated removed:true event by dropping the row", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1"), makeIssue("DX-2")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    currentStream.emit("issue:updated", {
      repoName: "danxbot",
      id: "DX-1",
      removed: true,
    });

    expect(ret.issues.value.map((i) => i.id)).toEqual(["DX-2"]);
    wrapper.unmount();
  });

  it("filters out events for a different repoName", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1", "ToDo")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    // Event for a sibling repo — must not touch local state.
    currentStream.emit("issue:updated", {
      repoName: "platform",
      id: "DX-1",
      issue: makeIssueSnapshot("DX-1", { status: "Done" }),
    });

    expect(ret.issues.value[0].status).toBe("ToDo");
    wrapper.unmount();
  });

  it("invalidates the detail cache when an SSE upsert lands for the cached id", async () => {
    const detail1 = { ...makeIssueSnapshot("DX-1"), updated_at: 1, created_at: 0, raw_yaml: "" };
    const detail2 = { ...makeIssueSnapshot("DX-1", { title: "Server" }), updated_at: 2, created_at: 0, raw_yaml: "" };
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    mockFetchIssueDetail.mockResolvedValueOnce(detail1);
    mockFetchIssueDetail.mockResolvedValueOnce(detail2);

    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const first = await ret.fetchDetail("DX-1");
    expect(first).toBe(detail1);
    // Cache HIT.
    expect(await ret.fetchDetail("DX-1")).toBe(detail1);
    expect(mockFetchIssueDetail).toHaveBeenCalledTimes(1);

    currentStream.emit("issue:updated", {
      repoName: "danxbot",
      id: "DX-1",
      issue: makeIssueSnapshot("DX-1", { title: "From SSE" }),
    });

    // Cache MISS — invalidated by the SSE handler.
    const refetched = await ret.fetchDetail("DX-1");
    expect(refetched).toBe(detail2);
    expect(mockFetchIssueDetail).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

// ─── moveIssueStatus (unchanged behavior) ────────────────────────────────────

describe("useIssues — moveIssueStatus", () => {
  it("optimistically updates local status before the patch resolves", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1", "ToDo")]);
    let resolvePatch!: () => void;
    mockPatchIssue.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolvePatch = r;
      }),
    );

    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();
    expect(ret.issues.value[0].status).toBe("ToDo");

    const movePromise = ret.moveIssueStatus("DX-1", "In Progress");
    await Promise.resolve();
    expect(ret.issues.value[0].status).toBe("In Progress");

    resolvePatch();
    await movePromise;
    expect(ret.issues.value[0].status).toBe("In Progress");
    expect(mockPatchIssue).toHaveBeenCalledWith("danxbot", "DX-1", {
      status: "In Progress",
    });
    wrapper.unmount();
  });

  it("reverts the local status and surfaces the error when patch rejects", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-2", "ToDo")]);
    mockPatchIssue.mockRejectedValueOnce(
      Object.assign(new Error("400 status invalid"), { status: 400 }),
    );

    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    await expect(
      ret.moveIssueStatus("DX-2", "Done"),
    ).rejects.toThrow("400 status invalid");

    expect(ret.issues.value[0].status).toBe("ToDo");
    expect(ret.error.value).toBe("400 status invalid");
    wrapper.unmount();
  });

  it("same-status move short-circuits (no patch, no mutation)", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-3", "Blocked")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    await ret.moveIssueStatus("DX-3", "Blocked");

    expect(mockPatchIssue).not.toHaveBeenCalled();
    expect(ret.issues.value[0].status).toBe("Blocked");
    wrapper.unmount();
  });

  it("rejects with `Unknown issue` when id is not in the list", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-4", "ToDo")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    await expect(
      ret.moveIssueStatus("DX-NOPE", "Done"),
    ).rejects.toThrow(/Unknown issue/);
    expect(mockPatchIssue).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("optimistic mutation survives a concurrent SSE upsert (pendingMoves replay)", async () => {
    const stale = makeIssue("DX-R", "ToDo");
    mockFetchIssues.mockResolvedValueOnce([stale]);
    let resolvePatch!: () => void;
    mockPatchIssue.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolvePatch = r;
      }),
    );

    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const movePromise = ret.moveIssueStatus("DX-R", "In Progress");
    await Promise.resolve();
    expect(ret.issues.value[0].status).toBe("In Progress");

    // SSE upsert lands mid-flight with the still-stale ToDo status —
    // the optimistic mutation must NOT be clobbered.
    currentStream.emit("issue:updated", {
      repoName: "danxbot",
      id: "DX-R",
      issue: makeIssueSnapshot("DX-R", { status: "ToDo" }),
    });
    expect(ret.issues.value[0].status).toBe("In Progress");

    resolvePatch();
    await movePromise;
    expect(ret.issues.value[0].status).toBe("In Progress");
    wrapper.unmount();
  });

  it("rejects when no repo is selected", async () => {
    mockFetchIssues.mockResolvedValue([]);
    const { wrapper, ret } = mountWithIssues(ref(""));
    await flushPromises();

    await expect(
      ret.moveIssueStatus("DX-1", "Done"),
    ).rejects.toThrow(/No repo selected/);
    wrapper.unmount();
  });
});

// ─── applyIssueUpdate (drawer affordance, unchanged) ─────────────────────────

describe("useIssues — applyIssueUpdate", () => {
  it("merges the patchable fields from Issue into the matching IssueListItem", async () => {
    mockFetchIssues.mockResolvedValue([
      makeIssue("DX-1", "ToDo"),
      makeIssue("DX-2", "ToDo"),
    ]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const updated = makeIssueSnapshot("DX-1", {
      title: "Renamed",
      description: "New body",
      status: "In Progress",
      priority: 5,
      parent_id: "DX-99",
      children: ["DX-3"],
    });
    ret.applyIssueUpdate(updated);

    const row = ret.issues.value.find((i) => i.id === "DX-1")!;
    expect(row.title).toBe("Renamed");
    expect(row.description).toBe("New body");
    expect(row.status).toBe("In Progress");
    expect(row.priority).toBe(5);
    expect(row.parent_id).toBe("DX-99");
    expect(row.children).toEqual(["DX-3"]);
    expect(ret.issues.value.find((i) => i.id === "DX-2")!.status).toBe("ToDo");
    wrapper.unmount();
  });

  it("recomputes ac_done from `ac[].checked` and ac_total from length", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const updated = makeIssueSnapshot("DX-1", {
      ac: [
        { check_item_id: "a", title: "1", checked: true },
        { check_item_id: "b", title: "2", checked: false },
        { check_item_id: "c", title: "3", checked: true },
      ],
    });
    ret.applyIssueUpdate(updated);

    const row = ret.issues.value[0];
    expect(row.ac_total).toBe(3);
    expect(row.ac_done).toBe(2);
    wrapper.unmount();
  });

  it("is a no-op when the id is not in the list", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const before = ret.issues.value;
    ret.applyIssueUpdate(makeIssueSnapshot("DX-999", { title: "Phantom" }));
    expect(ret.issues.value).toBe(before);
    wrapper.unmount();
  });

  it("is a no-op when no repo is selected", async () => {
    mockFetchIssues.mockResolvedValue([]);
    const { wrapper, ret } = mountWithIssues(ref(""));
    await flushPromises();

    expect(() =>
      ret.applyIssueUpdate(makeIssueSnapshot("DX-1")),
    ).not.toThrow();
    wrapper.unmount();
  });
});
