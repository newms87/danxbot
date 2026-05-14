/**
 * DX-513 — fallback chain unit tests for `resolveDispatchEffort`.
 *
 * Five branches (matches the AC table in the card body):
 *
 *   1. Card override present → returns the card's level verbatim.
 *   2. Card override null + agent has `effortLevel` → returns agent's.
 *   3. Card override null + agent has no setting → returns `"medium"`.
 *   4. No card (Slack / API) + agent has `effortLevel` → returns agent's.
 *   5. No card + no agent setting → returns `"medium"`.
 *
 * Plus two edges:
 *
 *   - Card override of `undefined` is treated identically to `null`
 *     (TS callers may pass either; production reads YAMLs that emit
 *     `null` for the missing case, dashboard PATCHes may emit
 *     `undefined`).
 *   - Card override wins even when an agent name is also set — step 1
 *     is unconditional when the candidate has a level stamped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { resolveDispatchEffort } from "./resolve-dispatch-effort.js";

let tmpRepo: string;

function writeAgentEffortLevel(
  agentName: string,
  effortLevel: string | undefined,
): void {
  const agents: Record<string, unknown> = {
    [agentName]: {
      type: "agent",
      bio: "test",
      capabilities: ["issue-worker"],
      schedule: {
        tz: "UTC",
        always_on: true,
        mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
      enabled: true,
      broken: null,
      strikes: { count: 0, history: [] },
      created_at: "2026-05-14T00:00:00Z",
      updated_at: "2026-05-14T00:00:00Z",
      ...(effortLevel !== undefined ? { effortLevel } : {}),
    },
  };
  const settingsDir = resolve(tmpRepo, ".danxbot");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    resolve(settingsDir, "settings.json"),
    JSON.stringify({ agents }),
  );
}

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), "danxbot-resolve-effort-"));
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveDispatchEffort", () => {
  it("step 1 wins: card override returns verbatim", () => {
    writeAgentEffortLevel("alice", "low");
    const result = resolveDispatchEffort({
      cardEffortLevel: "high",
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("high");
  });

  it("step 2: card null + agent default → agent's effortLevel", () => {
    writeAgentEffortLevel("alice", "low");
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("low");
  });

  it("step 3: card null + agent has no effortLevel → medium", () => {
    writeAgentEffortLevel("alice", undefined);
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("medium");
  });

  it("step 2 also fires when agentName supplied but no card (Slack / API path)", () => {
    writeAgentEffortLevel("alice", "max");
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("max");
  });

  it("step 3 also fires when there is no card AND no agent (untargeted dispatch)", () => {
    // No agent name supplied → cannot consult agent record → built-in default.
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: null,
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("medium");
  });

  it("card override of `undefined` falls through to step 2 (same as null)", () => {
    // TS callers may pass either; production reads YAMLs that emit
    // `null` for the missing case, dashboard PATCHes may emit
    // `undefined`. Both must behave identically — step 1 only fires on
    // a non-null value.
    writeAgentEffortLevel("alice", "very_high");
    const result = resolveDispatchEffort({
      cardEffortLevel: undefined,
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("very_high");
  });

  it("card override wins even with agent name set (step 1 unconditional)", () => {
    writeAgentEffortLevel("alice", "low");
    const result = resolveDispatchEffort({
      cardEffortLevel: "min",
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("min");
  });

  it("agentName empty string treated as 'no agent' — fall through to step 3", () => {
    // `getAgentEffortLevel` would return DEFAULT for an empty key
    // anyway, but the resolver guards on truthiness so we never even
    // hit the settings read for an empty / falsy agent name.
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: "",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("medium");
  });

  it("missing settings file → step 3 default (read fails soft inside getAgentEffortLevel)", () => {
    // The `<localPath>/.danxbot/settings.json` file is never written —
    // `getAgentEffortLevel` swallows the error and returns the
    // DEFAULT. The resolver therefore returns medium even though an
    // agent name was supplied.
    const result = resolveDispatchEffort({
      cardEffortLevel: null,
      agentName: "alice",
      repoLocalPath: tmpRepo,
    });
    expect(result).toBe("medium");
  });
});
