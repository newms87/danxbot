import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, ref, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";

const currentUser = ref<{ username: string } | null>(null);
const mockInit = vi.fn<() => Promise<void>>();
const mockHandleExpired = vi.fn<() => void>();

vi.mock("./composables/useAuth", () => ({
  useAuth: () => ({
    currentUser,
    init: mockInit,
    handleExpired: mockHandleExpired,
  }),
}));

const mockFetchRepos = vi.fn<() => Promise<unknown>>();
vi.mock("./api", () => ({
  fetchRepos: () => mockFetchRepos(),
}));

const mockDispatchesInit = vi.fn<() => void>();
const mockDispatchesDestroy = vi.fn<() => void>();

vi.mock("./composables/useDispatches", () => ({
  useDispatches: () => ({
    dispatches: ref([]),
    loading: ref(false),
    selectedRepo: ref(""),
    selectedTrigger: ref(""),
    selectedStatus: ref(""),
    searchQuery: ref(""),
    refresh: vi.fn(),
    init: mockDispatchesInit,
    destroy: mockDispatchesDestroy,
  }),
}));

const stub = (name: string) =>
  defineComponent({ name, render: () => null });

async function mountApp() {
  // Dynamic import after mocks are hoisted.
  const App = (await import("./App.vue")).default;
  return mount(App, {
    global: {
      stubs: {
        DashboardHeader: stub("DashboardHeader"),
        DispatchList: stub("DispatchList"),
        DispatchFilters: stub("DispatchFilters"),
        DispatchDetail: stub("DispatchDetail"),
        AgentsPage: stub("AgentsPage"),
        Login: stub("Login"),
      },
    },
  });
}

beforeEach(() => {
  currentUser.value = null;
  mockInit.mockReset();
  mockInit.mockResolvedValue(undefined);
  mockHandleExpired.mockReset();
  mockFetchRepos.mockReset();
  mockFetchRepos.mockResolvedValue([]);
  mockDispatchesInit.mockReset();
  mockDispatchesDestroy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.vue — auth pipeline", () => {
  it("renders Login when init resolves without a user", async () => {
    const w = await mountApp();
    await flushPromises();

    expect(w.findComponent({ name: "Login" }).exists()).toBe(true);
    expect(w.findComponent({ name: "DashboardHeader" }).exists()).toBe(false);
    expect(mockDispatchesInit).not.toHaveBeenCalled();

    w.unmount();
  });

  it("renders the dashboard and kicks off loadDashboard after a warm-token init", async () => {
    mockInit.mockImplementation(async () => {
      currentUser.value = { username: "newms87" };
    });

    const w = await mountApp();
    await flushPromises();

    expect(w.findComponent({ name: "Login" }).exists()).toBe(false);
    expect(w.findComponent({ name: "DashboardHeader" }).exists()).toBe(true);
    expect(mockFetchRepos).toHaveBeenCalledTimes(1);
    expect(mockDispatchesInit).toHaveBeenCalledTimes(1);

    w.unmount();
  });

  it("does NOT double-fire loadDashboard when currentUser goes null->user during init", async () => {
    // Confirms the deduplication: watch has `immediate: true`, but onMounted
    // no longer calls loadDashboard itself — the only fetch should be the
    // one kicked off by the watch observing the transition.
    mockInit.mockImplementation(async () => {
      currentUser.value = { username: "newms87" };
    });

    const w = await mountApp();
    await flushPromises();

    expect(mockFetchRepos).toHaveBeenCalledTimes(1);
    expect(mockDispatchesInit).toHaveBeenCalledTimes(1);

    w.unmount();
  });

  it("listens for `auth:expired` and tears down dashboard state", async () => {
    mockInit.mockImplementation(async () => {
      currentUser.value = { username: "newms87" };
    });

    const w = await mountApp();
    await flushPromises();
    expect(mockDispatchesInit).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent("auth:expired"));
    await nextTick();

    expect(mockHandleExpired).toHaveBeenCalledTimes(1);
    expect(mockDispatchesDestroy).toHaveBeenCalled();

    w.unmount();
  });

  it("removes the `auth:expired` listener on unmount", async () => {
    const w = await mountApp();
    await flushPromises();

    w.unmount();

    window.dispatchEvent(new CustomEvent("auth:expired"));
    await nextTick();

    // No additional handleExpired firings after unmount.
    expect(mockHandleExpired).not.toHaveBeenCalled();
  });
});
