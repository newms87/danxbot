import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useDebouncedFn } from "./useDebouncedFn";

describe("useDebouncedFn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeHost<T extends object>(setup: () => T) {
    return defineComponent({ setup, render: () => h("span") });
  }

  it("fires fn once after the debounce window elapses", () => {
    const fn = vi.fn();
    const api: { trigger: () => void } = { trigger: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 100);
        api.trigger = d.trigger;
        return {};
      }),
    );
    api.trigger();
    api.trigger();
    api.trigger();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("passes the latest args to fn (coalesces calls)", () => {
    const fn = vi.fn();
    const api: { trigger: (n: number) => void } = { trigger: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 50);
        api.trigger = d.trigger;
        return {};
      }),
    );
    api.trigger(1);
    api.trigger(2);
    api.trigger(3);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
    wrapper.unmount();
  });

  it("cancel() drops the pending fire and clears pending", () => {
    const fn = vi.fn();
    const api: { trigger: () => void; cancel: () => void; pending: () => boolean } = {
      trigger: () => {},
      cancel: () => {},
      pending: () => false,
    };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 100);
        api.trigger = d.trigger;
        api.cancel = d.cancel;
        api.pending = () => d.pending.value;
        return {};
      }),
    );
    api.trigger();
    expect(api.pending()).toBe(true);
    api.cancel();
    expect(api.pending()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("cancels pending fire on unmount", () => {
    const fn = vi.fn();
    const api: { trigger: () => void } = { trigger: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 100);
        api.trigger = d.trigger;
        return {};
      }),
    );
    api.trigger();
    wrapper.unmount();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abortPrevious: passes a fresh AbortSignal to each fire", () => {
    const signals: AbortSignal[] = [];
    const fn = (signal: AbortSignal) => {
      signals.push(signal);
    };
    const api: { trigger: () => void } = { trigger: () => {} };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 50, { abortPrevious: true });
        api.trigger = d.trigger;
        return {};
      }),
    );
    api.trigger();
    vi.advanceTimersByTime(50);
    api.trigger();
    vi.advanceTimersByTime(50);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    wrapper.unmount();
  });

  it("abortPrevious: cancel() aborts the active controller", () => {
    const signals: AbortSignal[] = [];
    const fn = (signal: AbortSignal) => {
      signals.push(signal);
    };
    const api: { trigger: () => void; cancel: () => void } = {
      trigger: () => {},
      cancel: () => {},
    };
    const wrapper = mount(
      makeHost(() => {
        const d = useDebouncedFn(fn, 50, { abortPrevious: true });
        api.trigger = d.trigger;
        api.cancel = d.cancel;
        return {};
      }),
    );
    api.trigger();
    vi.advanceTimersByTime(50);
    expect(signals[0]!.aborted).toBe(false);
    api.cancel();
    expect(signals[0]!.aborted).toBe(true);
    wrapper.unmount();
  });
});
