import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import RequiresHumanPanel from "./RequiresHumanPanel.vue";
import type { IssueDetail, RequiresHuman } from "../../types";

// `patchIssue` is the only outbound call this panel makes. We stub it
// so the test asserts the wire shape (the field names + values the
// dashboard sends server-side) without standing up a real fetch. The
// server response shape is `{issue: Issue}`; `patchIssue` returns the
// inner Issue, so the mock returns the Issue directly.
const patchIssue = vi.fn();
vi.mock("../../api", () => ({
  patchIssue: (...args: unknown[]) => patchIssue(...args),
}));

function makeIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  const base: IssueDetail = {
    schema_version: 9,
    tracker: "memory",
    id: "DX-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Title",
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
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    history: [],
    assigned_agent: null,
    blocked: null,
    waiting_on: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    updated_at: 0,
    created_at: 0,
    raw_yaml: "",
    requires_human_child_count: 0,
    ...overrides,
    db_updated_at: "",
  };
  return base;
}

function mountPanel(issue: IssueDetail) {
  return mount(RequiresHumanPanel, { props: { issue, repo: "danxbot" } });
}

describe("RequiresHumanPanel", () => {
  beforeEach(() => {
    patchIssue.mockReset();
    patchIssue.mockResolvedValue(makeIssue());
  });

  // ── State A — requires_human != null ────────────────────────────────
  describe("state A — requires_human is set", () => {
    const reqHuman: RequiresHuman = {
      reason: "Need Stripe key rotated for new billing account",
      steps: [
        "Log into Stripe → API keys → Roll secret",
        "Update DANX_STRIPE_KEY in <repo>/.danxbot/.env",
        "Restart the worker container",
      ],
      set_by: "agent",
      set_at: "2026-05-10T16:50:00Z",
    };

    it("renders the reason text verbatim", () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      expect(w.get("[data-test='rh-reason']").text()).toBe(reqHuman.reason);
    });

    it("renders steps as a numbered list (<ol>) with one <li> per step in order", () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      const steps = w.findAll("[data-test='rh-steps'] .rh-step");
      expect(steps).toHaveLength(3);
      expect(steps[0].text()).toBe(reqHuman.steps[0]);
      expect(steps[1].text()).toBe(reqHuman.steps[1]);
      expect(steps[2].text()).toBe(reqHuman.steps[2]);
      expect(w.get("[data-test='rh-steps']").element.tagName).toBe("OL");
    });

    it("shows '(no steps provided)' placeholder when steps[] is empty", () => {
      const w = mountPanel(
        makeIssue({ requires_human: { ...reqHuman, steps: [] } }),
      );
      expect(w.find("[data-test='rh-steps']").exists()).toBe(false);
      expect(w.get("[data-test='rh-empty-steps']").text()).toBe(
        "(no steps provided)",
      );
    });

    it("surfaces set_by + relative set_at in the header", () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      // Don't pin to a literal "2h ago" because relativeTime is now-aware;
      // assert the prefix instead — that's the structural contract.
      expect(w.get("[data-test='rh-set-by']").text()).toMatch(/^Set by agent/);
    });

    it("renders 'Set by unknown' when the record is missing set_by", () => {
      const w = mountPanel(
        makeIssue({
          // Cast around the runtime-only fallback the panel handles.
          requires_human: {
            ...reqHuman,
            set_by: "" as unknown as "agent",
            set_at: "",
          },
        }),
      );
      expect(w.get("[data-test='rh-set-by']").text()).toBe("Set by unknown");
    });

    it("Mark Resolved button opens the inline confirm prompt; does NOT immediately PATCH", async () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      await w.get("[data-test='rh-mark-resolved']").trigger("click");
      expect(patchIssue).not.toHaveBeenCalled();
      expect(w.find("[data-test='rh-confirm']").exists()).toBe(true);
    });

    it("confirming clears the field with PATCH {requires_human: null} and emits patched", async () => {
      const patched = makeIssue({ requires_human: null });
      patchIssue.mockResolvedValue(patched);
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      await w.get("[data-test='rh-mark-resolved']").trigger("click");
      await w.get("[data-test='rh-confirm-yes']").trigger("click");
      // DX-262: see the modal save test for the rationale on vi.waitFor
      // over flushPromises under full-suite CPU contention.
      await vi.waitFor(() => {
        expect(patchIssue).toHaveBeenCalledTimes(1);
      });
      expect(patchIssue).toHaveBeenCalledWith("danxbot", "DX-1", {
        requires_human: null,
      });
      await vi.waitFor(() => {
        expect(w.emitted("patched")?.[0]?.[0]).toEqual(patched);
      });
    });

    it("cancel on the confirm prompt returns to action buttons without PATCH", async () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      await w.get("[data-test='rh-mark-resolved']").trigger("click");
      await w.get("[data-test='rh-confirm-cancel']").trigger("click");
      expect(patchIssue).not.toHaveBeenCalled();
      expect(w.find("[data-test='rh-confirm']").exists()).toBe(false);
      expect(w.find("[data-test='rh-mark-resolved']").exists()).toBe(true);
    });

    it("renders error inline when resolve PATCH rejects, keeps the confirm prompt open", async () => {
      patchIssue.mockRejectedValue(new Error("boom"));
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      await w.get("[data-test='rh-mark-resolved']").trigger("click");
      await w.get("[data-test='rh-confirm-yes']").trigger("click");
      // DX-262: error rendering is two cascaded reactive updates after the
      // rejected mock; see modal save test for full rationale on vi.waitFor.
      await vi.waitFor(() => {
        expect(w.get("[data-test='rh-resolve-error']").text()).toBe("boom");
      });
      // confirm UI is still open so the operator can retry
      expect(w.find("[data-test='rh-confirm']").exists()).toBe(true);
    });

    it("Edit button opens the modal pre-filled with current reason + steps", async () => {
      const w = mountPanel(makeIssue({ requires_human: reqHuman }));
      await w.get("[data-test='rh-edit']").trigger("click");
      const textarea = w.get("[data-test='rh-modal-reason']")
        .element as HTMLTextAreaElement;
      expect(textarea.value).toBe(reqHuman.reason);
      const inputs = w.findAll(".rh-step-input");
      expect(inputs).toHaveLength(3);
      expect((inputs[0].element as HTMLInputElement).value).toBe(
        reqHuman.steps[0],
      );
    });
  });

  // ── State B — requires_human == null ────────────────────────────────
  describe("state B — requires_human is null", () => {
    it("renders the compact 'Flag for human' button, NOT the panel", () => {
      const w = mountPanel(makeIssue({ requires_human: null }));
      expect(w.find("[data-test='rh-flag']").exists()).toBe(true);
      expect(w.find("[data-test='rh-reason']").exists()).toBe(false);
      expect(w.find("[data-test='rh-mark-resolved']").exists()).toBe(false);
    });

    it("clicking 'Flag for human' opens the modal with empty fields", async () => {
      const w = mountPanel(makeIssue({ requires_human: null }));
      await w.get("[data-test='rh-flag']").trigger("click");
      expect(w.find("[data-test='rh-modal']").exists()).toBe(true);
      const textarea = w.get("[data-test='rh-modal-reason']")
        .element as HTMLTextAreaElement;
      expect(textarea.value).toBe("");
      // Modal seeds one empty step row so the operator sees the affordance.
      expect(w.findAll(".rh-step-input")).toHaveLength(1);
    });
  });

  // ── Modal — shared by both Flag and Edit ─────────────────────────────
  describe("modal", () => {
    it("rejects save with an empty reason and does NOT PATCH", async () => {
      const w = mountPanel(makeIssue({ requires_human: null }));
      await w.get("[data-test='rh-flag']").trigger("click");
      await w.get("[data-test='rh-modal-save']").trigger("click");
      // DX-262: negative assertion — `vi.waitFor` can't gate on
      // `not.toHaveBeenCalled` (it would pass trivially on first poll);
      // flushPromises is correct here. saveModal returns early before any
      // await on the empty-reason guard so one macrotask drain is enough.
      await flushPromises();
      expect(patchIssue).not.toHaveBeenCalled();
      expect(w.get("[data-test='rh-modal-error']").text()).toBe(
        "Reason is required",
      );
    });

    it("saving with reason + non-empty steps PATCHes with set_by: 'human' placeholder (server-stamped)", async () => {
      const patched = makeIssue({
        requires_human: {
          reason: "Need access to Slack",
          steps: ["Invite the bot user"],
          set_by: "human",
          set_at: "2026-05-10T17:00:00Z",
        },
      });
      patchIssue.mockResolvedValue(patched);
      const w = mountPanel(makeIssue({ requires_human: null }));
      await w.get("[data-test='rh-flag']").trigger("click");
      await w.get("[data-test='rh-modal-reason']").setValue("Need access to Slack");
      // Modal seeded one row — fill it in.
      await w.get(".rh-step-input").setValue("Invite the bot user");
      await w.get("[data-test='rh-modal-save']").trigger("click");
      // DX-262: `await flushPromises()` is a single setTimeout(0) tick — under
      // full-suite CPU contention, the chained reactive updates that follow
      // the click (saveModal sync portion → modalSaving=true render flush →
      // mocked patchIssue resolves → emit("patched") → modalOpen=false →
      // unmount flush) don't always land inside that one tick. vi.waitFor
      // polls until the call count is observable, decoupling the assertion
      // from the exact macrotask scheduling order.
      await vi.waitFor(() => {
        expect(patchIssue).toHaveBeenCalledTimes(1);
      });
      // Wire shape is the slim RequiresHumanPatchInput — set_by + set_at
      // are server-stamped and intentionally NOT sent (DX-239).
      expect(patchIssue).toHaveBeenCalledWith("danxbot", "DX-1", {
        requires_human: {
          reason: "Need access to Slack",
          steps: ["Invite the bot user"],
        },
      });
      await vi.waitFor(() => {
        expect(w.emitted("patched")?.[0]?.[0]).toEqual(patched);
        expect(w.find("[data-test='rh-modal']").exists()).toBe(false);
      });
    });

    it("drops a trailing empty step row so the operator's 'about to add another' row isn't persisted", async () => {
      patchIssue.mockResolvedValue(makeIssue());
      const w = mountPanel(makeIssue({ requires_human: null }));
      await w.get("[data-test='rh-flag']").trigger("click");
      await w.get("[data-test='rh-modal-reason']").setValue("Rotate Stripe key");
      // Seeded row stays empty; click Add to grow to two; fill only the
      // first; save. Expected: steps[] has 1 entry only.
      await w.get("[data-test='rh-modal-add-step']").trigger("click");
      const inputs = w.findAll(".rh-step-input");
      expect(inputs).toHaveLength(2);
      await inputs[0].setValue("Step one");
      // second row left empty
      await w.get("[data-test='rh-modal-save']").trigger("click");
      // DX-262: see the modal save test for the rationale on vi.waitFor.
      await vi.waitFor(() => {
        expect(patchIssue).toHaveBeenCalledTimes(1);
      });
      expect(patchIssue).toHaveBeenCalledWith("danxbot", "DX-1", {
        requires_human: {
          reason: "Rotate Stripe key",
          steps: ["Step one"],
        },
      });
    });

    it("renders the server error inline when PATCH rejects, keeps the modal open", async () => {
      patchIssue.mockRejectedValue(new Error("400 bad shape"));
      const w = mountPanel(makeIssue({ requires_human: null }));
      await w.get("[data-test='rh-flag']").trigger("click");
      await w.get("[data-test='rh-modal-reason']").setValue("Reason");
      await w.get(".rh-step-input").setValue("Step");
      await w.get("[data-test='rh-modal-save']").trigger("click");
      // DX-262: error rendering is two cascaded reactive updates after the
      // rejected mock; see modal save test for full rationale on vi.waitFor.
      await vi.waitFor(() => {
        expect(w.get("[data-test='rh-modal-error']").text()).toBe(
          "400 bad shape",
        );
      });
      // Modal stays open so the operator can fix + retry
      expect(w.find("[data-test='rh-modal']").exists()).toBe(true);
    });
  });
});
