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

const mockSystemErrorsInit = vi.fn<() => Promise<void>>();
const mockSystemErrorsDestroy = vi.fn<() => void>();

// `./api` above is mocked to expose only `fetchRepos`, so the real
// `useSystemErrors` would import `fetchSystemErrors` / `fetchWithAuth`
// as `undefined`. Calling them throws inside the real `useStream`,
// which schedules real `setTimeout` reconnects on the host loop. Under
// full-suite CPU contention those leak past `w.unmount()` and bleed
// state into the next test (the cascade pattern in DX-255). Stub the
// whole composable so App.vue's setup is pure synchronous wiring with
// zero transitive I/O.
vi.mock("./composables/useSystemErrors", () => ({
  useSystemErrors: () => ({
    visible: ref([]),
    count: ref(0),
    loading: ref(false),
    error: ref(null),
    dismiss: vi.fn(),
    resetDismissed: vi.fn(),
    init: mockSystemErrorsInit,
    destroy: mockSystemErrorsDestroy,
  }),
}));

// Static import after mocks (vitest hoists `vi.mock` above static
// imports). Module-level import pays the cold transform+import cost
// once at file load, before any test's `testTimeout` budget starts —
// avoiding the DX-255 budget-overrun mode where the first test's
// dynamic import blew past 15s under full-suite CPU contention and
// the leaked wrapper cascaded into subsequent tests.
import App from "./App.vue";

const stub = (name: string) =>
  defineComponent({ name, render: () => null });

function mountApp() {
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
  mockSystemErrorsInit.mockReset();
  mockSystemErrorsInit.mockResolvedValue(undefined);
  mockSystemErrorsDestroy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.vue — auth pipeline", () => {
  it("renders Login when init resolves without a user", async () => {
    const w = mountApp();
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

    const w = mountApp();
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

    const w = mountApp();
    await flushPromises();

    expect(mockFetchRepos).toHaveBeenCalledTimes(1);
    expect(mockDispatchesInit).toHaveBeenCalledTimes(1);

    w.unmount();
  });

  it("listens for `auth:expired` and tears down dashboard state", async () => {
    mockInit.mockImplementation(async () => {
      currentUser.value = { username: "newms87" };
    });

    const w = mountApp();
    await flushPromises();
    expect(mockDispatchesInit).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new CustomEvent("auth:expired"));
    await nextTick();

    expect(mockHandleExpired).toHaveBeenCalledTimes(1);
    expect(mockDispatchesDestroy).toHaveBeenCalled();
    expect(mockSystemErrorsDestroy).toHaveBeenCalled();

    w.unmount();
  });

  it("removes the `auth:expired` listener on unmount", async () => {
    const w = mountApp();
    await flushPromises();

    w.unmount();

    window.dispatchEvent(new CustomEvent("auth:expired"));
    await nextTick();

    // No additional handleExpired firings after unmount.
    expect(mockHandleExpired).not.toHaveBeenCalled();
  });
});
