import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { mount } from "@vue/test-utils";

const mockLogout = vi.fn();
const currentUserRef = ref<{ username: string } | null>(null);

vi.mock("../composables/useAuth", () => ({
  useAuth: () => ({
    currentUser: currentUserRef,
    logout: (...args: unknown[]) => mockLogout(...args),
  }),
}));

import DashboardHeader from "./DashboardHeader.vue";

const baseProps = {
  connected: true,
  eventCount: 0,
  repos: [],
  selectedRepo: "",
  activeTab: "dispatches" as const,
};

beforeEach(() => {
  mockLogout.mockReset();
  mockLogout.mockResolvedValue(undefined);
  currentUserRef.value = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DashboardHeader — auth bits", () => {
  it("shows the username from the composable when a user is signed in", () => {
    currentUserRef.value = { username: "newms87" };
    const w = mount(DashboardHeader, { props: baseProps });
    expect(w.get('[data-test="current-user"]').text()).toBe("newms87");
    expect(w.find('[data-test="logout-button"]').exists()).toBe(true);
  });

  it("hides the username and logout button when no user is signed in", () => {
    currentUserRef.value = null;
    const w = mount(DashboardHeader, { props: baseProps });
    expect(w.find('[data-test="current-user"]').exists()).toBe(false);
    expect(w.find('[data-test="logout-button"]').exists()).toBe(false);
  });

  it("invokes useAuth().logout when the logout button is clicked", async () => {
    currentUserRef.value = { username: "newms87" };
    const w = mount(DashboardHeader, { props: baseProps });
    await w.get('[data-test="logout-button"]').trigger("click");
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
