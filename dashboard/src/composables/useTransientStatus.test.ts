import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useTransientStatus } from "./useTransientStatus";

describe("useTransientStatus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type CopyState = "idle" | "copying" | "copied" | "failed";

  function makeHost<T extends object>(setup: () => T) {
    return defineComponent({ setup, render: () => h("span") });
  }

  it("defaults to the idle value", () => {
    const api: { status: () => string } = { status: () => "" };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 2000, idleValue: "idle" });
        api.status = () => t.status.value;
        return {};
      }),
    );
    expect(api.status()).toBe("idle");
    wrapper.unmount();
  });

  it("auto-resets to idle after idleMs", () => {
    const api: { status: () => string; set: (v: CopyState) => void } = {
      status: () => "",
      set: () => {},
    };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 2000, idleValue: "idle" });
        api.status = () => t.status.value;
        api.set = t.set;
        return {};
      }),
    );
    api.set("copied");
    expect(api.status()).toBe("copied");
    vi.advanceTimersByTime(1999);
    expect(api.status()).toBe("copied");
    vi.advanceTimersByTime(1);
    expect(api.status()).toBe("idle");
    wrapper.unmount();
  });

  it("re-setting before reset replaces the value and restarts the timer", () => {
    const api: { status: () => string; set: (v: CopyState) => void } = {
      status: () => "",
      set: () => {},
    };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 100, idleValue: "idle" });
        api.status = () => t.status.value;
        api.set = t.set;
        return {};
      }),
    );
    api.set("copied");
    vi.advanceTimersByTime(50);
    api.set("failed");
    expect(api.status()).toBe("failed");
    vi.advanceTimersByTime(50);
    expect(api.status()).toBe("failed");
    vi.advanceTimersByTime(50);
    expect(api.status()).toBe("idle");
    wrapper.unmount();
  });

  it("autoReset: false holds the value with no scheduled reset", () => {
    const api: {
      status: () => string;
      pending: () => boolean;
      set: (v: CopyState, opts?: { autoReset?: boolean }) => void;
    } = { status: () => "", pending: () => false, set: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 100, idleValue: "idle" });
        api.status = () => t.status.value;
        api.pending = () => t.pending.value;
        api.set = t.set;
        return {};
      }),
    );
    api.set("copying", { autoReset: false });
    expect(api.status()).toBe("copying");
    expect(api.pending()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(api.status()).toBe("copying");
    wrapper.unmount();
  });

  it("clear() cancels the pending reset and snaps to idle", () => {
    const api: {
      status: () => string;
      set: (v: CopyState) => void;
      clear: () => void;
    } = { status: () => "", set: () => {}, clear: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 100, idleValue: "idle" });
        api.status = () => t.status.value;
        api.set = t.set;
        api.clear = t.clear;
        return {};
      }),
    );
    api.set("copied");
    api.clear();
    expect(api.status()).toBe("idle");
    vi.advanceTimersByTime(200);
    expect(api.status()).toBe("idle");
    wrapper.unmount();
  });

  it("setting idleValue cancels any pending timer", () => {
    const api: {
      status: () => string;
      pending: () => boolean;
      set: (v: CopyState) => void;
    } = { status: () => "", pending: () => false, set: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 100, idleValue: "idle" });
        api.status = () => t.status.value;
        api.pending = () => t.pending.value;
        api.set = t.set;
        return {};
      }),
    );
    api.set("copied");
    expect(api.pending()).toBe(true);
    api.set("idle");
    expect(api.status()).toBe("idle");
    expect(api.pending()).toBe(false);
    wrapper.unmount();
  });

  it("clears timer on unmount", () => {
    const api: { set: (v: CopyState) => void } = { set: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const t = useTransientStatus<CopyState>({ idleMs: 100, idleValue: "idle" });
        api.set = t.set;
        return {};
      }),
    );
    api.set("copied");
    wrapper.unmount();
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(0);
  });
});
