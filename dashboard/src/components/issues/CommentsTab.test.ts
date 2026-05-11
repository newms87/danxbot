import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CommentsTab from "./CommentsTab.vue";
import type { Issue, IssueComment, IssueDetail } from "../../types";

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
    assigned_agent: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    ...overrides,
  } as unknown as IssueDetail;
}

function mountTab(detail: IssueDetail = makeDetail()) {
  return mount(CommentsTab, {
    props: { issue: detail, repo: "danxbot" },
    global: { stubs: { MarkdownEditor: MarkdownEditorStub } },
  });
}

describe("CommentsTab", () => {
  beforeEach(() => {
    patchMock.mockReset();
  });

  it("renders existing comments and the composer", () => {
    const existing: IssueComment[] = [
      {
        id: "a",
        author: "dan",
        timestamp: "2026-05-01T00:00:00Z",
        text: "Hello",
      },
    ];
    const w = mountTab(makeDetail({ comments: existing }));
    expect(w.html()).toContain("Hello");
    expect(w.find('[data-test="comment-composer"]').exists()).toBe(true);
    expect(w.find('[data-test="comment-post"]').exists()).toBe(true);
  });

  it("Post button is disabled until the textarea has non-blank content", async () => {
    const w = mountTab();
    expect(
      (w.get('[data-test="comment-post"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await w.get('[data-test="comment-composer"]').setValue("hi");
    expect(
      (w.get('[data-test="comment-post"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("inserts an optimistic pending comment, calls patchIssue, and emits update:issue", async () => {
    let resolvePatch!: (issue: Issue) => void;
    patchMock.mockImplementation(
      () => new Promise<Issue>((res) => { resolvePatch = res; }),
    );

    const w = mountTab();
    await w.get('[data-test="comment-composer"]').setValue("first thought");
    await w.get('[data-test="comment-post"]').trigger("click");

    // Pending comment is visible immediately (optimistic).
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(true);
    expect(w.find('[data-test="comment-pending"]').html()).toContain(
      "first thought",
    );

    // Composer + Post disabled while in flight.
    const composerEl = w.get('[data-test="comment-composer"]')
      .element as HTMLTextAreaElement;
    const postEl = w.get('[data-test="comment-post"]')
      .element as HTMLButtonElement;
    expect(composerEl.disabled).toBe(true);
    expect(postEl.disabled).toBe(true);

    expect(patchMock).toHaveBeenCalledWith("danxbot", "DX-1", {
      comments_append: { text: "first thought" },
    });

    const stamped = makeDetail({
      comments: [
        {
          id: "srv-1",
          author: "monitor",
          timestamp: "2026-05-10T12:00:00Z",
          text: "first thought",
        },
      ],
    }) as unknown as Issue;
    resolvePatch(stamped);
    await flushPromises();

    const events = w.emitted("update:issue");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe(stamped);
    // Composer cleared.
    expect(
      (w.get('[data-test="comment-composer"]').element as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  it("reconciles the pending bubble away once the SSE-driven prop update lands a real comment with matching text", async () => {
    let resolvePatch!: (issue: Issue) => void;
    patchMock.mockImplementation(
      () => new Promise<Issue>((res) => { resolvePatch = res; }),
    );

    const w = mountTab();
    await w.get('[data-test="comment-composer"]').setValue("hi everyone");
    await w.get('[data-test="comment-post"]').trigger("click");
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(true);

    resolvePatch(makeDetail({}) as unknown as Issue);
    await flushPromises();
    // Simulate the parent forwarding the server-stamped issue back.
    await w.setProps({
      issue: makeDetail({
        comments: [
          {
            id: "srv-1",
            author: "monitor",
            timestamp: "2026-05-10T12:00:00Z",
            text: "hi everyone",
          },
        ],
      }),
    });

    // Pending bubble dropped; real bubble with server-stamped author is shown.
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(false);
    const real = w.findAll('[data-test="comment-real"]');
    expect(real).toHaveLength(1);
    expect(real[0].html()).toContain("monitor");
    expect(real[0].html()).toContain("hi everyone");
  });

  it("pending bubble survives an unrelated parent prop update whose comments contain text-matching server data", async () => {
    // Text-equality dedupe (earlier draft) would drop our in-flight
    // pending the moment any unrelated parent update lands a comment
    // whose text matches — e.g. a 30s poll tick that hydrated a
    // pre-existing comment with the same wording. Key-based dedupe
    // keeps the pending around until OUR PATCH resolves.
    let resolvePatch!: (issue: Issue) => void;
    patchMock.mockImplementation(
      () => new Promise<Issue>((res) => { resolvePatch = res; }),
    );

    const w = mountTab();
    await w.get('[data-test="comment-composer"]').setValue("ok");
    await w.get('[data-test="comment-post"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(true);

    // Parent forwards a prop update that happens to include a comment
    // whose text matches our pending — but authored by someone else
    // (NOT our PATCH's confirmation).
    await w.setProps({
      issue: makeDetail({
        comments: [
          {
            id: "old",
            author: "someone-else",
            timestamp: "2026-05-01T00:00:00Z",
            text: "ok",
          },
        ],
      }),
    });
    // Pending must survive — it's keyed, not text-matched.
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(true);

    const postPatch = makeDetail({
      comments: [
        {
          id: "old",
          author: "someone-else",
          timestamp: "2026-05-01T00:00:00Z",
          text: "ok",
        },
        {
          id: "ours",
          author: "monitor",
          timestamp: "2026-05-10T12:00:00Z",
          text: "ok",
        },
      ],
    });
    resolvePatch(postPatch as unknown as Issue);
    await flushPromises();
    // Simulate the parent receiving the emit and forwarding the
    // post-PATCH issue back down.
    await w.setProps({ issue: postPatch });

    // Our PATCH resolved → pending removed by key; both server comments
    // visible.
    expect(w.find('[data-test="comment-pending"]').exists()).toBe(false);
    expect(w.findAll('[data-test="comment-real"]')).toHaveLength(2);
  });

  it("removes the optimistic bubble and surfaces the error when PATCH rejects", async () => {
    patchMock.mockRejectedValue(new Error("server says no"));

    const w = mountTab();
    await w.get('[data-test="comment-composer"]').setValue("bad post");
    await w.get('[data-test="comment-post"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="comment-pending"]').exists()).toBe(false);
    expect(w.get('[data-test="comment-error"]').text()).toContain(
      "server says no",
    );
    expect(w.emitted("update:issue")).toBeUndefined();
    // Composer re-enabled with the same content so the user can edit + retry.
    expect(
      (w.get('[data-test="comment-composer"]').element as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
    expect(
      (w.get('[data-test="comment-composer"]').element as HTMLTextAreaElement)
        .value,
    ).toBe("bad post");
  });
});
