import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { AgentSnapshot } from "../../types";

// Stub the api module so the modal's PATCH never escapes the test.
const mockPatch = vi.fn();
vi.mock("../../api", () => ({
  patchGithubCredentials: (...args: unknown[]) => mockPatch(...args),
}));

import GitHubCredentialsSection from "./GitHubCredentialsSection.vue";

function makeAgent(
  github: AgentSnapshot["githubCredentials"],
  name = "danxbot",
): AgentSnapshot {
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
      display: { trello: {}, links: {} },
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
    githubCredentials: github,
  } as unknown as AgentSnapshot;
}

beforeEach(() => {
  mockPatch.mockReset();
});

describe("GitHubCredentialsSection — status badges (AC #1)", () => {
  it("renders Not-registered badge when registered=false", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: false,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: null,
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-badge-missing"]').text(),
    ).toContain("Not registered");
    expect(
      w.find('[data-test="github-credentials-last-validated"]').exists(),
    ).toBe(false);
    expect(
      w.get('[data-test="github-credentials-register-button"]').text(),
    ).toBe("Register token");
  });

  it("renders Registered+Validated when probe passed", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
          last_validation_error: null,
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-badge-ok"]').text(),
    ).toContain("Registered + Validated");
    expect(
      w.get('[data-test="github-credentials-last-validated"]').text(),
    ).toMatch(/Last validated 5m ago/);
    expect(
      w.get('[data-test="github-credentials-register-button"]').text(),
    ).toBe("Rotate token");
  });

  it("renders Registered (invalid shape) warn badge when token shape failed", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error:
            "Token does not match expected GitHub PAT shape (ghp_/ghs_/github_pat_).",
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-badge-warn"]').text(),
    ).toContain("Registered (invalid shape)");
    expect(w.get('[data-test="github-credentials-reason"]').text()).toContain(
      "Token does not match expected GitHub PAT shape",
    );
  });

  it("renders Registered (not yet validated) warn badge when probe is cold", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: null,
          last_validation_error: null,
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-badge-warn"]').text(),
    ).toContain("Registered (not yet validated)");
    expect(
      w.find('[data-test="github-credentials-last-validated"]').exists(),
    ).toBe(false);
  });

  it("renders Registered+Invalid with reason when probe rejected", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: "GitHub rejected the token (401)",
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-badge-warn"]').text(),
    ).toContain("Registered (validation failed)");
    expect(w.get('[data-test="github-credentials-reason"]').text()).toContain(
      "GitHub rejected the token (401)",
    );
  });
});

describe("GitHubCredentialsSection — instructions panel (AC #6)", () => {
  it("collapses by default and expands on click", async () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: false,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: null,
        }),
      },
    });
    expect(
      w.find('[data-test="github-credentials-instructions"]').exists(),
    ).toBe(false);
    await w
      .get('[data-test="github-credentials-instructions-toggle"]')
      .trigger("click");
    const panel = w.get('[data-test="github-credentials-instructions"]');
    expect(panel.text()).toContain("danxbot-danxbot-<host>");
    expect(
      panel.get('[data-test="github-credentials-instructions-link"]').attributes("href"),
    ).toBe("https://github.com/settings/personal-access-tokens/new");
  });
});

describe("GitHubCredentialsSection — modal interaction (AC #3)", () => {
  it("opens the modal on Register click and emits `refresh` after a saved event", async () => {
    const w = mount(GitHubCredentialsSection, {
      attachTo: document.body,
      props: {
        agent: makeAgent({
          registered: false,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: null,
        }),
      },
    });
    // Modal mounts inside DanxDialog; before click, no token input is in the DOM.
    expect(
      document.querySelector('[data-test="github-credentials-token-input"]'),
    ).toBeNull();
    await w
      .get('[data-test="github-credentials-register-button"]')
      .trigger("click");
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-test="github-credentials-token-input"]'),
      ).not.toBeNull();
    });

    // Simulate the modal emitting `saved` directly (the modal's own tests
    // cover the PATCH path; this assertion locks the wiring contract).
    const modal = w.findComponent({ name: "GitHubCredentialsModal" });
    expect(modal.exists()).toBe(true);
    modal.vm.$emit("saved", {
      registered: true,
      token_shape_valid: true,
      last_validated_at: new Date().toISOString(),
      last_validation_error: null,
    });
    await w.vm.$nextTick();
    expect(w.emitted("refresh")).toBeTruthy();
    expect(w.emitted("refresh")![0]).toEqual(["danxbot"]);
    w.unmount();
  });
});

describe("GitHubCredentialsSection — SSE-driven badge update (AC #7)", () => {
  it("re-renders the badge when the agent prop changes", async () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: false,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: null,
        }),
      },
    });
    expect(
      w.find('[data-test="github-credentials-badge-missing"]').exists(),
    ).toBe(true);

    await w.setProps({
      agent: makeAgent({
        registered: true,
        token_shape_valid: true,
        last_validated_at: new Date().toISOString(),
        last_validation_error: null,
      }),
    });
    expect(
      w.find('[data-test="github-credentials-badge-ok"]').exists(),
    ).toBe(true);
  });
});
