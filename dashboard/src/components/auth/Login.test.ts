import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

import { ref } from "vue";

const mockLogin = vi.fn();
const initErrorRef = ref<string | null>(null);

vi.mock("../../composables/useAuth", async () => {
  const actual = await vi.importActual<
    typeof import("../../composables/useAuth")
  >("../../composables/useAuth");
  return {
    ...actual,
    useAuth: () => ({
      token: { value: null },
      currentUser: { value: null },
      initError: initErrorRef,
      init: vi.fn(),
      login: (...args: unknown[]) => mockLogin(...args),
      logout: vi.fn(),
      handleExpired: vi.fn(),
    }),
  };
});

import Login from "./Login.vue";
import { LoginError } from "../../composables/useAuth";

beforeEach(() => {
  mockLogin.mockReset();
  initErrorRef.value = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Login.vue", () => {
  it("calls useAuth().login with the typed credentials on submit", async () => {
    mockLogin.mockResolvedValue(undefined);
    const w = mount(Login);

    await w.get('input[autocomplete="username"]').setValue("newms87");
    await w.get('input[autocomplete="current-password"]').setValue("hunter2");
    await w.get("form").trigger("submit.prevent");
    await flushPromises();

    expect(mockLogin).toHaveBeenCalledWith("newms87", "hunter2");
    expect(w.find('[data-test="login-error"]').exists()).toBe(false);
  });

  it("shows the LoginError message inline and clears the password on 401", async () => {
    mockLogin.mockRejectedValue(
      new LoginError("Invalid username or password", 401),
    );
    const w = mount(Login);

    await w.get('input[autocomplete="username"]').setValue("newms87");
    await w.get('input[autocomplete="current-password"]').setValue("wrong");
    await w.get("form").trigger("submit.prevent");
    await flushPromises();

    const err = w.get('[data-test="login-error"]');
    expect(err.text()).toContain("Invalid username or password");
    // Password wiped so a retry doesn't submit the rejected value again.
    expect(
      (w.get('input[autocomplete="current-password"]').element as HTMLInputElement).value,
    ).toBe("");
  });

  it("disables the submit button AND both inputs while the request is in flight", async () => {
    let resolveLogin: () => void = () => {};
    mockLogin.mockImplementation(
      () => new Promise<void>((r) => (resolveLogin = r)),
    );
    const w = mount(Login);

    await w.get('input[autocomplete="username"]').setValue("newms87");
    await w.get('input[autocomplete="current-password"]').setValue("x");
    w.get("form").trigger("submit.prevent");
    await flushPromises();

    const btn = w.get("button[type='submit']");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.text()).toMatch(/signing in/i);

    // Inputs lock too — a regression that removes :disabled on the inputs
    // would let the operator submit a second time mid-flight.
    expect(
      w.get('input[autocomplete="username"]').attributes("disabled"),
    ).toBeDefined();
    expect(
      w.get('input[autocomplete="current-password"]').attributes("disabled"),
    ).toBeDefined();

    resolveLogin();
    await flushPromises();
    expect(
      w.get("button[type='submit']").attributes("disabled"),
    ).toBeUndefined();
  });

  it("falls back to a generic message for non-LoginError throws", async () => {
    mockLogin.mockRejectedValue(new Error("network down"));
    const w = mount(Login);

    await w.get('input[autocomplete="username"]').setValue("x");
    await w.get('input[autocomplete="current-password"]').setValue("y");
    await w.get("form").trigger("submit.prevent");
    await flushPromises();

    expect(w.get('[data-test="login-error"]').text()).toContain("network down");
  });

  it("renders an initError banner when useAuth exposes one", () => {
    initErrorRef.value = "Dashboard unreachable — try reloading.";
    const w = mount(Login);
    expect(w.find('[data-test="init-error"]').exists()).toBe(true);
    expect(w.get('[data-test="init-error"]').text()).toMatch(/unreachable/i);
  });

  it("does NOT render the initError banner when null", () => {
    initErrorRef.value = null;
    const w = mount(Login);
    expect(w.find('[data-test="init-error"]').exists()).toBe(false);
  });
});
