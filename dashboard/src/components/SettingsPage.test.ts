import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { RepoInfo } from "../api";

const mockResetAllData = vi.fn();
const mockFetchAgentRoster = vi.fn();
const mockPatchAgentDefaults = vi.fn();
vi.mock("../api", () => ({
  resetAllData: (...args: unknown[]) => mockResetAllData(...args),
  fetchAgentRoster: (...args: unknown[]) => mockFetchAgentRoster(...args),
  patchAgentDefaults: (...args: unknown[]) => mockPatchAgentDefaults(...args),
}));

// DX-159 Phase 1: SettingsPage now imports `useAgents` (SSE-backed).
// Mock the composable so the component renders without hitting the
// stream layer in dashboard SFC tests.
vi.mock("../composables/useAgents", () => ({
  useAgents: () => ({
    agents: { value: [] },
    loading: { value: false },
    error: { value: null },
    toggle: vi.fn(),
    clearCriticalFailure: vi.fn(),
    saveIssuePrefix: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import SettingsPage from "./SettingsPage.vue";

const REPOS: RepoInfo[] = [
  { name: "danxbot", url: "https://example.com/danxbot.git" },
];

function mountPage(opts?: { attachTo?: Element }) {
  return mount(SettingsPage, {
    attachTo: opts?.attachTo,
    props: { selectedRepo: "danxbot", repos: REPOS },
  });
}

beforeEach(() => {
  mockResetAllData.mockReset();
  mockFetchAgentRoster.mockReset();
  mockFetchAgentRoster.mockResolvedValue({
    agents: [],
    settings: { conflictCheckEnabled: true },
  });
  mockPatchAgentDefaults.mockReset();
});

describe("SettingsPage", () => {
  it("renders a Danger zone with the Reset button", () => {
    const w = mountPage();
    expect(w.get('[data-test="danger-zone"]').text()).toContain("Danger zone");
    expect(w.find('[data-test="reset-data-open"]').exists()).toBe(true);
  });

  it("opens the dialog when Reset is clicked", async () => {
    const w = mountPage({ attachTo: document.body });
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
      tablesCleared: ["dispatches", "threads", "health_check"],
      rowsDeleted: 17,
      perTable: { dispatches: 10, threads: 5, health_check: 2 },
    });

    const w = mountPage({ attachTo: document.body });
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
    expect(success.text()).toContain("17 row(s) deleted");
    expect(success.text()).toContain("dispatches: 10");
    w.unmount();
  });

  it("surfaces the error message when the API call rejects", async () => {
    mockResetAllData.mockRejectedValueOnce(new Error("db down"));

    const w = mountPage({ attachTo: document.body });
    await w.get('[data-test="reset-data-open"]').trigger("click");
    await flushPromises();

    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>("dialog button"),
    ).find((b) => b.textContent?.includes("Reset everything"));
    confirmBtn!.click();
    await flushPromises();

    const err = document.querySelector('[data-test="reset-data-error"]');
    expect(err).toBeTruthy();
    expect(err?.textContent).toContain("db down");
    // Success panel is NOT shown
    expect(w.find('[data-test="reset-data-success"]').exists()).toBe(false);
    w.unmount();
  });

  it("renders the conflict-check toggle reflecting the fetched agentDefaults state", async () => {
    mockFetchAgentRoster.mockResolvedValueOnce({
      agents: [],
      settings: { conflictCheckEnabled: false },
    });
    const w = mountPage();
    await flushPromises();

    expect(mockFetchAgentRoster).toHaveBeenCalledWith("danxbot");
    const card = w.find('[data-test="conflict-check-card"]');
    expect(card.exists()).toBe(true);
    const toggle = card.find<HTMLInputElement>('[data-test="conflict-check-toggle"]');
    expect(toggle.element.checked).toBe(false);
  });

  it("PATCHes agentDefaults when the conflict-check toggle is flipped", async () => {
    mockFetchAgentRoster.mockResolvedValueOnce({
      agents: [],
      settings: { conflictCheckEnabled: true },
    });
    mockPatchAgentDefaults.mockResolvedValueOnce({
      settings: { conflictCheckEnabled: false },
    });
    const w = mountPage();
    await flushPromises();

    const toggle = w.find<HTMLInputElement>('[data-test="conflict-check-toggle"]');
    toggle.element.checked = false;
    await toggle.trigger("change");
    await flushPromises();

    expect(mockPatchAgentDefaults).toHaveBeenCalledWith("danxbot", false);
  });
});
