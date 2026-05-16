import { describe, it, expect, beforeEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { RepoInfo } from "../api";

const mockResetAllData = vi.fn();
vi.mock("../api", () => ({
  resetAllData: (...args: unknown[]) => mockResetAllData(...args),
}));

// DX-159 Phase 1: SettingsPage now imports `useAgents` (SSE-backed).
// Mock the composable so the component renders without hitting the
// stream layer in dashboard SFC tests.
const mockAgentsRef: { value: unknown[] } = { value: [] };
const mockRefresh = vi.fn();
vi.mock("../composables/useAgents", () => ({
  useAgents: () => ({
    agents: mockAgentsRef,
    loading: { value: false },
    error: { value: null },
    toggle: vi.fn(),
    clearCriticalFailure: vi.fn(),
    saveIssuePrefix: vi.fn(),
    refresh: mockRefresh,
  }),
}));

// DX-603 — SettingsPage now embeds ListsManager, which calls
// `useListColors(repo).init()` on mount. Mock the composable to a no-op
// surface (empty lists, no-op SSE wiring) so SettingsPage tests stay
// untouched by the new section's stream behavior.
vi.mock("../composables/useListColors", () => ({
  NEUTRAL_LIST_COLOR: "#94a3b8",
  useListColors: () => ({
    lists: { value: [] },
    loading: { value: false },
    error: { value: null },
    colorFor: () => "#94a3b8",
    refresh: vi.fn(),
    init: vi.fn(),
    destroy: vi.fn(),
  }),
}));

import SettingsPage from "./SettingsPage.vue";
import TrelloConfigPanel from "./agents/TrelloConfigPanel.vue";

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
  mockAgentsRef.value = [];
  mockRefresh.mockReset();
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

    // DX-299: dialog mount race under full-suite CPU contention. See
    // DX-262 RequiresHumanPanel.test.ts for the canonical mechanism.
    await vi.waitFor(() => {
      expect(document.querySelector("dialog")).not.toBeNull();
      expect(document.body.textContent).toContain("Reset all data?");
    });
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

    // DX-299: dialog mount race — wait until the confirm button is queryable.
    const confirmBtn = await vi.waitFor(() => {
      const btn = Array.from(
        document.querySelectorAll<HTMLButtonElement>("dialog button"),
      ).find((b) => b.textContent?.includes("Reset everything"));
      expect(btn).toBeTruthy();
      return btn!;
    });
    confirmBtn.click();

    // DX-299: PATCH-call-count race after the async confirm cascade
    // (resetAllData promise → state update → success render).
    await vi.waitFor(() => {
      expect(mockResetAllData).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      const success = w.find('[data-test="reset-data-success"]');
      expect(success.exists()).toBe(true);
      expect(success.text()).toContain("17 row(s) deleted");
      expect(success.text()).toContain("dispatches: 10");
    });
    w.unmount();
  });

  it("surfaces the error message when the API call rejects", async () => {
    mockResetAllData.mockRejectedValueOnce(new Error("db down"));

    const w = mountPage({ attachTo: document.body });
    await w.get('[data-test="reset-data-open"]').trigger("click");

    // DX-299: dialog mount race.
    const confirmBtn = await vi.waitFor(() => {
      const btn = Array.from(
        document.querySelectorAll<HTMLButtonElement>("dialog button"),
      ).find((b) => b.textContent?.includes("Reset everything"));
      expect(btn).toBeTruthy();
      return btn!;
    });
    confirmBtn.click();

    // DX-299: error-render state-transition race after the rejected promise.
    await vi.waitFor(() => {
      const err = document.querySelector('[data-test="reset-data-error"]');
      expect(err).toBeTruthy();
      expect(err?.textContent).toContain("db down");
    });
    expect(w.find('[data-test="reset-data-success"]').exists()).toBe(false);
    w.unmount();
  });

  // DX-304 — TrelloConfigPanel mounts as a sibling section under the
  // active repo's RepoCard. Switching the selected repo re-mounts the
  // panel with the new repo's snapshot, so the panel's masked values
  // always match the operator's current pick.
  describe("TrelloConfigPanel integration", () => {
    function snapshot(name: string) {
      return {
        name,
        url: `https://example.com/${name}.git`,
        settings: {
          overrides: {
            slack: { enabled: null },
            issuePoller: { enabled: null, pickupPrefix: null },
            dispatchApi: { enabled: null },
            ideator: { enabled: null },
            autoTriage: { enabled: null },
            trelloSync: { enabled: null },
          },
          display: {
            trello: {
              apiKey: `${name}-mask`,
              apiToken: `${name}-mask-tok`,
              boardId: `${name}-board`,
              todoListId: `${name}-todo`,
              configured: true,
            },
            links: {},
          },
          meta: { updatedAt: "2026-05-01T00:00:00Z", updatedBy: "test" },
        },
        counts: {
          total: { total: 0, slack: 0, trello: 0, api: 0 },
          last24h: { total: 0, slack: 0, trello: 0, api: 0 },
          today: { total: 0, slack: 0, trello: 0, api: 0 },
        },
        worker: { reachable: true, lastSeenMs: Date.now() },
        criticalFailure: null,
        issuePrefix: "DX",
      };
    }

    it("renders TrelloConfigPanel under the active repo's RepoCard", () => {
      mockAgentsRef.value = [snapshot("danxbot")];
      const w = mountPage();
      const panel = w.find('[data-test="trello-config-panel"]');
      expect(panel.exists()).toBe(true);
      expect(w.get('[data-test="trello-board-id"]').text()).toBe(
        "danxbot-board",
      );
    });

    // AC #6 regression guard: the trelloSync row was moved into the
    // panel; RepoCard must NOT render its own duplicate switch. Asserts
    // exactly one role=switch with the "Trello sync" label exists in
    // the rendered Settings page (the one inside TrelloConfigPanel).
    it("renders exactly one Trello sync toggle (panel, not RepoCard duplicate)", async () => {
      mockAgentsRef.value = [snapshot("danxbot")];
      const w = mountPage();
      await flushPromises();
      // Iterate all switches; count those whose accessible label says Trello sync.
      const trelloSwitches = w
        .findAll('[role="switch"]')
        .filter((s) => (s.attributes("aria-label") ?? "").includes("Trello sync"));
      expect(trelloSwitches).toHaveLength(1);
      // And the one that exists lives inside the panel.
      const panel = w.get('[data-test="trello-config-panel"]');
      expect(panel.find('[role="switch"]').exists()).toBe(true);
    });

    it("calls the composable's refresh() when the panel emits 'refresh'", async () => {
      mockAgentsRef.value = [snapshot("danxbot")];
      const w = mountPage();
      await flushPromises();
      const panel = w.findComponent(TrelloConfigPanel);
      expect(panel.exists()).toBe(true);
      panel.vm.$emit("refresh", "danxbot");
      // DX-299: refresh-call-count race after the emit handler.
      await vi.waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledOnce();
      });
    });

    it("re-mounts the panel with the new repo's snapshot when the selection changes", async () => {
      mockAgentsRef.value = [snapshot("danxbot"), snapshot("other")];
      const w = mount(SettingsPage, {
        props: {
          selectedRepo: "danxbot",
          repos: [
            { name: "danxbot", url: "" },
            { name: "other", url: "" },
          ],
        },
      });
      await flushPromises();
      expect(w.get('[data-test="trello-board-id"]').text()).toBe(
        "danxbot-board",
      );

      await w.setProps({ selectedRepo: "other" });
      await flushPromises();
      expect(w.get('[data-test="trello-board-id"]').text()).toBe(
        "other-board",
      );
    });
  });
});
