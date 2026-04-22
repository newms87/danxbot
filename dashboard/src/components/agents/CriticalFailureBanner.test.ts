import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import CriticalFailureBanner from "./CriticalFailureBanner.vue";
import type { CriticalFailurePayload } from "../../types";

function flag(
  overrides: Partial<CriticalFailurePayload> = {},
): CriticalFailurePayload {
  return {
    timestamp: "2026-04-21T12:00:00.000Z",
    source: "agent",
    dispatchId: "dispatch-abc",
    reason: "MCP Trello tools failed to load",
    ...overrides,
  };
}

describe("CriticalFailureBanner", () => {
  it("renders the reason and dispatchId prominently", () => {
    const w = mount(CriticalFailureBanner, {
      props: { flag: flag(), repoName: "danxbot" },
    });
    expect(w.text()).toContain("Poller halted");
    expect(w.text()).toContain("MCP Trello tools failed to load");
    expect(w.text()).toContain("dispatch-abc");
  });

  it("shows a human-readable label for each source", () => {
    const agentBanner = mount(CriticalFailureBanner, {
      props: { flag: flag({ source: "agent" }), repoName: "r" },
    });
    expect(agentBanner.text()).toContain("agent-signaled");

    const checkBanner = mount(CriticalFailureBanner, {
      props: {
        flag: flag({ source: "post-dispatch-check" }),
        repoName: "r",
      },
    });
    expect(checkBanner.text()).toContain("post-dispatch check");

    const unparseBanner = mount(CriticalFailureBanner, {
      props: { flag: flag({ source: "unparseable" }), repoName: "r" },
    });
    expect(unparseBanner.text()).toContain("unparseable");
  });

  it("renders the detail string when provided (multiline preserved)", () => {
    const w = mount(CriticalFailureBanner, {
      props: {
        flag: flag({ detail: "Line 1\nLine 2\nLine 3" }),
        repoName: "r",
      },
    });
    expect(w.text()).toContain("Line 1");
    expect(w.text()).toContain("Line 3");
  });

  it("does not render the card link when cardUrl is absent", () => {
    const w = mount(CriticalFailureBanner, {
      props: { flag: flag(), repoName: "r" },
    });
    expect(w.find('a[href^="https://trello.com/"]').exists()).toBe(false);
  });

  it("renders a Trello card link when cardUrl is provided", () => {
    const w = mount(CriticalFailureBanner, {
      props: {
        flag: flag({
          cardId: "card-xyz",
          cardUrl: "https://trello.com/c/card-xyz",
        }),
        repoName: "r",
      },
    });
    const link = w.find('a[href="https://trello.com/c/card-xyz"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toContain("noopener");
  });

  it("emits 'clear' with the repo name when the Clear button is clicked", async () => {
    const w = mount(CriticalFailureBanner, {
      props: { flag: flag(), repoName: "danxbot" },
    });
    await w.get("button").trigger("click");

    const events = w.emitted<[string]>("clear");
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual(["danxbot"]);
  });

  it("disables the button and shows 'Clearing…' when busy", () => {
    const w = mount(CriticalFailureBanner, {
      props: { flag: flag(), repoName: "danxbot", busy: true },
    });
    const button = w.get("button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toBe("Clearing…");
  });

  it("falls back to the raw timestamp string when the timestamp is unparseable", () => {
    const w = mount(CriticalFailureBanner, {
      props: {
        flag: flag({ timestamp: "not-a-date" }),
        repoName: "r",
      },
    });
    expect(w.text()).toContain("not-a-date");
  });
});
