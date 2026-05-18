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

/**
 * Convenience: build a `GithubCredentialsSnapshot` with the new (DX-661)
 * masked-token fields defaulted to their canonical empty values. The
 * existing badge / instructions / modal tests do not exercise the new
 * fields, so a single helper keeps those fixtures terse while still
 * matching the server's strict shape.
 */
function snapshot(
  over: Partial<AgentSnapshot["githubCredentials"]> = {},
): AgentSnapshot["githubCredentials"] {
  return {
    registered: false,
    token_shape_valid: false,
    last_validated_at: null,
    last_validation_error: null,
    token_prefix: "",
    token_suffix: "",
    token_expires_at: null,
    token_user_login: null,
    ...over,
  };
}

describe("GitHubCredentialsSection — status badges (AC #1)", () => {
  it("renders Not-registered badge when registered=false", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent(snapshot()),
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
        agent: makeAgent(snapshot({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        })),
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
        agent: makeAgent(snapshot({
          registered: true,
          token_shape_valid: false,
          last_validation_error:
            "Token does not match expected GitHub PAT shape (ghp_/ghs_/github_pat_).",
        })),
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
        agent: makeAgent(snapshot({
          registered: true,
          token_shape_valid: true,
        })),
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
        agent: makeAgent(snapshot({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: "GitHub rejected the token (401)",
        })),
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
        agent: makeAgent(snapshot()),
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
        agent: makeAgent(snapshot()),
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
          token_prefix: "",
          token_suffix: "",
          token_expires_at: null,
          token_user_login: null,
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
        token_prefix: "ghp_abc",
        token_suffix: "wxyz",
        token_expires_at: null,
        token_user_login: null,
      }),
    });
    expect(
      w.find('[data-test="github-credentials-badge-ok"]').exists(),
    ).toBe(true);
  });
});

// ============================================================
// DX-661 — masked token + expiry + authenticated-as
// ============================================================

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isoYmd(iso: string): string {
  return iso.slice(0, 10);
}

describe("GitHubCredentialsSection — masked token (DX-661)", () => {
  it("renders `prefix…suffix` in monospace when token_prefix is non-empty", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: null,
          token_user_login: null,
        }),
      },
    });
    const masked = w.get('[data-test="github-credentials-masked-token"]');
    expect(masked.text()).toBe("ghp_abc…wxyz");
    expect(masked.classes()).toContain("font-mono");
  });

  it("omits the masked-token line when token_prefix is empty (unregistered)", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: false,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: null,
          token_prefix: "",
          token_suffix: "",
          token_expires_at: null,
          token_user_login: null,
        }),
      },
    });
    expect(
      w.find('[data-test="github-credentials-masked-token"]').exists(),
    ).toBe(false);
  });

  it("renders just the prefix when the suffix is empty (short token defense)", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: false,
          last_validated_at: null,
          last_validation_error: "Token does not match expected GitHub PAT shape.",
          token_prefix: "ghp_a",
          token_suffix: "",
          token_expires_at: null,
          token_user_login: null,
        }),
      },
    });
    expect(
      w.get('[data-test="github-credentials-masked-token"]').text(),
    ).toBe("ghp_a");
  });
});

describe("GitHubCredentialsSection — token expiry (DX-661)", () => {
  it("renders an `Expires in Nd (YYYY-MM-DD)` line for a far-future expiry — non-warn styling", () => {
    const expires = isoDaysFromNow(30);
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: expires,
          token_user_login: null,
        }),
      },
    });
    const el = w.get('[data-test="github-credentials-expiry"]');
    expect(el.text()).toMatch(/Expires in 30d \(\d{4}-\d{2}-\d{2}\)/);
    expect(el.text()).toContain(isoYmd(expires));
    expect(
      w.find('[data-test="github-credentials-expiry-warn"]').exists(),
    ).toBe(false);
  });

  it("renders the amber warn variant when expiry is within 14 days", () => {
    const expires = isoDaysFromNow(7);
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: expires,
          token_user_login: null,
        }),
      },
    });
    const el = w.get('[data-test="github-credentials-expiry-warn"]');
    expect(el.text()).toMatch(/Expires in 7d/);
    expect(el.classes().join(" ")).toMatch(/amber/);
  });

  it("renders `Expired Nd ago (YYYY-MM-DD)` for a past expiry — amber warn variant", () => {
    const expires = isoDaysFromNow(-3);
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: expires,
          token_user_login: null,
        }),
      },
    });
    const el = w.get('[data-test="github-credentials-expiry-warn"]');
    expect(el.text()).toMatch(/Expired 3d ago/);
    expect(el.text()).toContain(isoYmd(expires));
  });

  it("omits the expiry line entirely when token_expires_at is null", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: null,
          token_user_login: null,
        }),
      },
    });
    expect(
      w.find('[data-test="github-credentials-expiry"]').exists(),
    ).toBe(false);
    expect(
      w.find('[data-test="github-credentials-expiry-warn"]').exists(),
    ).toBe(false);
  });
});

describe("GitHubCredentialsSection — authenticated-as (DX-661)", () => {
  it("renders `Authenticated as @<login>` when token_user_login is present", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: null,
          token_user_login: "alice",
        }),
      },
    });
    const el = w.get('[data-test="github-credentials-user-login"]');
    expect(el.text()).toBe("Authenticated as @alice");
    expect(el.classes()).toContain("italic");
  });

  it("omits the authenticated-as line when token_user_login is null", () => {
    const w = mount(GitHubCredentialsSection, {
      props: {
        agent: makeAgent({
          registered: true,
          token_shape_valid: true,
          last_validated_at: new Date().toISOString(),
          last_validation_error: null,
          token_prefix: "ghp_abc",
          token_suffix: "wxyz",
          token_expires_at: null,
          token_user_login: null,
        }),
      },
    });
    expect(
      w.find('[data-test="github-credentials-user-login"]').exists(),
    ).toBe(false);
  });
});
