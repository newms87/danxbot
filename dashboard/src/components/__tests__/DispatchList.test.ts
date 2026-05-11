import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DispatchList from "../DispatchList.vue";
import type { Dispatch } from "../../types";

/**
 * Component tests for the Recovers column + parent linkage indicator added
 * in DX-261 (Phase 3 of DX-246). The integration test in
 * `src/__tests__/integration/api-error-recover.test.ts` proves the recover
 * pipeline produces the columns; this suite proves the SPA surfaces them.
 *
 * `.claude/rules/danx-no-false-blockers.md` Pattern 2 — "manual UI smoke" /
 * "operator clicks X" ACs verified programmatically via @vue/test-utils
 * mount + DOM assertion. No human eyeball required.
 */

function makeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-aaaa-bbbb-cccc-dddd",
    repoName: "danxbot",
    trigger: "api",
    triggerMetadata: {
      endpoint: "/api/launch",
      callerIp: null,
      statusUrl: null,
      initialPrompt: "go",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: null,
    status: "completed",
    startedAt: 1700000000000,
    completedAt: 1700000060000,
    summary: null,
    error: null,
    runtimeMode: "docker",
    tokensTotal: 100,
    tokensIn: 50,
    tokensOut: 50,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 5,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    mcpSettingsPath: null,
    recoverCount: 0,
    parentRecoverId: null,
    ...overrides,
  };
}

describe("DispatchList — recover surface (DX-261)", () => {
  it("renders the Recovers column header", () => {
    const w = mount(DispatchList, {
      props: { dispatches: [makeDispatch()], loading: false },
    });
    // Column header text — case-sensitive match keeps the test honest
    // against a future rename that would drift the dashboard from the
    // rules-doc terminology.
    expect(w.text()).toContain("Recovers");
  });

  it("renders empty recover cell when recoverCount === 0", () => {
    const w = mount(DispatchList, {
      props: { dispatches: [makeDispatch({ recoverCount: 0 })], loading: false },
    });
    const cell = w.find('[data-testid="recover-cell"]');
    expect(cell.exists()).toBe(true);
    // Badge intentionally absent when count is 0 — keeps the column visually
    // quiet for the (vast majority) of dispatches that never recovered.
    expect(w.find('[data-testid="recover-badge"]').exists()).toBe(false);
  });

  it("renders the recover badge with count when recoverCount > 0", () => {
    const w = mount(DispatchList, {
      props: {
        dispatches: [makeDispatch({ recoverCount: 2 })],
        loading: false,
      },
    });
    const badge = w.find('[data-testid="recover-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe("2");
    // Amber styling — consistent with the rules-doc note that recovers
    // indicate a non-fatal-but-noteworthy chain event.
    expect(badge.classes()).toContain("bg-amber-500/20");
    expect(badge.classes()).toContain("text-amber-300");
  });

  it("does NOT render the recover chain indicator when parentRecoverId is null", () => {
    const w = mount(DispatchList, {
      props: {
        dispatches: [makeDispatch({ parentRecoverId: null })],
        loading: false,
      },
    });
    expect(w.find('[data-testid="recover-chain-indicator"]').exists()).toBe(
      false,
    );
  });

  it("renders the recover chain indicator when parentRecoverId is non-null", () => {
    const parentId = "parent-1234-aaaa-bbbb-cccc";
    const w = mount(DispatchList, {
      props: {
        dispatches: [makeDispatch({ parentRecoverId: parentId })],
        loading: false,
      },
    });
    const indicator = w.find('[data-testid="recover-chain-indicator"]');
    expect(indicator.exists()).toBe(true);
    // Tooltip carries the parent id so operators can walk the chain by
    // hovering — without it the indicator would mark "this is a recovery"
    // without surfacing WHICH dispatch it recovered from.
    expect(indicator.attributes("title")).toContain(parentId);
  });

  it("renders both the Recovers badge AND the chain indicator on a mid-chain recovered dispatch", () => {
    // A dispatch that auto-recovered TWICE and is itself a child of a
    // prior chain link carries both fields. The dashboard surfaces both
    // independently — the badge shows "how many" on THIS row, the
    // indicator shows "this row continues a chain."
    const w = mount(DispatchList, {
      props: {
        dispatches: [
          makeDispatch({ recoverCount: 2, parentRecoverId: "prior-id" }),
        ],
        loading: false,
      },
    });
    expect(w.find('[data-testid="recover-badge"]').text()).toBe("2");
    expect(w.find('[data-testid="recover-chain-indicator"]').exists()).toBe(
      true,
    );
  });
});
