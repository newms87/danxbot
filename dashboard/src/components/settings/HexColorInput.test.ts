import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import HexColorInput from "./HexColorInput.vue";

describe("HexColorInput", () => {
  it("renders the bound color in both swatch and text input", () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", testId: "x" },
    });
    expect((wrapper.get('[data-test="x-input"]').element as HTMLInputElement).value).toBe("#3b82f6");
    // Swatch normalizes to long form (already long here).
    expect((wrapper.get('[data-test="x-swatch"]').element as HTMLInputElement).value).toBe("#3b82f6");
  });

  it("expands short-form hex (#abc) for the swatch", () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#abc", testId: "x" },
    });
    expect((wrapper.get('[data-test="x-swatch"]').element as HTMLInputElement).value).toBe("#aabbcc");
  });

  it("emits update:modelValue on blur when the text input holds a valid hex", async () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", testId: "x" },
    });
    const input = wrapper.get('[data-test="x-input"]');
    await input.setValue("#deadbe");
    await input.trigger("blur");
    expect(wrapper.emitted("update:modelValue")).toEqual([["#deadbe"]]);
  });

  it("does NOT emit on blur when the text input holds an invalid hex (renders inline error)", async () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", testId: "x" },
    });
    const input = wrapper.get('[data-test="x-input"]');
    await input.setValue("notahex");
    await input.trigger("blur");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(wrapper.get('[data-test="x-error"]').text()).toMatch(/hex color/i);
  });

  it("emits on Enter and reverts on Escape", async () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", testId: "x" },
    });
    const input = wrapper.get('[data-test="x-input"]');

    await input.setValue("#deadbe");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")).toEqual([["#deadbe"]]);

    // Re-render with the parent acking the new value.
    await wrapper.setProps({ modelValue: "#deadbe" });
    await input.setValue("notahex");
    await input.trigger("keydown", { key: "Escape" });
    // Draft reverts to the bound value; no further emit beyond the Enter one.
    expect((wrapper.get('[data-test="x-input"]').element as HTMLInputElement).value).toBe("#deadbe");
    expect(wrapper.emitted("update:modelValue")).toEqual([["#deadbe"]]);
  });

  it("emits on every swatch input event (live drag)", async () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", testId: "x" },
    });
    const swatch = wrapper.get('[data-test="x-swatch"]');
    await swatch.setValue("#abcdef");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["#abcdef"]);
  });

  it("respects disabled prop on both controls", () => {
    const wrapper = mount(HexColorInput, {
      props: { modelValue: "#3b82f6", disabled: true, testId: "x" },
    });
    expect((wrapper.get('[data-test="x-input"]').element as HTMLInputElement).disabled).toBe(true);
    expect((wrapper.get('[data-test="x-swatch"]').element as HTMLInputElement).disabled).toBe(true);
  });
});
