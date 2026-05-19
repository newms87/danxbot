/**
 * DX-365 — strike accumulator tests. Covers every AC on the card:
 *
 *  1. Strike helper increments on `failed`/`recovered`/`throttled`;
 *     skips `completed`/`cancelled`.
 *  2. 3rd strike atomically sets `agent.broken` + emits broken-transition.
 *  3. Strikes do NOT reset on success — durable counter.
 *  4. History capped at 3 most recent strikes; 4th strike when already
 *     broken does NOT re-emit the transition event.
 *  5. Concurrent failed-dispatch race produces exactly N strikes (no
 *     double-count) — exercises the `mutateAgents` lock + queue.
 *  6. All strike cases covered by unit tests including `throttled` +
 *     `recovered`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  _resetForTesting,
  mutateAgents,
  readSettings,
  settingsFilePath,
  STRIKES_HISTORY_CAP,
  STRIKES_MAX,
  type AgentBrokenState,
  type AgentRecord,
  type Settings,
} from "../settings-file.js";
import { dispatchEvents } from "../dispatch/events.js";
import {
  DEFAULT_BROKEN_REASON,
  isStrikeEligible,
  recordStrike,
  resetStrikes,
  type StrikeInput,
} from "./strikes.js";
import type { AgentStrikeEntry } from "../settings-file.js";

function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-strikes-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

function validAgent(over?: Partial<AgentRecord>): AgentRecord {
  return {
    type: "agent",
    bio: "Strike test bio.",
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
    broken: null,
    strikes: { count: 0, history: [] },
    created_at: "2026-05-14T00:00:00Z",
    updated_at: "2026-05-14T00:00:00Z",
    ...over,
  };
}

function seed(localPath: string, name: string, over?: Partial<AgentRecord>): void {
  const settings: Settings = {
    overrides: {
      slack: { enabled: null },
      issuePoller: { enabled: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
      autoTriage: { enabled: null },
      trelloSync: { enabled: null },
    },
    display: {},
    agents: { [name]: validAgent(over) },
    agentDefaults: { prepMode: "combined" },
    meta: { updatedAt: "2026-05-14T00:00:00Z", updatedBy: "worker" },
  };
  writeFileSync(
    settingsFilePath(localPath),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

function makeInput(over?: Partial<StrikeInput>): StrikeInput {
  return {
    dispatchId: over?.dispatchId ?? "dispatch-1",
    issueId: over?.issueId ?? "DX-100",
    terminalStatus: over?.terminalStatus ?? "failed",
    rawError: over?.rawError ?? "",
    timestamp: over?.timestamp ?? "2026-05-14T01:00:00Z",
  };
}

describe("strikes", () => {
  let localPath: string;
  let brokenSpy: Mock;

  beforeEach(() => {
    _resetForTesting();
    localPath = setupRepoDir();
    dispatchEvents.removeAllListeners();
    brokenSpy = vi.fn();
    dispatchEvents.on("broken-transition", brokenSpy);
  });

  afterEach(() => {
    dispatchEvents.removeAllListeners();
    rmSync(localPath, { recursive: true, force: true });
  });

  // =========================================================================
  // AC #1 — eligibility
  // =========================================================================

  describe("isStrikeEligible (AC #1)", () => {
    it("returns true for failed / recovered / throttled", () => {
      expect(isStrikeEligible("failed")).toBe(true);
      expect(isStrikeEligible("recovered")).toBe(true);
      expect(isStrikeEligible("throttled")).toBe(true);
    });

    it("returns false for completed / cancelled / running", () => {
      expect(isStrikeEligible("completed")).toBe(false);
      expect(isStrikeEligible("cancelled")).toBe(false);
      expect(isStrikeEligible("running")).toBe(false);
    });
  });

  // =========================================================================
  // AC #1 — recordStrike skips non-strike statuses BY CALLER GUARD
  // (recordStrike itself only accepts strike-eligible statuses; the gate is
  // in the call sites' `isStrikeEligible(status)` check before invocation).
  // The spec also says cancelled/completed do not call recordStrike at all.
  // =========================================================================

  describe("recordStrike — increments on each strike-eligible status", () => {
    it.each<["failed" | "recovered" | "throttled"][number] extends infer T
      ? T extends "failed" | "recovered" | "throttled"
        ? [T]
        : never
      : never>([
      ["failed"],
      ["recovered"],
      ["throttled"],
    ])("%s status increments count + appends history", async (status) => {
      seed(localPath, "alice");
      const result = await recordStrike(
        makeInput({ terminalStatus: status, dispatchId: `disp-${status}` }),
        { localPath, repoName: "myrepo", agentName: "alice" },
      );
      expect(result.count).toBe(1);
      expect(result.brokenTransitionEmitted).toBe(false);
      const onDisk = readSettings(localPath).agents?.alice;
      expect(onDisk?.strikes.count).toBe(1);
      expect(onDisk?.strikes.history).toHaveLength(1);
      expect(onDisk?.strikes.history[0].terminal_status).toBe(status);
      expect(onDisk?.strikes.history[0].dispatch_id).toBe(`disp-${status}`);
      expect(onDisk?.broken).toBeNull();
    });
  });

  // =========================================================================
  // AC #2 — 3rd strike atomically sets broken + emits event
  // =========================================================================

  describe("strike-3 transition (AC #2)", () => {
    it("3 sequential failed dispatches → strikes_count=3, broken populated, event fires once", async () => {
      seed(localPath, "alice");

      const r1 = await recordStrike(
        makeInput({ dispatchId: "d1", timestamp: "2026-05-14T01:00:00Z" }),
        { localPath, repoName: "r", agentName: "alice" },
      );
      const r2 = await recordStrike(
        makeInput({ dispatchId: "d2", timestamp: "2026-05-14T01:01:00Z" }),
        { localPath, repoName: "r", agentName: "alice" },
      );
      const r3 = await recordStrike(
        makeInput({ dispatchId: "d3", timestamp: "2026-05-14T01:02:00Z" }),
        { localPath, repoName: "r", agentName: "alice" },
      );

      expect(r1).toEqual({ count: 1, brokenTransitionEmitted: false });
      expect(r2).toEqual({ count: 2, brokenTransitionEmitted: false });
      expect(r3).toEqual({ count: 3, brokenTransitionEmitted: true });

      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(3);
      expect(after?.strikes.history).toHaveLength(3);
      expect(after?.broken).not.toBeNull();
      const broken = after!.broken as AgentBrokenState;
      expect(broken.reason).toBe(DEFAULT_BROKEN_REASON);
      expect(broken.set_at).toBe("2026-05-14T01:02:00Z");
      expect(broken.evaluator_status).toBe("pending");
      expect(broken.evaluator_dispatch_id).toBeNull();
      expect(broken.suggested_steps).toEqual([]);

      expect(brokenSpy).toHaveBeenCalledTimes(1);
      expect(brokenSpy).toHaveBeenCalledWith({
        repoName: "r",
        agentName: "alice",
      });
    });
  });

  // =========================================================================
  // AC #3 — strikes do NOT reset on success
  // =========================================================================

  describe("durable counter (AC #3)", () => {
    it("2 failed + 1 completed (no recordStrike call) + 1 failed → count = 3 (no reset)", async () => {
      seed(localPath, "alice");

      await recordStrike(makeInput({ dispatchId: "d1" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      await recordStrike(makeInput({ dispatchId: "d2" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      // Simulate a completed dispatch — call sites SKIP recordStrike for
      // completed (gated by `isStrikeEligible`). The counter must persist.
      // No call here.
      const r4 = await recordStrike(makeInput({ dispatchId: "d4" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });

      expect(r4.count).toBe(3);
      expect(r4.brokenTransitionEmitted).toBe(true);
      expect(readSettings(localPath).agents?.alice.strikes.count).toBe(3);
    });
  });

  // =========================================================================
  // AC #4 — history capped at STRIKES_HISTORY_CAP, no second event after broken
  // =========================================================================

  describe("history cap + idempotent broken transition (AC #4)", () => {
    it("4th strike when already broken — count stays at STRIKES_MAX, history rotates, NO second event", async () => {
      seed(localPath, "alice");

      await recordStrike(makeInput({ dispatchId: "d1" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      await recordStrike(makeInput({ dispatchId: "d2" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      await recordStrike(makeInput({ dispatchId: "d3" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      // 3rd strike emitted broken-transition.
      expect(brokenSpy).toHaveBeenCalledTimes(1);

      const r4 = await recordStrike(
        makeInput({ dispatchId: "d4", timestamp: "2026-05-14T02:00:00Z" }),
        { localPath, repoName: "r", agentName: "alice" },
      );

      // Count caps at STRIKES_MAX (the schema validator rejects higher).
      expect(r4.count).toBe(STRIKES_MAX);
      // Critical: the broken-transition event MUST NOT re-fire — broken
      // was already populated; the dashboard banner stays steady.
      expect(r4.brokenTransitionEmitted).toBe(false);
      expect(brokenSpy).toHaveBeenCalledTimes(1);

      // History rotated to keep only the LAST STRIKES_HISTORY_CAP entries.
      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.history).toHaveLength(STRIKES_HISTORY_CAP);
      const ids = after!.strikes.history.map((e) => e.dispatch_id);
      expect(ids).toEqual(["d2", "d3", "d4"]);
      // broken.reason / set_at / evaluator state unchanged from the
      // strike-3 stamp (4th strike does NOT overwrite them).
      const broken = after!.broken as AgentBrokenState;
      expect(broken.set_at).not.toBe("2026-05-14T02:00:00Z");
      expect(broken.evaluator_status).toBe("pending");
    });
  });

  // =========================================================================
  // AC #5 — concurrent strike race produces exactly N strikes
  // =========================================================================

  describe("concurrent strike race (AC #5)", () => {
    it("two failed dispatches finalized concurrently → final count is exactly 2 (no double-count, no lost increment)", async () => {
      seed(localPath, "alice");

      const [r1, r2] = await Promise.all([
        recordStrike(
          makeInput({ dispatchId: "race-1", timestamp: "2026-05-14T03:00:00Z" }),
          { localPath, repoName: "r", agentName: "alice" },
        ),
        recordStrike(
          makeInput({ dispatchId: "race-2", timestamp: "2026-05-14T03:00:00Z" }),
          { localPath, repoName: "r", agentName: "alice" },
        ),
      ]);

      // The mutateAgents lock + in-process queue serializes the writes.
      // Whichever lands first sees count=0→1; the other sees 1→2. Both
      // calls return success.
      const counts = [r1.count, r2.count].sort();
      expect(counts).toEqual([1, 2]);

      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(2);
      expect(after?.strikes.history).toHaveLength(2);
      const ids = after!.strikes.history.map((e) => e.dispatch_id).sort();
      expect(ids).toEqual(["race-1", "race-2"]);
    });

    it("five failed dispatches finalized concurrently → count caps at STRIKES_MAX, 1 broken event", async () => {
      seed(localPath, "alice");

      const calls = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          recordStrike(
            makeInput({
              dispatchId: `burst-${i}`,
              timestamp: `2026-05-14T03:00:0${i}Z`,
            }),
            { localPath, repoName: "r", agentName: "alice" },
          ),
        ),
      );

      // Strikes serialize through the lock; counts will be 1..5 in some
      // order, BUT the on-disk counter caps at STRIKES_MAX (=3).
      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(STRIKES_MAX);
      // History is capped — only the last 3 strikes survive.
      expect(after?.strikes.history).toHaveLength(STRIKES_HISTORY_CAP);
      // Broken-transition emitted EXACTLY once (the strike that landed at
      // count == STRIKES_MAX). The other 4 calls observed already-broken
      // OR were beneath the threshold.
      expect(brokenSpy).toHaveBeenCalledTimes(1);
      // Sanity — every call returned a count <= STRIKES_MAX.
      for (const r of calls) {
        expect(r.count).toBeLessThanOrEqual(STRIKES_MAX);
        expect(r.count).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // =========================================================================
  // Fail-loud surfaces
  // =========================================================================

  describe("fail-loud", () => {
    it("throws when the agent does not exist on disk", async () => {
      seed(localPath, "alice");
      await expect(
        recordStrike(makeInput(), {
          localPath,
          repoName: "r",
          agentName: "ghost",
        }),
      ).rejects.toThrow(/agent "ghost" not found/);
    });

    it("rejects empty timestamp / dispatchId / issueId at the boundary", async () => {
      seed(localPath, "alice");
      await expect(
        recordStrike(makeInput({ timestamp: "" }), {
          localPath,
          repoName: "r",
          agentName: "alice",
        }),
      ).rejects.toThrow(/timestamp must be non-empty/);
      await expect(
        recordStrike(makeInput({ dispatchId: "" }), {
          localPath,
          repoName: "r",
          agentName: "alice",
        }),
      ).rejects.toThrow(/dispatchId must be non-empty/);
      await expect(
        recordStrike(makeInput({ issueId: "" }), {
          localPath,
          repoName: "r",
          agentName: "alice",
        }),
      ).rejects.toThrow(/issueId must be non-empty/);
    });
  });

  // =========================================================================
  // Pre-broken stamp respect — manual broken via setAgentBroken (Phase 5)
  // =========================================================================

  describe("pre-existing broken record", () => {
    it("does NOT overwrite an already-populated broken when crossing STRIKES_MAX", async () => {
      const preExistingBroken: AgentBrokenState = {
        reason: "operator-set reason",
        suggested_steps: ["step1"],
        set_at: "2026-05-14T00:00:00Z",
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      };
      seed(localPath, "alice", { broken: preExistingBroken });

      // Drive to count = 3.
      await recordStrike(makeInput({ dispatchId: "d1" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      await recordStrike(makeInput({ dispatchId: "d2" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });
      const r3 = await recordStrike(makeInput({ dispatchId: "d3" }), {
        localPath,
        repoName: "r",
        agentName: "alice",
      });

      // Crossing STRIKES_MAX did NOT re-emit (broken was already set) and
      // the operator's reason / steps survived.
      expect(r3.brokenTransitionEmitted).toBe(false);
      expect(brokenSpy).not.toHaveBeenCalled();
      const after = readSettings(localPath).agents?.alice
        .broken as AgentBrokenState;
      expect(after.reason).toBe("operator-set reason");
      expect(after.suggested_steps).toEqual(["step1"]);
      expect(after.set_at).toBe("2026-05-14T00:00:00Z");
    });
  });

  // =========================================================================
  // DX-604 — resetStrikes clears the durable counter on success
  // =========================================================================

  describe("resetStrikes (DX-604)", () => {
    function entry(over: Partial<AgentStrikeEntry> = {}): AgentStrikeEntry {
      return {
        dispatch_id: over.dispatch_id ?? "d1",
        issue_id: over.issue_id ?? "DX-1",
        terminal_status: over.terminal_status ?? "failed",
        timestamp: over.timestamp ?? "2026-05-14T00:00:01Z",
        raw_error: over.raw_error ?? "",
      };
    }

    it("clears count + history on an agent with prior strikes", async () => {
      seed(localPath, "alice", {
        strikes: {
          count: 2,
          history: [
            entry({ dispatch_id: "d1" }),
            entry({ dispatch_id: "d2", timestamp: "2026-05-14T00:00:02Z" }),
          ],
        },
      });
      await resetStrikes({
        localPath,
        agentName: "alice",
        timestamp: "2026-05-14T10:00:00Z",
      });
      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(0);
      expect(after?.strikes.history).toEqual([]);
      expect(after?.updated_at).toBe("2026-05-14T10:00:00Z");
    });

    it("preserves an existing broken record — operator clears broken via dashboard", async () => {
      const preExistingBroken: AgentBrokenState = {
        reason: "operator-set",
        suggested_steps: ["check logs"],
        set_at: "2026-05-14T00:00:00Z",
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      };
      seed(localPath, "alice", {
        strikes: { count: 3, history: [entry()] },
        broken: preExistingBroken,
      });
      await resetStrikes({
        localPath,
        agentName: "alice",
        timestamp: "2026-05-14T10:00:00Z",
      });
      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(0);
      expect(after?.broken).not.toBeNull();
      expect((after!.broken as AgentBrokenState).reason).toBe("operator-set");
      expect((after!.broken as AgentBrokenState).suggested_steps).toEqual([
        "check logs",
      ]);
    });

    it("no-ops when strikes already at {count:0, history:[]} — does not touch updated_at", async () => {
      seed(localPath, "alice");
      await resetStrikes({
        localPath,
        agentName: "alice",
        timestamp: "2026-05-14T10:00:00Z",
      });
      const after = readSettings(localPath).agents?.alice;
      expect(after?.strikes.count).toBe(0);
      expect(after?.strikes.history).toEqual([]);
      // updated_at unchanged from seed value — the skip avoided the write.
      expect(after?.updated_at).toBe("2026-05-14T00:00:00Z");
    });

    it("throws when the agent does not exist", async () => {
      seed(localPath, "alice");
      await expect(
        resetStrikes({
          localPath,
          agentName: "ghost",
          timestamp: "2026-05-14T10:00:00Z",
        }),
      ).rejects.toThrow(/agent "ghost" not found/);
    });

    it("rejects empty timestamp at the boundary", async () => {
      seed(localPath, "alice");
      await expect(
        resetStrikes({ localPath, agentName: "alice", timestamp: "" }),
      ).rejects.toThrow(/timestamp must be non-empty/);
    });

    it("serializes against a concurrent recordStrike via mutateAgents lock", async () => {
      seed(localPath, "alice", {
        strikes: {
          count: 2,
          history: [
            entry({ dispatch_id: "d1" }),
            entry({ dispatch_id: "d2", timestamp: "2026-05-14T00:00:02Z" }),
          ],
        },
      });
      // Two concurrent writers: a reset and a new strike. The lock + queue
      // serializes them; the only observable invariant is "neither lost"
      // — final count is either {reset → strike} = 1 OR {strike → reset}
      // = 0. Any other value means the lock failed.
      await Promise.all([
        resetStrikes({
          localPath,
          agentName: "alice",
          timestamp: "2026-05-14T10:00:00Z",
        }),
        recordStrike(makeInput({ dispatchId: "race-strike" }), {
          localPath,
          repoName: "r",
          agentName: "alice",
        }),
      ]);
      const after = readSettings(localPath).agents?.alice;
      // count and history length agree — a partial write that shipped one
      // without the other (lock failure) would fail this dual assertion.
      expect([0, 1]).toContain(after!.strikes.count);
      expect(after!.strikes.history).toHaveLength(after!.strikes.count);
    });
  });
});
