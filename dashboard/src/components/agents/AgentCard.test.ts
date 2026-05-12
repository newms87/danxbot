import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import AgentCard from "./AgentCard.vue";
import type { AgentRosterEntry } from "../../types";

// AgentAvatar performs an authed avatar fetch (`fetchAgentAvatarUrl`)
// on mount which would hit the network in vitest's happy-dom env. Stub
// it — the broken banner contract under test does not depend on the
// avatar surface.
const AgentAvatarStub = defineComponent({
  name: "AgentAvatar",
  props: {
    repo: { type: String, required: true },
    name: { type: String, required: true },
    avatarPath: { type: String, default: undefined },
    size: { type: Number, default: undefined },
  },
  setup: () =>
    () =>
      h("div", { class: "agent-avatar-stub" }),
});

const VALID_SCHEDULE = {
  tz: "America/Chicago",
  always_on: false,
  mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
};

function buildAgent(over: Partial<AgentRosterEntry> = {}): AgentRosterEntry {
  return {
    name: "alice",
    type: "agent",
    bio: "Senior worker.",
    capabilities: ["issue-worker"],
    schedule: VALID_SCHEDULE,
    enabled: true,
    broken: null,
    created_at: "2026-05-08T12:00:00Z",
    updated_at: "2026-05-08T12:00:00Z",
    ...over,
  };
}

function mountCard(agent: AgentRosterEntry) {
  return mount(AgentCard, {
    props: { agent, repo: "danxbot" },
    global: { stubs: { AgentAvatar: AgentAvatarStub } },
  });
}

const REAL_DATE_NOW = Date.now;

beforeEach(() => {
  // Pin "now" so the relative-time label is deterministic. 12:30 set_at
  // + 12:35 now = "Set 5m ago" in formatElapsed.
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-05-12T07:35:00Z"),
  );
});

afterEach(() => {
  Date.now = REAL_DATE_NOW;
});

describe("AgentCard — DX-298 broken banner", () => {
  it("does NOT render the broken banner when broken === null (healthy agent)", () => {
    const w = mountCard(buildAgent({ broken: null }));
    expect(w.find('[data-test="agent-broken-banner-alice"]').exists()).toBe(
      false,
    );
    expect(w.classes()).not.toContain("card-broken");
  });

  it("renders the red banner with title + reason + steps when broken is populated", () => {
    const broken = {
      reason: "Rebase conflict on origin/main needs manual resolution",
      suggested_steps: [
        "SSH to the worker host",
        "cd into the agent worktree",
        "Resolve markers + push",
      ],
      set_at: "2026-05-12T07:30:00Z",
    };
    const w = mountCard(buildAgent({ broken }));
    // `.get` throws if the element is missing — its presence IS the
    // assertion. No follow-up `.exists()` needed.
    const banner = w.get('[data-test="agent-broken-banner-alice"]');
    expect(banner.attributes("role")).toBe("alert");

    expect(w.get('[data-test="agent-broken-title-alice"]').text()).toContain(
      "Agent alice is broken",
    );
    expect(w.get('[data-test="agent-broken-reason-alice"]').text()).toBe(
      broken.reason,
    );

    const steps = w.get('[data-test="agent-broken-steps-alice"]');
    const items = steps.findAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].text()).toBe("SSH to the worker host");
    expect(items[2].text()).toBe("Resolve markers + push");

    // Card root carries the broken modifier class so the border picks
    // up the red accent.
    expect(w.classes()).toContain("card-broken");
  });

  it("renders the italic 'Set Nm ago' subtitle from set_at relative to now", () => {
    const broken = {
      reason: "anything",
      suggested_steps: [],
      set_at: "2026-05-12T07:30:00Z",
    };
    const w = mountCard(buildAgent({ broken }));
    const label = w.get('[data-test="agent-broken-set-at-alice"]').text();
    // 5 min elapsed → "Set 5m ago"
    expect(label).toBe("Set 5m ago");
  });

  it("omits the suggested-steps block when suggested_steps is empty (banner stays minimal)", () => {
    const broken = {
      reason: "anything",
      suggested_steps: [],
      set_at: "2026-05-12T07:30:00Z",
    };
    const w = mountCard(buildAgent({ broken }));
    expect(w.find('[data-test="agent-broken-steps-alice"]').exists()).toBe(
      false,
    );
  });

  it("emits 'resolve' with the agent payload when Mark Resolved is clicked", async () => {
    const agent = buildAgent({
      broken: {
        reason: "stale lockfile",
        suggested_steps: [],
        set_at: "2026-05-12T07:30:00Z",
      },
    });
    const w = mountCard(agent);
    await w.get('[data-test="agent-resolve-alice"]').trigger("click");
    const emitted = w.emitted("resolve");
    expect(emitted).toHaveLength(1);
    expect(emitted![0][0]).toEqual(agent);
  });

  it("Mark Resolved button is absent when the agent is healthy", () => {
    const w = mountCard(buildAgent({ broken: null }));
    expect(w.find('[data-test="agent-resolve-alice"]').exists()).toBe(false);
  });

  it("falls back to the raw set_at string when Date.parse can't interpret it (defense in depth)", () => {
    const broken = {
      reason: "anything",
      suggested_steps: [],
      set_at: "not-a-date",
    };
    const w = mountCard(buildAgent({ broken }));
    expect(w.get('[data-test="agent-broken-set-at-alice"]').text()).toBe(
      "not-a-date",
    );
  });
});
