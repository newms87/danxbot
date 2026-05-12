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

import { useIssues } from "./useIssues";

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
});

// ─── moveIssueStatus ─────────────────────────────────────────────────────────

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

  it("optimistic mutation survives a concurrent REST refresh (poll-vs-mutation race)", async () => {
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

    // Background poll lands mid-flight returning stale ToDo data — the
    // mutation must NOT be clobbered (would snap-back the column for up
    // to 30s until the next poll picks up the server's post-patch state).
    mockFetchIssues.mockResolvedValueOnce([makeIssue("DX-R", "ToDo")]);
    await ret.refresh();
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

// ─── applyIssueUpdate ────────────────────────────────────────────────────────

function makeIssueSnapshot(
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
    assigned_agent: null,
    ...overrides,
  };
}

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
    // The sibling card is untouched.
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

  it("updates comments_count to comments.length", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const updated = makeIssueSnapshot("DX-1", {
      comments: [
        { id: "c1", author: "a", timestamp: "", text: "hi" },
        { id: "c2", author: "b", timestamp: "", text: "ok" },
      ],
    });
    ret.applyIssueUpdate(updated);

    expect(ret.issues.value[0].comments_count).toBe(2);
    wrapper.unmount();
  });

  it("collapses waiting_on object to (boolean, reason, by[]) — non-null variant", async () => {
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const updated = makeIssueSnapshot("DX-1", {
      waiting_on: {
        reason: "Waits for DX-2",
        timestamp: "2026-05-10T00:00:00Z",
        by: ["DX-2"],
      },
    });
    ret.applyIssueUpdate(updated);

    const row = ret.issues.value[0];
    expect(row.waiting_on).toBe(true);
    expect(row.waiting_on_reason).toBe("Waits for DX-2");
    expect(row.waiting_on_by).toEqual(["DX-2"]);
    wrapper.unmount();
  });

  it("collapses waiting_on null to (false, null, [])", async () => {
    mockFetchIssues.mockResolvedValue([
      // Start with a row that has waiting_on=true so the merge is observable.
      {
        ...makeIssue("DX-1"),
        waiting_on: true,
        waiting_on_reason: "old",
        waiting_on_by: ["DX-99"],
      } as IssueListItem,
    ]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    ret.applyIssueUpdate(
      makeIssueSnapshot("DX-1", { waiting_on: null }),
    );

    const row = ret.issues.value[0];
    expect(row.waiting_on).toBe(false);
    expect(row.waiting_on_reason).toBeNull();
    expect(row.waiting_on_by).toEqual([]);
    wrapper.unmount();
  });

  it("invalidates the detail cache so the next fetchDetail re-fetches", async () => {
    const detail1 = { ...makeIssueSnapshot("DX-1"), updated_at: 1, created_at: 0, raw_yaml: "" };
    const detail2 = { ...makeIssueSnapshot("DX-1", { title: "Server" }), updated_at: 2, created_at: 0, raw_yaml: "" };
    mockFetchIssues.mockResolvedValue([makeIssue("DX-1")]);
    mockFetchIssueDetail.mockResolvedValueOnce(detail1);
    mockFetchIssueDetail.mockResolvedValueOnce(detail2);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const first = await ret.fetchDetail("DX-1");
    expect(first).toBe(detail1);
    // Cache HIT (no second fetch).
    const cached = await ret.fetchDetail("DX-1");
    expect(cached).toBe(detail1);
    expect(mockFetchIssueDetail).toHaveBeenCalledTimes(1);

    ret.applyIssueUpdate(makeIssueSnapshot("DX-1", { title: "Optimistic" }));

    // Cache MISS (invalidated by applyIssueUpdate) → second fetch fires.
    const refetched = await ret.fetchDetail("DX-1");
    expect(refetched).toBe(detail2);
    expect(mockFetchIssueDetail).toHaveBeenCalledTimes(2);
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

  it("bumps updated_at to a recent timestamp so the row sorts as freshly touched", async () => {
    mockFetchIssues.mockResolvedValue([
      { ...makeIssue("DX-1"), updated_at: 1_000 } as IssueListItem,
    ]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    const before = Date.now();
    ret.applyIssueUpdate(makeIssueSnapshot("DX-1"));
    const after = Date.now();

    const row = ret.issues.value[0];
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
    wrapper.unmount();
  });

  it("preserves untouched IssueListItem-only fields (children_detail, has_retro)", async () => {
    const listed = {
      ...makeIssue("DX-1"),
      children_detail: [
        {
          id: "DX-2",
          name: "child",
          type: "Feature" as const,
          status: "ToDo" as const,
          waiting_on: false,
          waiting_on_by_card: false,
          missing: false,
        },
      ],
      has_retro: true,
    } as IssueListItem;
    mockFetchIssues.mockResolvedValue([listed]);
    const { wrapper, ret } = mountWithIssues(ref("danxbot"));
    await flushPromises();

    ret.applyIssueUpdate(makeIssueSnapshot("DX-1", { title: "Renamed" }));

    const row = ret.issues.value[0];
    expect(row.title).toBe("Renamed");
    expect(row.children_detail).toEqual(listed.children_detail);
    expect(row.has_retro).toBe(true);
    wrapper.unmount();
  });
});
