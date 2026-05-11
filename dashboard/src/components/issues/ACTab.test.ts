import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ACTab from "./ACTab.vue";
import type { Issue, IssueAcItem, IssueDetail } from "../../types";

vi.mock("../../api", () => ({
  patchIssue: vi.fn(),
}));

import { patchIssue } from "../../api";
const patchMock = vi.mocked(patchIssue);

const MarkdownEditorStub = {
  name: "MarkdownEditor",
  props: ["modelValue", "readonly", "hideFooter"],
  template: `<div class="md-stub">{{ modelValue }}</div>`,
};

function makeAc(): IssueAcItem[] {
  return [
    { check_item_id: "id-1", title: "First AC", checked: false },
    { check_item_id: "id-2", title: "Second AC", checked: false },
    { check_item_id: "id-3", title: "Third AC", checked: true },
  ];
}

function makeDetail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    schema_version: 6,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Card 1",
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
    ac: makeAc(),
    comments: [],
    history: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    waiting_on: null,
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    ...overrides,
  } as unknown as IssueDetail;
}

function mountACTab(detail: IssueDetail = makeDetail()) {
  return mount(ACTab, {
    props: { issue: detail, repo: "danxbot" },
    global: { stubs: { MarkdownEditor: MarkdownEditorStub } },
  });
}

describe("ACTab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    patchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one row per AC item with the current checked state", () => {
    const w = mountACTab();
    expect(w.get('[data-test="ac-row-0"]').text()).toContain("First AC");
    expect(w.get('[data-test="ac-row-2"]').classes()).toContain("done");
    expect(w.get('[data-test="ac-row-0"]').classes()).not.toContain("done");
  });

  it("toggles the row immediately on click (optimistic) before the PATCH fires", async () => {
    const w = mountACTab();
    await w.get('[data-test="ac-row-0"]').trigger("click");
    expect(w.get('[data-test="ac-row-0"]').classes()).toContain("done");
    // PATCH is debounced — not yet called.
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("debounces multiple toggles into a single PATCH with the full ac array", async () => {
    const patched: Issue = {
      ...makeDetail({
        ac: [
          { check_item_id: "id-1", title: "First AC", checked: true },
          { check_item_id: "id-2", title: "Second AC", checked: true },
          { check_item_id: "id-3", title: "Third AC", checked: true },
        ],
      }),
    } as unknown as Issue;
    patchMock.mockResolvedValue(patched);

    const w = mountACTab();
    await w.get('[data-test="ac-row-0"]').trigger("click");
    await w.get('[data-test="ac-row-1"]').trigger("click");
    vi.advanceTimersByTime(299);
    expect(patchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    await flushPromises();
    expect(patchMock).toHaveBeenCalledTimes(1);
    const [, , patch] = patchMock.mock.calls[0];
    expect(patch.ac).toBeDefined();
    expect(patch.ac![0].checked).toBe(true);
    expect(patch.ac![1].checked).toBe(true);
    expect(patch.ac![2].checked).toBe(true);
    expect(patch.ac).toHaveLength(3);
  });

  it("emits update:issue with the server response on success", async () => {
    const patched = {
      ...makeDetail({
        ac: [
          { check_item_id: "id-1", title: "First AC", checked: true },
          { check_item_id: "id-2", title: "Second AC", checked: false },
          { check_item_id: "id-3", title: "Third AC", checked: true },
        ],
      }),
    } as unknown as Issue;
    patchMock.mockResolvedValue(patched);

    const w = mountACTab();
    await w.get('[data-test="ac-row-0"]').trigger("click");
    vi.advanceTimersByTime(301);
    await flushPromises();

    const events = w.emitted("update:issue");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe(patched);
  });

  it("reverts the optimistic toggle when the PATCH rejects and surfaces the error", async () => {
    patchMock.mockRejectedValue(new Error("boom"));
    const w = mountACTab();
    await w.get('[data-test="ac-row-0"]').trigger("click");
    // Optimistic flip is visible.
    expect(w.get('[data-test="ac-row-0"]').classes()).toContain("done");
    vi.advanceTimersByTime(301);
    await flushPromises();
    // Reverted back to canonical server state.
    expect(w.get('[data-test="ac-row-0"]').classes()).not.toContain("done");
    expect(w.get('[data-test="ac-error"]').text()).toContain("boom");
    // No update:issue emitted because the PATCH failed.
    expect(w.emitted("update:issue")).toBeUndefined();
  });

  it("shows the saving indicator while the PATCH is in flight", async () => {
    let resolvePatch!: (issue: Issue) => void;
    patchMock.mockImplementation(
      () => new Promise<Issue>((res) => { resolvePatch = res; }),
    );
    const w = mountACTab();
    await w.get('[data-test="ac-row-0"]').trigger("click");
    vi.advanceTimersByTime(301);
    await flushPromises();
    expect(w.find('[data-test="ac-saving"]').exists()).toBe(true);
    resolvePatch({
      ...makeDetail({ ac: makeAc() }),
    } as unknown as Issue);
    await flushPromises();
    expect(w.find('[data-test="ac-saving"]').exists()).toBe(false);
  });

  it("renders the empty-state when ac[] is empty", () => {
    const w = mountACTab(makeDetail({ ac: [] }));
    expect(w.text()).toContain("No acceptance criteria");
  });
});
