import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useNowTick } from "./useNowTick";

describe("useNowTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHost(intervalMs?: number) {
    return defineComponent({
      setup() {
        const now = useNowTick(intervalMs);
        return { now };
      },
      render() {
        return h("span", String(this.now));
      },
    });
  }

  it("returns the current Date.now() on mount", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const wrapper = mount(makeHost());
    expect(wrapper.text()).toBe("1700000000000");
    wrapper.unmount();
  });

  it("advances the ref each tick interval (default 60s)", async () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const wrapper = mount(makeHost());

    // `advanceTimersByTimeAsync` advances both pending timers AND the
    // fake system clock, so `Date.now()` inside the tick callback
    // resolves to the post-advance moment.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper.text()).toBe("1700000060000");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper.text()).toBe("1700000120000");
    wrapper.unmount();
  });

  it("honors a custom interval", async () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const wrapper = mount(makeHost(1_000));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.text()).toBe("1700000001000");
    wrapper.unmount();
  });

  it("clears the interval on unmount (no further updates)", async () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const wrapper = mount(makeHost());
    wrapper.unmount();

    // Advance well past the interval; if cleanup didn't fire we'd see
    // setInterval still ticking — vitest's fake timers expose pending
    // timers, but the simpler proof is: re-mounting and ticking should
    // not be polluted by a leaked timer from the prior instance.
    vi.setSystemTime(new Date(1_700_000_120_000));
    await vi.advanceTimersByTimeAsync(120_000);

    // No assertion failure means no late writes against an unmounted
    // ref — Vue would warn loudly if there were. Explicit check:
    expect(vi.getTimerCount()).toBe(0);
  });
});
