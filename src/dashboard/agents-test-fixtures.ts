/**
 * Shared test fixtures for the per-module agents-* test files.
 *
 * Co-located with the modules (not in `src/__tests__/`) so each test
 * file imports from `./agents-test-fixtures.js` and the entire surface
 * lives in one directory. Keep this file fixture-only — no behavior,
 * no module-level vi.mock() calls (those must live in the consuming
 * test file or vitest hoists them ambiguously across siblings).
 */

import type { RepoConfig } from "../types.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

/**
 * Build a minimal Settings shape matching the production schema's
 * required keys. Test cases override individual fields by spreading
 * over the result.
 */
export function settings(
  overrides?: Partial<{
    slack: boolean | null;
    issuePoller: boolean | null;
    dispatchApi: boolean | null;
    ideator: boolean | null;
    autoTriage: boolean | null;
    trelloSync: boolean | null;
  }>,
) {
  return {
    overrides: {
      slack: { enabled: overrides?.slack ?? null },
      issuePoller: { enabled: overrides?.issuePoller ?? null },
      dispatchApi: { enabled: overrides?.dispatchApi ?? null },
      ideator: { enabled: overrides?.ideator ?? null },
      autoTriage: { enabled: overrides?.autoTriage ?? null },
      trelloSync: { enabled: overrides?.trelloSync ?? null },
    },
    display: {},
    meta: { updatedAt: "2026-04-20T00:00:00Z", updatedBy: "dashboard:test" },
  };
}

export const TEST_REPOS: RepoConfig[] = [
  {
    name: "danxbot",
    url: "https://github.com/newms/danxbot.git",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    workerPort: 5562,
  },
  {
    name: "platform",
    url: "https://github.com/newms/platform.git",
    localPath: "/repos/platform",
    hostPath: "/repos/platform",
    workerPort: 5563,
  },
];

export function deps(overrides?: Partial<DispatchProxyDeps>): DispatchProxyDeps {
  return {
    token: "test-token",
    repos: TEST_REPOS,
    resolveHost: () => "127.0.0.1",
    ...overrides,
  };
}

export const EMPTY_REPO_COUNTS = {
  total: { total: 0, slack: 0, trello: 0, api: 0 },
  last24h: { total: 0, slack: 0, trello: 0, api: 0 },
  today: { total: 0, slack: 0, trello: 0, api: 0 },
};

export const VALID_SCHEDULE = {
  tz: "America/Chicago",
  always_on: false,
  mon: ["09:00-17:00"],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [],
};

export function validAgentRecord(over?: Partial<{
  bio: string;
  capabilities: string[];
  enabled: boolean;
  avatar_path: string;
}>) {
  return {
    type: "agent" as const,
    bio: over?.bio ?? "Default test bio.",
    capabilities: over?.capabilities ?? ["issue-worker"],
    schedule: VALID_SCHEDULE,
    enabled: over?.enabled ?? true,
    created_at: "2026-05-08T12:00:00Z",
    updated_at: "2026-05-08T12:00:00Z",
    ...(over?.avatar_path !== undefined ? { avatar_path: over.avatar_path } : {}),
  };
}

export function settingsWithAgents(agents: Record<string, unknown>) {
  return {
    ...settings(),
    agents,
    agentDefaults: { prepMode: "combined" as const },
  };
}
