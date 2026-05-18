import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import TriageTab from "./TriageTab.vue";
import type { IssueDetail, IssueTriage, IssueTriageHistoryEntry } from "../../types";

// Stub the markdown renderer the same way OverviewTab/CommentsTab tests do —
// the real `MarkdownEditor` from `@thehammer/danx-ui` is heavy, and the tab
// test only needs to assert that the explain text reaches the renderer.
const MarkdownEditorStub = defineComponent({
  name: "MarkdownEditor",
  props: ["modelValue"],
  setup: (props) => () =>
    h("div", { class: "stub-md", "data-test": "stub-md" }, String(props.modelValue ?? "")),
});

function makeEntry(over: Partial<IssueTriageHistoryEntry> = {}): IssueTriageHistoryEntry {
  return {
    timestamp: "2026-05-14T12:00:00Z",
    status: "Keep",
    explain: "Looks good — leave it.",
    expires_at: "2026-05-15T12:00:00Z",
    ice: { total: 60, i: 5, c: 4, e: 3 },
    ...over,
  };
}

function makeTriage(over: Partial<IssueTriage> = {}): IssueTriage {
  return {
    expires_at: "2026-05-15T12:00:00Z",
    reassess_hint: "",
    last_status: "Keep",
    last_explain: "Looks good — leave it.",
    ice: { total: 60, i: 5, c: 4, e: 3 },
    history: [makeEntry()],
    ...over,
  };
}

function makeIssue(triage: IssueTriage): IssueDetail {
  return {
    schema_version: 12,
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
    triage,
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
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  } as IssueDetail;
}

function mountTab(issue: IssueDetail) {
  return mount(TriageTab, {
    props: { issue },
    global: { stubs: { MarkdownEditor: MarkdownEditorStub } },
  });
}

describe("TriageTab — header (AC #2)", () => {
  it("renders last_status badge with the status text", () => {
    const w = mountTab(makeIssue(makeTriage({ last_status: "Approve" })));
    expect(w.get("[data-test='triage-status-badge']").text()).toBe("Approve");
  });

  it("renders relative future expiry as 'expires in <N><unit>' when expires_at > now", () => {
    const future = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const w = mountTab(makeIssue(makeTriage({ expires_at: future })));
    const text = w.get("[data-test='triage-expires']").text();
    expect(text).toMatch(/^expires in \d+[mhd]$/);
  });

  it("renders past expiry as 'expired <N><unit> ago' when expires_at <= now", () => {
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const w = mountTab(makeIssue(makeTriage({ expires_at: past })));
    const text = w.get("[data-test='triage-expires']").text();
    expect(text).toMatch(/^expired \d+[mhd] ago$/);
  });
});

describe("TriageTab — ICE breakdown (AC #3)", () => {
  it("renders I, C, E rows + total for last_status='Keep'", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Keep",
      ice: { total: 60, i: 5, c: 4, e: 3 },
    })));
    const section = w.get("[data-test='triage-ice']");
    expect(section.get("[data-test='triage-ice-i']").text()).toContain("5");
    expect(section.get("[data-test='triage-ice-c']").text()).toContain("4");
    expect(section.get("[data-test='triage-ice-e']").text()).toContain("3");
    expect(section.get("[data-test='triage-ice-total']").text()).toContain("60");
  });

  it("renders ICE breakdown for last_status='Approve'", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Approve",
      ice: { total: 24, i: 4, c: 3, e: 2 },
    })));
    expect(w.find("[data-test='triage-ice']").exists()).toBe(true);
  });

  it("suppresses ICE breakdown for non-Keep/Approve statuses (Cancel)", () => {
    const w = mountTab(makeIssue(makeTriage({ last_status: "Cancel" })));
    expect(w.find("[data-test='triage-ice']").exists()).toBe(false);
  });

  it("suppresses ICE breakdown for Confirm-Block", () => {
    const w = mountTab(makeIssue(makeTriage({ last_status: "Confirm-Block" })));
    expect(w.find("[data-test='triage-ice']").exists()).toBe(false);
  });
});

