import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import TriageButton from "./TriageButton.vue";
import type { IssueListItem } from "../../types";

function makeListItem(overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    id: "DX-1",
    type: "Feature",
    title: "candidate",
    description: "",
    status: "Review",
    parent_id: null,
    children: [],
    ac_total: 0,
    ac_done: 0,
    children_detail: [],
    waiting_on: false,
    waiting_on_reason: null,
    waiting_on_by: [],
    comments_count: 0,
    has_retro: false,
    updated_at: 0,
    created_at: 0,
    priority: 3,
    position: null,
    assigned_agent: null,
    ...overrides,
  } as IssueListItem;
}

const REVIEW_CARD = makeListItem({ id: "DX-1", status: "Review" });
const TODO_CARD = makeListItem({ id: "DX-2", status: "ToDo" });

function mountButton(opts: { repo?: string; candidates?: IssueListItem[] } = {}) {
  return mount(TriageButton, {
    props: {
      repo: opts.repo ?? "danxbot",
      candidates: opts.candidates ?? [REVIEW_CARD],
      initialIssueId: null,
    },
    global: {
      // Stub the dialog out — TriageDialog is covered by its own test.
      stubs: { TriageDialog: true },
    },
  });
}

describe("TriageButton (DX-518)", () => {
  it("is enabled when at least one triage-eligible candidate exists", () => {
    const w = mountButton({ candidates: [REVIEW_CARD] });
    const btn = w.get("[data-test='issues-triage-button']");
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it("is disabled when the candidates pool has no triage-eligible card", () => {
    const w = mountButton({ candidates: [TODO_CARD] });
    const btn = w.get("[data-test='issues-triage-button']");
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled when the repo prop is empty", () => {
    const w = mountButton({ repo: "", candidates: [REVIEW_CARD] });
    const btn = w.get("[data-test='issues-triage-button']");
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });
});
