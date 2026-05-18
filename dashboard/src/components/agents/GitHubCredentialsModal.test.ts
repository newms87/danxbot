import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { ToggleError } from "../../api";

const mockPatch = vi.fn();
vi.mock("../../api", () => ({
  patchGithubCredentials: (...args: unknown[]) => mockPatch(...args),
}));

import GitHubCredentialsModal from "./GitHubCredentialsModal.vue";

function mountModal(opts?: { attachTo?: Element }) {
  return mount(GitHubCredentialsModal, {
    attachTo: opts?.attachTo ?? document.body,
    props: { open: true, repo: "danxbot" },
  });
}

beforeEach(() => {
  mockPatch.mockReset();
});

describe("GitHubCredentialsModal — submit", () => {
  it("rejects empty input without calling PATCH (AC #3)", async () => {
    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );
    // Trigger confirm via the wrapper instance method — DanxDialog renders
    // its confirm button asynchronously; calling onConfirm directly is
    // brittle, so we drive the actual confirm event.
    const dialog = document.querySelector("dialog");
    const confirmBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Save token"));
    expect(confirmBtn).toBeTruthy();
    confirmBtn!.click();
    await flushPromises();

    expect(mockPatch).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-test="github-credentials-modal-error"]')
        ?.textContent ?? "",
    ).toContain("Paste a GitHub token");
    w.unmount();
  });

  it("emits `saved` + closes the modal on 200 (AC #3)", async () => {
    mockPatch.mockResolvedValueOnce({
      registered: true,
      token_shape_valid: true,
      last_validated_at: "2026-05-18T10:00:00Z",
      last_validation_error: null,
    });

    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );

    const input = document.querySelector<HTMLInputElement>(
      '[data-test="github-credentials-token-input"]',
    );
    expect(input).toBeTruthy();
    input!.value = "ghp_validtoken12345";
    input!.dispatchEvent(new Event("input"));
    await flushPromises();

    const dialog = document.querySelector("dialog");
    const confirmBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Save token"));
    confirmBtn!.click();
    await flushPromises();

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(mockPatch).toHaveBeenCalledWith("danxbot", "ghp_validtoken12345");
    const saved = w.emitted("saved");
    expect(saved).toBeTruthy();
    expect(saved![0][0]).toMatchObject({
      registered: true,
      token_shape_valid: true,
    });
    const close = w.emitted("update:open");
    expect(close).toBeTruthy();
    expect(close![close!.length - 1]).toEqual([false]);
    w.unmount();
  });

  it("surfaces 422 inline + keeps form state (AC #3)", async () => {
    const err = new Error("token does not match expected GitHub PAT shape") as ToggleError;
    err.status = 422;
    err.serverMessage = "token does not match expected GitHub PAT shape";
    mockPatch.mockRejectedValueOnce(err);

    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );

    const input = document.querySelector<HTMLInputElement>(
      '[data-test="github-credentials-token-input"]',
    );
    input!.value = "not-a-real-token";
    input!.dispatchEvent(new Event("input"));
    await flushPromises();

    const dialog = document.querySelector("dialog");
    const confirmBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Save token"));
    confirmBtn!.click();
    await flushPromises();

    expect(mockPatch).toHaveBeenCalledOnce();
    expect(w.emitted("saved")).toBeFalsy();
    expect(
      document.querySelector('[data-test="github-credentials-modal-error"]')
        ?.textContent ?? "",
    ).toContain("token does not match expected GitHub PAT shape");
    // form state retained — the input value is still in the DOM
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-test="github-credentials-token-input"]',
      )?.value,
    ).toBe("not-a-real-token");
    w.unmount();
  });

  it("surfaces a generic network error inline", async () => {
    mockPatch.mockRejectedValueOnce(new Error("network down"));

    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );

    const input = document.querySelector<HTMLInputElement>(
      '[data-test="github-credentials-token-input"]',
    );
    input!.value = "ghp_anything";
    input!.dispatchEvent(new Event("input"));
    await flushPromises();

    const dialog = document.querySelector("dialog");
    const confirmBtn = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((b) => b.textContent?.includes("Save token"));
    confirmBtn!.click();
    await flushPromises();

    expect(
      document.querySelector('[data-test="github-credentials-modal-error"]')
        ?.textContent ?? "",
    ).toContain("network down");
    w.unmount();
  });
});

describe("GitHubCredentialsModal — modal content (AC #2, #5)", () => {
  it("renders the numbered setup steps with required scopes + 90-day expiry", async () => {
    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );
    const body = document.querySelector(
      '[data-test="github-credentials-modal"]',
    )?.textContent ?? "";
    expect(body).toContain("danxbot-danxbot-<host>");
    expect(body).toContain("Contents: Read and write");
    expect(body).toContain("Metadata: Read-only");
    expect(body).toContain("90 days");
    expect(body).toContain("Only select repositories");
    w.unmount();
  });

  it("renders the PAT creation link + restart-required note", async () => {
    const w = mountModal();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-test="github-credentials-pat-link"]',
    );
    expect(link?.href).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(
      document.querySelector('[data-test="github-credentials-restart-note"]')
        ?.textContent,
    ).toMatch(/make launch-worker REPO=danxbot/);
    w.unmount();
  });
});
