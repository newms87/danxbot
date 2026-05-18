/**
 * Unit tests for `self-repair-dispatch.ts` — DX-651 (Phase 2 of DX-580).
 *
 * Every external dep is injected — candidate query, dispatch entry-point,
 * worker-fault filter, RepoContext resolver, UUID generator, transactional
 * write pair, compensator, clock, logger. No real Postgres, no real
 * `dispatch()`, no real wall-clock.
 *
 * The job's contract surface:
 *   - SQL pre-filter is broad; isWorkerFaultCategory is the LOAD-BEARING wall.
 *   - One dispatch per tick — multi-candidate test pins it.
 *   - In-flight + cap-exceeded skip individually.
 *   - dispatch() throw → compensator fires; no DB residue.
 *   - Top-level swallow — no rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pickCandidate,
  runSelfRepairDispatch,
  selfRepairDispatch,
  REPAIR_WORKSPACE,
  type CandidateRow,
  type CompensateInput,
  type InsertRepairInput,
  type SelfRepairDispatchDeps,
  type SelfRepairDispatchLogLine,
} from "./self-repair-dispatch.js";
import { REPAIR_CAP } from "../../system-repair/types.js";
import type { CronJobContext } from "../types.js";
import type { DispatchInput, DispatchResult } from "../../dispatch/core.js";
import { makeRepoContext } from "../../__tests__/helpers/fixtures.js";

const FIXED_NOW = Date.UTC(2026, 4, 18, 9, 30, 0);

function fakeRepo() {
  return makeRepoContext({
    name: "danxbot",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    workerPort: 5562,
    issuePrefix: "DX",
  });
}

function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 1,
    signature_hash: "abc1234567890def",
    category_key: "worker-boot:DispatchSpawnError",
    component: "worker-boot",
    err_class: "DispatchSpawnError",
    normalized_msg: "spawnAgent threw before claude PID landed",
    sample_payload: { raw_msg: "test" },
    count: 5,
    first_seen: new Date("2026-05-18T08:00:00Z"),
    last_seen: new Date("2026-05-18T09:00:00Z"),
    status: "open",
    repo: "danxbot",
    recurrence_count: 0,
    max_attempt_n: 0,
    has_in_flight: false,
    ...over,
  };
}

interface BuiltDeps {
  deps: SelfRepairDispatchDeps;
  dispatchCalls: DispatchInput[];
  insertCalls: InsertRepairInput[];
  compensateCalls: CompensateInput[];
  logged: SelfRepairDispatchLogLine[];
}

function buildDeps(over: Partial<SelfRepairDispatchDeps> = {}): BuiltDeps {
  const dispatchCalls: DispatchInput[] = [];
  const insertCalls: InsertRepairInput[] = [];
  const compensateCalls: CompensateInput[] = [];
  const logged: SelfRepairDispatchLogLine[] = [];

  const deps: SelfRepairDispatchDeps = {
    queryCandidates: over.queryCandidates ?? (async () => []),
    dispatchFn:
      over.dispatchFn ??
      (async (input: DispatchInput): Promise<DispatchResult> => {
        dispatchCalls.push(input);
        return {
          dispatchId: input.dispatchId ?? "stub-dispatch-id",
          job: {} as never,
        };
      }),
    isWorkerFault: over.isWorkerFault,
    getRepoContext: over.getRepoContext ?? (() => fakeRepo()),
    uuid: over.uuid ?? (() => "uuid-stub-1"),
    insertRepairAndFlipStatus:
      over.insertRepairAndFlipStatus ??
      (async (input: InsertRepairInput) => {
        insertCalls.push(input);
        return true;
      }),
    compensateFailedDispatch:
      over.compensateFailedDispatch ??
      (async (input: CompensateInput) => {
        compensateCalls.push(input);
      }),
    now: over.now ?? (() => FIXED_NOW),
    log: over.log ?? ((line) => logged.push(line)),
  };

  // Hijack dispatchFn so it also captures calls when caller overrode it.
  if (over.dispatchFn) {
    const original = over.dispatchFn;
    deps.dispatchFn = async (input) => {
      dispatchCalls.push(input);
      return original(input);
    };
  }

  return { deps, dispatchCalls, insertCalls, compensateCalls, logged };
}

const ctx: CronJobContext = {
  repoName: "danxbot",
  repoRoot: "/repos/danxbot",
};

describe("pickCandidate", () => {
  it("returns null when the list is empty", () => {
    expect(pickCandidate([], () => true)).toBeNull();
  });

  it("treats has_in_flight=false (no real repair row) as eligible", () => {
    // Defense against the LEFT-JOIN gotcha — an error with zero repair
    // history must NOT alias as in-flight just because the join's
    // null-padded `r.verdict` is NULL. The SQL gates on `r.id IS NOT NULL`;
    // this test pins the post-aggregation contract.
    const cs = [candidate({ max_attempt_n: 0, has_in_flight: false })];
    expect(pickCandidate(cs, () => true)?.id).toBe(1);
  });

  it("returns null when every candidate fails isWorkerFault", () => {
    const cs = [candidate({ category_key: "audit-pass:Error" })];
    expect(pickCandidate(cs, () => false)).toBeNull();
  });

  it("skips candidates with an in-flight repair", () => {
    const cs = [candidate({ has_in_flight: true })];
    expect(pickCandidate(cs, () => true)).toBeNull();
  });

  it(`skips candidates at the cap (max_attempt_n >= REPAIR_CAP=${REPAIR_CAP})`, () => {
    const cs = [candidate({ max_attempt_n: REPAIR_CAP })];
    expect(pickCandidate(cs, () => true)).toBeNull();
  });

  it("returns the first candidate that passes every filter", () => {
    const skipped = candidate({ id: 1, has_in_flight: true });
    const taken = candidate({ id: 2 });
    expect(pickCandidate([skipped, taken], () => true)?.id).toBe(2);
  });
});

describe("runSelfRepairDispatch — empty queue", () => {
  it("logs skip-empty and fires no dispatch", async () => {
    const { deps, dispatchCalls, logged } = buildDeps();
    await runSelfRepairDispatch(ctx, deps);
    expect(dispatchCalls).toEqual([]);
    expect(logged.map((l) => l.kind)).toEqual(["skip-empty"]);
  });
});

describe("runSelfRepairDispatch — filter behavior (per forbidden category)", () => {
  // One `it` per forbidden prefix — the AC explicitly forbids batch loops.
  const FORBIDDEN = [
    "audit-pass",
    "orphan-ip-heal",
    "invariant-heal",
    "audit-drift",
    "reconcile-validation",
  ];

  for (const prefix of FORBIDDEN) {
    it(`refuses to dispatch a "${prefix}" category row`, async () => {
      const categoryKey = prefix === "audit-drift" ? prefix : `${prefix}:SomeError`;
      const { deps, dispatchCalls, insertCalls, logged } = buildDeps({
        queryCandidates: async () => [candidate({ category_key: categoryKey })],
      });
      await runSelfRepairDispatch(ctx, deps);
      expect(dispatchCalls).toEqual([]);
      expect(insertCalls).toEqual([]);
      expect(logged.map((l) => l.kind)).toEqual(["skip-no-candidates"]);
    });
  }
});

describe("runSelfRepairDispatch — gating skips", () => {
  it("skips an in-flight repair (has_in_flight=true)", async () => {
    const { deps, dispatchCalls, logged } = buildDeps({
      queryCandidates: async () => [candidate({ has_in_flight: true })],
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(dispatchCalls).toEqual([]);
    expect(logged.map((l) => l.kind)).toEqual(["skip-no-candidates"]);
  });

  it("skips a row at the cap (max_attempt_n >= REPAIR_CAP)", async () => {
    const { deps, dispatchCalls } = buildDeps({
      queryCandidates: async () => [candidate({ max_attempt_n: REPAIR_CAP })],
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(dispatchCalls).toEqual([]);
  });
});

describe("runSelfRepairDispatch — happy path", () => {
  it("inserts repair row + flips status + fires ONE dispatch with the right shape", async () => {
    const { deps, dispatchCalls, insertCalls, logged } = buildDeps({
      queryCandidates: async () => [candidate({ id: 7, max_attempt_n: 1 })],
      uuid: () => "uuid-happy-1",
    });
    await runSelfRepairDispatch(ctx, deps);

    expect(insertCalls).toEqual([
      {
        errorId: 7,
        attemptN: 2,
        dispatchId: "uuid-happy-1",
        startedAt: new Date(FIXED_NOW),
      },
    ]);
    expect(dispatchCalls.length).toBe(1);
    const call = dispatchCalls[0];
    expect(call.workspace).toBe(REPAIR_WORKSPACE);
    expect(call.issueId).toBeNull();
    expect(call.dispatchId).toBe("uuid-happy-1");
    expect(call.task).toContain("Signature hash: `abc1234567890def`");
    expect(call.apiDispatchMeta.trigger).toBe("api");
    if (call.apiDispatchMeta.trigger === "api") {
      expect(call.apiDispatchMeta.metadata.endpoint).toBe(
        "/internal/self-repair-dispatch",
      );
      expect(call.apiDispatchMeta.metadata.workspace).toBe(REPAIR_WORKSPACE);
    }

    expect(logged.map((l) => l.kind)).toEqual(["dispatched"]);
    expect(logged[0]).toMatchObject({
      kind: "dispatched",
      errorId: 7,
      attemptN: 2,
      dispatchId: "uuid-happy-1",
      categoryKey: "worker-boot:DispatchSpawnError",
      repo: "danxbot",
    });
  });

  it("computes attemptN = max(prior) + 1", async () => {
    const { deps, insertCalls } = buildDeps({
      queryCandidates: async () => [candidate({ max_attempt_n: 0 })],
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(insertCalls[0].attemptN).toBe(1);
  });
});

describe("runSelfRepairDispatch — multi-candidate", () => {
  it("only fires ONE dispatch per tick even with 5 candidates", async () => {
    const { deps, dispatchCalls, insertCalls } = buildDeps({
      queryCandidates: async () => [
        candidate({ id: 1, count: 10 }),
        candidate({ id: 2, count: 9 }),
        candidate({ id: 3, count: 8 }),
        candidate({ id: 4, count: 7 }),
        candidate({ id: 5, count: 6 }),
      ],
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(dispatchCalls.length).toBe(1);
    expect(insertCalls.length).toBe(1);
    // Picks the first (count-DESC ordering preserved by the caller).
    expect(insertCalls[0].errorId).toBe(1);
  });
});

describe("runSelfRepairDispatch — error stringification", () => {
  it("stringifies a non-Error throw via String() in the spawn-failed log", async () => {
    const { deps, compensateCalls, logged } = buildDeps({
      queryCandidates: async () => [candidate({ id: 8 })],
      uuid: () => "non-error-1",
      dispatchFn: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "raw string thrown";
      },
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(compensateCalls).toEqual([
      { errorId: 8, attemptN: 1, dispatchId: "non-error-1" },
    ]);
    const spawnFailed = logged.find((l) => l.kind === "spawn-failed");
    expect(spawnFailed).toBeDefined();
    expect(
      spawnFailed && "error" in spawnFailed && spawnFailed.error,
    ).toBe("raw string thrown");
  });
});

describe("runSelfRepairDispatch — dispatch throw compensates", () => {
  it("DELETEs the repair row + reverts status when dispatch() throws", async () => {
    const { deps, compensateCalls, insertCalls, logged } = buildDeps({
      queryCandidates: async () => [candidate({ id: 9 })],
      uuid: () => "throw-1",
      dispatchFn: async () => {
        throw new Error("spawnAgent: ENOENT");
      },
    });
    await runSelfRepairDispatch(ctx, deps);

    // Repair row was inserted BEFORE dispatch — that's the contract.
    expect(insertCalls).toEqual([
      {
        errorId: 9,
        attemptN: 1,
        dispatchId: "throw-1",
        startedAt: new Date(FIXED_NOW),
      },
    ]);
    // Compensator fired with the same identity.
    expect(compensateCalls).toEqual([
      { errorId: 9, attemptN: 1, dispatchId: "throw-1" },
    ]);
    // Spawn-failed log line surfaces.
    expect(logged.map((l) => l.kind)).toContain("spawn-failed");
  });
});

describe("runSelfRepairDispatch — compensator throw is swallowed", () => {
  it("never rejects when compensateFailedDispatch itself throws", async () => {
    const { deps, logged } = buildDeps({
      queryCandidates: async () => [candidate({ id: 11 })],
      dispatchFn: async () => {
        throw new Error("spawn boom");
      },
      compensateFailedDispatch: async () => {
        throw new Error("compensator boom");
      },
    });
    await expect(runSelfRepairDispatch(ctx, deps)).resolves.toBeUndefined();
    // Outer try/catch swallows compensator throw and logs tick-error.
    const tickError = logged.find((l) => l.kind === "tick-error");
    expect(tickError).toBeDefined();
    expect(tickError && "error" in tickError && tickError.error).toContain(
      "compensator boom",
    );
  });
});

describe("runSelfRepairDispatch — race / top-level swallow", () => {
  it("logs skip-tick-error when insertRepairAndFlipStatus returns false (race)", async () => {
    const { deps, dispatchCalls, logged } = buildDeps({
      queryCandidates: async () => [candidate()],
      insertRepairAndFlipStatus: async () => false,
    });
    await runSelfRepairDispatch(ctx, deps);
    expect(dispatchCalls).toEqual([]);
    expect(logged.map((l) => l.kind)).toContain("skip-tick-error");
  });

  it("NEVER rejects even when queryCandidates throws", async () => {
    const { deps, logged } = buildDeps({
      queryCandidates: async () => {
        throw new Error("db unreachable");
      },
    });
    await expect(runSelfRepairDispatch(ctx, deps)).resolves.toBeUndefined();
    const tickError = logged.find((l) => l.kind === "tick-error");
    expect(tickError).toBeDefined();
    expect(tickError && "error" in tickError && tickError.error).toContain(
      "db unreachable",
    );
  });
});

describe("selfRepairDispatch (CronJob export)", () => {
  it("registers name + intervalSec correctly", () => {
    expect(selfRepairDispatch.name).toBe("self-repair-dispatch");
    expect(selfRepairDispatch.intervalSec).toBe(60);
  });

  it("rejects when invoked without CronJobContext", async () => {
    await expect(selfRepairDispatch.run()).rejects.toThrow(/CronJobContext/);
  });
});
