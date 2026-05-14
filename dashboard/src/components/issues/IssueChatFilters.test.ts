import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import IssueChatFilters, { readInitialFilters } from "./IssueChatFilters.vue";

const HIDE_BASH_KEY = "issues.chatFilter.hideBash";
const HIDE_THINKING_KEY = "issues.chatFilter.hideThinking";

beforeEach(() => {
  window.localStorage.clear();
});

describe("IssueChatFilters", () => {
  it("renders both toggles in active (hide) state when default props passed", () => {
    const w = mount(IssueChatFilters, {
      props: { hideBash: true, hideThinking: true },
    });
    expect(w.get('[data-test="filter-bash"]').classes()).toContain("active");
    expect(w.get('[data-test="filter-thinking"]').classes()).toContain("active");
    expect(w.get('[data-test="filter-bash"]').attributes("aria-pressed")).toBe(
      "true",
    );
  });

  it("emits update:hideBash on click and persists to localStorage", async () => {
    const w = mount(IssueChatFilters, {
      props: { hideBash: true, hideThinking: true },
    });
    await w.get('[data-test="filter-bash"]').trigger("click");
    expect(w.emitted("update:hideBash")).toEqual([[false]]);
    expect(window.localStorage.getItem(HIDE_BASH_KEY)).toBe("false");
  });

  it("emits update:hideThinking on click and persists", async () => {
    const w = mount(IssueChatFilters, {
      props: { hideBash: true, hideThinking: true },
    });
    await w.get('[data-test="filter-thinking"]').trigger("click");
    expect(w.emitted("update:hideThinking")).toEqual([[false]]);
    expect(window.localStorage.getItem(HIDE_THINKING_KEY)).toBe("false");
  });

  it("toggles back to active when clicked again", async () => {
    const w = mount(IssueChatFilters, {
      props: { hideBash: false, hideThinking: true },
    });
    await w.get('[data-test="filter-bash"]').trigger("click");
    expect(w.emitted("update:hideBash")).toEqual([[true]]);
    expect(window.localStorage.getItem(HIDE_BASH_KEY)).toBe("true");
  });
});

describe("readInitialFilters", () => {
  it("returns both defaults true when no prior preference is stored", () => {
    expect(readInitialFilters()).toEqual({
      hideBash: true,
      hideThinking: true,
    });
  });

  it("restores stored values verbatim", () => {
    window.localStorage.setItem(HIDE_BASH_KEY, "false");
    window.localStorage.setItem(HIDE_THINKING_KEY, "false");
    expect(readInitialFilters()).toEqual({
      hideBash: false,
      hideThinking: false,
    });
  });

  it("falls back to defaults on malformed JSON", () => {
    window.localStorage.setItem(HIDE_BASH_KEY, "not-json");
    expect(readInitialFilters().hideBash).toBe(true);
  });
});
