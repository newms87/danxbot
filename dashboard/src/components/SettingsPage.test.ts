import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const mockResetAllData = vi.fn();
vi.mock("../api", () => ({
  resetAllData: (...args: unknown[]) => mockResetAllData(...args),
}));

import SettingsPage from "./SettingsPage.vue";

beforeEach(() => {
  mockResetAllData.mockReset();
});

describe("SettingsPage", () => {
  it("renders a Danger zone with the Reset button", () => {
    const w = mount(SettingsPage);
    expect(w.get('[data-test="danger-zone"]').text()).toContain("Danger zone");
    expect(w.find('[data-test="reset-data-open"]').exists()).toBe(true);
  });

  it("opens the dialog when Reset is clicked", async () => {
    const w = mount(SettingsPage, { attachTo: document.body });
    await w.get('[data-test="reset-data-open"]').trigger("click");
    await flushPromises();

    // DanxDialog renders inside a <dialog> element
    const dialog = document.querySelector("dialog");
    expect(dialog).not.toBeNull();
    expect(document.body.textContent).toContain("Reset all data?");
    w.unmount();
  });

  it("calls resetAllData when the dialog confirm fires and shows the success summary", async () => {
    mockResetAllData.mockResolvedValueOnce({
      tablesCleared: ["dispatches", "threads", "events", "health_check"],
      rowsDeleted: 42,
      perTable: { dispatches: 10, threads: 5, events: 25, health_check: 2 },
    });

    const w = mount(SettingsPage, { attachTo: document.body });
    await w.get('[data-test="reset-data-open"]').trigger("click");
    await flushPromises();

    // Find the confirm button inside the dialog by its rendered label.
    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ).find((b) => b.textContent?.includes("Reset everything"));
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await flushPromises();

    expect(mockResetAllData).toHaveBeenCalledOnce();
    const success = w.find('[data-test="reset-data-success"]');
    expect(success.exists()).toBe(true);
    expect(success.text()).toContain("42 row(s) deleted");
    expect(success.text()).toContain("dispatches: 10");
    w.unmount();
  });

  it("surfaces the error message when the API call rejects", async () => {
    mockResetAllData.mockRejectedValueOnce(new Error("db down"));

    const w = mount(SettingsPage, { attachTo: document.body });
    await w.get('[data-test="reset-data-open"]').trigger("click");
    await flushPromises();

    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ).find((b) => b.textContent?.includes("Reset everything"));
    confirmBtn!.click();
    await flushPromises();

    const err = w.find('[data-test="reset-data-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("db down");
    // Success panel is NOT shown
    expect(w.find('[data-test="reset-data-success"]').exists()).toBe(false);
    w.unmount();
  });
});
