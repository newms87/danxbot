import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { IssueListItem, IssueStatus } from "../types";

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
