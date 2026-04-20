import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import FeatureToggle from "./FeatureToggle.vue";

describe("FeatureToggle", () => {
  it("renders 'Enabled' when the override resolves to true", () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: true,
        envDefault: false,
      },
    });
    expect(w.text()).toContain("Enabled");
    expect(w.find('[role="switch"]').attributes("aria-checked")).toBe("true");
  });

  it("renders 'Disabled' when the override resolves to false", () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: false,
        envDefault: true,
      },
    });
    expect(w.text()).toContain("Disabled");
  });

  it("falls back to env default when override is null and shows a '(default)' hint", () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "trelloPoller",
        label: "Trello poller",
        enabled: null,
        envDefault: true,
      },
    });
    expect(w.text()).toContain("Enabled");
    expect(w.text()).toContain("(default)");
  });

  it("emits change with the flipped value when clicked (true → false)", async () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: true,
        envDefault: false,
      },
    });

    await w.get('[role="switch"]').trigger("click");

    const events = w.emitted<[string, boolean | null]>("change");
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual(["slack", false]);
  });

  it("cycles null → opposite-of-env-default on click so the flip is visible", async () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "trelloPoller",
        label: "Trello poller",
        enabled: null,
        envDefault: true,
      },
    });

    await w.get('[role="switch"]').trigger("click");

    const events = w.emitted<[string, boolean | null]>("change");
    expect(events![0]).toEqual(["trelloPoller", false]);
  });

  it("emits change(feature, null) when the reset button is clicked", async () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: false,
        envDefault: true,
      },
    });

    const resetButton = w.findAll("button").find((b) => b.text() === "reset");
    expect(resetButton).toBeTruthy();
    await resetButton!.trigger("click");

    const events = w.emitted<[string, boolean | null]>("change");
    // Exactly one emit — the reset click must not fall through to the
    // switch handler (which would double-emit).
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual(["slack", null]);
  });

  it("does not emit change when busy is true", async () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: true,
        envDefault: false,
        busy: true,
      },
    });

    await w.get('[role="switch"]').trigger("click");

    expect(w.emitted("change")).toBeUndefined();
  });

  it("renders the subline when provided", () => {
    const w = mount(FeatureToggle, {
      props: {
        feature: "slack",
        label: "Slack",
        enabled: null,
        envDefault: true,
        subline: "12 total / 3 last 24h",
      },
    });
    expect(w.text()).toContain("12 total / 3 last 24h");
  });
});
