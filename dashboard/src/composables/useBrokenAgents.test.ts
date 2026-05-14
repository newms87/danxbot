import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { deriveBrokenAgents } from "./useBrokenAgents";
import type { AgentBrokenState, AgentSnapshot } from "../types";

function snapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "danxbot",
    repoName: "danxbot",
    url: "u",
    settings: {
      schema_version: 1,
      meta: { updatedAt: "", updatedBy: "test" },
      overrides: {
        slack: { enabled: null },
        issuePoller: { enabled: null },
        dispatchApi: { enabled: null },
        ideator: { enabled: null },
        autoTriage: { enabled: null },
        trelloSync: { enabled: null },
      },
      display: null,
      agents: {},
      agentDefaults: { prepMode: "combined" },
    } as unknown as AgentSnapshot["settings"],
    counts: {
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    },
    worker: { reachable: true, lastSeenMs: 1 },
    criticalFailure: null,
    issuePrefix: "DX",
    ...over,
  };
}

function agent(over: { broken?: AgentBrokenState | null; count?: number } = {}) {
  return {
    type: "agent" as const,
    bio: "",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      always_on: true,
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    broken:
      "broken" in over
        ? over.broken!
        : {
            reason: "Agent dispatch failing — investigation pending",
            suggested_steps: [],
            set_at: "2026-05-14T10:00:00Z",
            evaluator_status: "completed" as const,
            evaluator_dispatch_id: null,
          },
    strikes: {
      count: over.count ?? 3,
      history: [],
    },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-14T10:00:00Z",
  };
}

describe("deriveBrokenAgents — pure helper", () => {
  it("returns [] when no agent on any repo is broken", () => {
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: { alice: agent({ broken: null }), bob: agent({ broken: null }) },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    expect(deriveBrokenAgents(snaps)).toEqual([]);
  });

  it("flattens broken agents across repos with stable repo+agent order", () => {
    const snaps = [
      snapshot({
        name: "danxbot",
        repoName: "danxbot",
        settings: {
          ...snapshot().settings,
          agents: {
            charlie: agent(),
            alice: agent({ broken: null }),
            bob: agent(),
          },
        } as unknown as AgentSnapshot["settings"],
      }),
      snapshot({
        name: "platform",
        repoName: "platform",
        settings: {
          ...snapshot().settings,
          agents: { eve: agent() },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    const out = deriveBrokenAgents(snaps);
    // danxbot first (snapshot order from /api/agents response), agents
    // alphabetical within: bob, charlie. Then platform.eve.
    expect(out.map((e) => `${e.repoName}/${e.agentName}`)).toEqual([
      "danxbot/bob",
      "danxbot/charlie",
      "platform/eve",
    ]);
  });

  it("carries broken + strikes through verbatim and stamps unblocking/reRunning=false", () => {
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: {
            alice: agent({ count: 3 }),
          },
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    const out = deriveBrokenAgents(snaps);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      repoName: "danxbot",
      agentName: "alice",
      strikes: { count: 3, history: [] },
      unblocking: false,
      reRunning: false,
    });
    expect(out[0].broken!.reason).toMatch(/investigation pending/);
  });

  it("handles missing agents map (legacy fixture / corrupt settings)", () => {
    const snaps = [
      snapshot({
        settings: {
          ...snapshot().settings,
          agents: undefined as unknown as AgentSnapshot["settings"]["agents"],
        } as unknown as AgentSnapshot["settings"],
      }),
    ];
    expect(deriveBrokenAgents(snaps)).toEqual([]);
  });
});

// DX-227 no-polling source check — every server-state composable carries
// this per-file lock so a regression "I'll just refresh every 30s here"
// fails the test before it lands. Repo-level sweep in
// `no-poll-imports.test.ts` is the second layer.
describe("useBrokenAgents source — no setInterval", () => {
  it("does NOT call setInterval (server state flows via SSE only)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "useBrokenAgents.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
  });
});
