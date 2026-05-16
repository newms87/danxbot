import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DispatchGatesSection from "./DispatchGatesSection.vue";
import type { IssueDetail } from "../../types";

vi.mock("../../api", () => ({ patchIssue: vi.fn() }));
import { patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 10,
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
    effort_level: null,
    assigned_agent: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    requires_human_child_count: 0,
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };
}

function mountSection(detail: IssueDetail) {
  return mount(DispatchGatesSection, {
    props: { issue: detail, repo: "danxbot" },
  });
}

describe("DispatchGatesSection", () => {
  beforeEach(() => patchMock.mockReset());

  it("renders nothing when every gate is empty", () => {
    const w = mountSection(makeDetail());
    expect(w.find('[data-test="dispatch-gates-section"]').exists()).toBe(false);
  });

  it("renders the requires_human banner when set", () => {
    const w = mountSection(
      makeDetail({
        requires_human: {
          reason: "need creds",
          steps: ["a"],
          set_by: "human",
          set_at: "2026-05-12T00:00:00Z",
        },
      }),
    );
    expect(w.find('[data-test="gate-requires-human"]').exists()).toBe(true);
    expect(w.text()).toContain("need creds");
  });

  it("banner starts collapsed and expands on click", async () => {
    const w = mountSection(
      makeDetail({
        blocked: { reason: "needs creds", at: "2026-05-12T00:00:00Z" },
      }),
    );
    expect(w.find('[data-test="gate-blocked-body"]').exists()).toBe(false);
    await w.find('[data-test="gate-blocked-toggle"]').trigger("click");
    expect(w.find('[data-test="gate-blocked-body"]').exists()).toBe(true);
  });

  it("blocked clear PATCHes blocked: null + status: ToDo", async () => {
    patchMock.mockResolvedValue(makeDetail() as never);
    const w = mountSection(
      makeDetail({
        blocked: { reason: "x", at: "2026-05-12T00:00:00Z" },
      }),
    );
    await w.find('[data-test="gate-blocked-toggle"]').trigger("click");
    await w.find('[data-test="gate-blocked-clear"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      blocked: null,
      status: "ToDo",
    });
  });

  it("waiting_on banner shows partner chip + emits jump-issue", async () => {
    const w = mountSection(
      makeDetail({
        waiting_on: {
          reason: "phase first",
          timestamp: "2026-05-12T00:00:00Z",
          by: ["DX-5"],
        },
      }),
    );
    await w.find('[data-test="gate-waiting-toggle"]').trigger("click");
    await w.find('[data-test="gate-waiting-jump-DX-5"]').trigger("click");
    expect(w.emitted("jump-issue")?.[0]).toEqual(["DX-5"]);
  });

  it("conflict_on banner clears a forward entry via PATCH", async () => {
    patchMock.mockResolvedValue(makeDetail() as never);
    const w = mountSection(
      makeDetail({
        conflict_on: [{ id: "DX-9", reason: "scheduler.ts collision" }],
      }),
    );
    await w.find('[data-test="gate-conflict-toggle"]').trigger("click");
    await w.find('[data-test="gate-conflict-clear-DX-9"]').trigger("click");
    await flushPromises();
    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      conflict_on: [],
    });
  });

  it("emits open-rh-editor when requires_human banner Edit button is clicked", async () => {
    const w = mountSection(
      makeDetail({
        requires_human: {
          reason: "x",
          steps: [],
          set_by: "human",
          set_at: "2026-05-12T00:00:00Z",
        },
      }),
    );
    await w.find('[data-test="gate-rh-toggle"]').trigger("click");
    await w.find('[data-test="gate-rh-edit"]').trigger("click");
    expect(w.emitted("open-rh-editor")).toBeTruthy();
  });
});