describe("TriageTab — last_explain (AC #4)", () => {
  it("routes last_explain through MarkdownEditor (renderer)", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_explain: "**Bold** rationale.",
    })));
    const stubs = w.findAll("[data-test='stub-md']");
    expect(stubs.length).toBeGreaterThan(0);
    expect(stubs[0].text()).toContain("**Bold** rationale.");
  });
});

describe("TriageTab — reassess_hint (AC #5)", () => {
  it("renders reassess_hint for Confirm-Block when non-empty", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Confirm-Block",
      reassess_hint: "If GPT deploys, demote.",
    })));
    expect(w.find("[data-test='triage-hint']").exists()).toBe(true);
    expect(w.get("[data-test='triage-hint']").text()).toContain("If GPT deploys, demote.");
  });

  it("suppresses reassess_hint when empty", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Confirm-Block",
      reassess_hint: "",
    })));
    expect(w.find("[data-test='triage-hint']").exists()).toBe(false);
  });

  it("suppresses reassess_hint on Keep even when non-empty", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Keep",
      reassess_hint: "Re-check in a week.",
    })));
    expect(w.find("[data-test='triage-hint']").exists()).toBe(false);
  });

  it("suppresses reassess_hint on Demote even when non-empty", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Demote",
      reassess_hint: "Recheck shortly.",
    })));
    expect(w.find("[data-test='triage-hint']").exists()).toBe(false);
  });

  it("suppresses reassess_hint on Unblock even when non-empty", () => {
    const w = mountTab(makeIssue(makeTriage({
      last_status: "Unblock",
      reassess_hint: "If the dep moves back to Blocked, re-evaluate.",
    })));
    expect(w.find("[data-test='triage-hint']").exists()).toBe(false);
  });
});

describe("TriageTab — history timeline (AC #6)", () => {
  it("lists history newest-first by timestamp", () => {
    const older = makeEntry({
      timestamp: "2026-05-10T00:00:00Z",
      status: "Keep",
      explain: "older entry",
      ice: { total: 50, i: 5, c: 5, e: 2 },
    });
    const newer = makeEntry({
      timestamp: "2026-05-14T12:00:00Z",
      status: "Approve",
      explain: "newer entry",
      ice: { total: 60, i: 5, c: 4, e: 3 },
    });
    const w = mountTab(makeIssue(makeTriage({
      history: [older, newer],
      last_status: "Approve",
    })));
    const rows = w.findAll("[data-test='triage-history-row']");
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("newer entry");
    expect(rows[1].text()).toContain("older entry");
  });

  it("caps history rendering at 10 entries even if more are supplied", () => {
    const many: IssueTriageHistoryEntry[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(
        makeEntry({
          timestamp: `2026-05-${(10 + i).toString().padStart(2, "0")}T00:00:00Z`,
          explain: `entry-${i}`,
        }),
      );
    }
    const w = mountTab(makeIssue(makeTriage({ history: many })));
    const rows = w.findAll("[data-test='triage-history-row']");
    expect(rows.length).toBe(10);
  });

  it("renders timestamp, status, explain, and ICE total per row", () => {
    const e = makeEntry({
      timestamp: "2026-05-14T00:00:00Z",
      status: "Keep",
      explain: "row explain",
      ice: { total: 36, i: 4, c: 3, e: 3 },
    });
    const w = mountTab(makeIssue(makeTriage({ history: [e] })));
    const row = w.get("[data-test='triage-history-row']");
    expect(row.text()).toContain("Keep");
    expect(row.text()).toContain("row explain");
    expect(row.text()).toContain("ICE 36");
  });
});

describe("TriageTab — SSE reactivity (AC #7)", () => {
  it("updates when the `issue` prop changes (Vue reactivity = SSE reactivity)", async () => {
    const first = makeIssue(makeTriage({
      last_status: "Keep",
      last_explain: "first explain",
    }));
    const second = makeIssue(makeTriage({
      last_status: "Approve",
      last_explain: "second explain",
    }));
    const w = mountTab(first);
    expect(w.get("[data-test='triage-status-badge']").text()).toBe("Keep");
    await w.setProps({ issue: second });
    expect(w.get("[data-test='triage-status-badge']").text()).toBe("Approve");
    expect(w.findAll("[data-test='stub-md']")[0].text()).toContain("second explain");
  });
});
