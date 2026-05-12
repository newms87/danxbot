import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import IssueDetailView from "./IssueDetailView.vue";
import type { IssueDetail } from "../../types";

// `IssueDispatch` lives on the backend issue-tracker interface; the SPA
// only ever reads it nested under `IssueDetail.dispatch`, so the test
// inlines a minimal subset rather than re-exporting the full type.
interface DispatchRecord {
  id: string;
  pid: number;
  host: string;
  kind: "work";
  started_at: string;
  ttl_seconds: number;
}

// Stub the tab components — they have their own PATCH wiring that the
// banner test does not exercise, and pulling them in would require
// mocking patchIssue everywhere.
const Stub = (name: string) =>
  defineComponent({
    name,
    props: ["issue", "allIssues", "repo", "selectedRepo", "scopedEpicId"],
    setup: () => () => h("div", { class: `stub-${name.toLowerCase()}` }),
  });

const stubs = {
  DrawerHeader: Stub("DrawerHeader"),
  OverviewTab: Stub("OverviewTab"),
  ACTab: Stub("ACTab"),
  ChildrenTab: Stub("ChildrenTab"),
  CommentsTab: Stub("CommentsTab"),
  RetroTab: Stub("RetroTab"),
  RawTab: Stub("RawTab"),
  HistoryTab: Stub("HistoryTab"),
  AgentChat: Stub("AgentChat"),
};

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 7,
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
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    requires_human_child_count: 0,
    ...overrides,
  };
}

function mountView(issue: IssueDetail | null, loading = false) {
  return mount(IssueDetailView, {
    props: {
      issue,
      loading,
      allIssues: [],
      scopedEpicId: null,
      selectedRepo: "danxbot",
    },
    global: { stubs },
  });
}

describe("IssueDetailView active-dispatch banner", () => {
  it("does not render the banner when issue.dispatch is null", () => {
    const w = mountView(makeDetail({ dispatch: null }));
    expect(w.find('[data-test="active-dispatch-banner"]').exists()).toBe(false);
  });

  it("renders the banner when issue.dispatch is non-null", () => {
    const dispatch: DispatchRecord = {
      id: "abc",
      pid: 1234,
      host: "dan",
      kind: "work",
      started_at: "2026-05-10T12:00:00Z",
      ttl_seconds: 3600,
    };
    const w = mountView(
      makeDetail({ dispatch }),
    );
    const banner = w.get('[data-test="active-dispatch-banner"]');
    expect(banner.text()).toContain("Agent is working on this card");
  });

  it("hides the banner during the initial loading state", () => {
    const w = mountView(null, true);
    expect(w.find('[data-test="active-dispatch-banner"]').exists()).toBe(false);
  });
});

describe("IssueDetailView update:issue forwarding", () => {
  // Tab stub that emits update:issue on click; verifies the re-emit
  // glue from any tab → IssuesPage. A rename of the emit name in any
  // tab would break this test.
  const EmittingTab = defineComponent({
    name: "OverviewTab",
    props: ["issue", "repo"],
    emits: ["jump-issue", "update:issue"],
    setup(_, { emit }) {
      return () =>
        h(
          "button",
          {
            class: "stub-emit",
            "data-test": "stub-emit",
            onClick: () =>
              emit("update:issue", { id: "FAKE", title: "new" }),
          },
          "emit",
        );
    },
  });

  it("re-emits update:issue from a tab so IssuesPage can apply it", async () => {
    const w = mount(IssueDetailView, {
      props: {
        issue: makeDetail(),
        loading: false,
        allIssues: [],
        scopedEpicId: null,
        selectedRepo: "danxbot",
      },
      global: {
        stubs: {
          ...stubs,
          OverviewTab: EmittingTab,
        },
      },
    });

    await w.get('[data-test="stub-emit"]').trigger("click");
    const events = w.emitted("update:issue");
    expect(events).toBeTruthy();
    expect(events![0][0]).toEqual({ id: "FAKE", title: "new" });
  });
});
