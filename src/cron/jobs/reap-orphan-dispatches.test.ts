/**
 * Unit tests for `reap-orphan-dispatches.ts` — DX-327 Phase 4.
 *
 * Every dependency is injected (scope listing, DB query, reap action,
 * clock, logger, env check). No real systemctl call, no real DB
 * connection, no real wall-clock. The job is a pure orchestrator + a
 * thin set of fail-loud guards; the tests pin both halves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reapOrphanDispatches,
  runReapOrphanDispatches,
  SCOPE_AGE_THRESHOLD_MS,
  type ReapDeps,
} from "./reap-orphan-dispatches.js";
import type { DispatchScopeUnit } from "../scope-list.js";
import { runTick } from "../tick.js";
import type { CronJob } from "../types.js";

const ENV_KEYS = ["DANXBOT_DB_USER", "DANXBOT_DB_PASSWORD"];

// Snapshot the inherited env once at module load so every test can restore
// from a known baseline. Without this, mid-test deletes leak the missing-key
// state into later test files in the same Vitest run.
const ENV_BASELINE: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

function withEnv(): void {
  for (const k of ENV_KEYS) process.env[k] = "test-value";
}

function clearEnv(keys: string[]): void {
  for (const k of keys) delete process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const original = ENV_BASELINE[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
}

afterEach(() => restoreEnv());

function fixedNow(): number {
  return Date.UTC(2026, 4, 12, 23, 50, 0);
}

function scope(
  dispatchId: string,
  ageMs: number,
  now: number = fixedNow(),
): DispatchScopeUnit {
  return {
    unit: `danxbot-dispatch-${dispatchId}.scope`,
    dispatchId,
    activeEnterEpochMs: now - ageMs,
  };
}

interface BuiltDeps extends Required<Omit<ReapDeps, "exec">> {
  reapCalls: string[];
  loggedLines: Array<Record<string, unknown>>;
}

function buildDeps(over: Partial<ReapDeps> = {}): BuiltDeps {
  const reapCalls: string[] = [];
  const loggedLines: Array<Record<string, unknown>> = [];
  return {
    listScopes: over.listScopes ?? (async () => []),
    queryDispatches: over.queryDispatches ?? (async () => []),
    reap:
      over.reap ??
      (async (unit) => {
        reapCalls.push(unit);
      }),
    now: over.now ?? fixedNow,
    log:
      over.log ??
      ((line) => {
        // ReapLogLine has no string index signature, so widen via
        // `unknown` to satisfy TS while keeping the observable
        // shape preserved for the test assertions.
        loggedLines.push(line as unknown as Record<string, unknown>);
      }),
    reapCalls,
    loggedLines,
  };
}

describe("runReapOrphanDispatches — env gate", () => {
  beforeEach(() => withEnv());

  it("throws when DANXBOT_DB_USER is missing", async () => {
    clearEnv(["DANXBOT_DB_USER"]);
    await expect(runReapOrphanDispatches(buildDeps())).rejects.toThrow(
      /DANXBOT_DB_USER/,
    );
  });

  it("throws when DANXBOT_DB_PASSWORD is missing", async () => {
    clearEnv(["DANXBOT_DB_PASSWORD"]);
    await expect(runReapOrphanDispatches(buildDeps())).rejects.toThrow(
      /DANXBOT_DB_PASSWORD/,
    );
  });

  it("names ALL missing vars in a single throw", async () => {
    clearEnv(ENV_KEYS);
    await expect(runReapOrphanDispatches(buildDeps())).rejects.toThrow(
      /DANXBOT_DB_USER.*DANXBOT_DB_PASSWORD|DANXBOT_DB_PASSWORD.*DANXBOT_DB_USER/,
    );
  });
});

describe("runReapOrphanDispatches — reap decisions", () => {
  beforeEach(() => withEnv());

  it("is a no-op when no scopes are live", async () => {
    const deps = buildDeps({ listScopes: async () => [] });
    await runReapOrphanDispatches(deps);
    expect(deps.reapCalls).toEqual([]);
    expect(deps.loggedLines).toEqual([]);
  });

  it("never reaps a live dispatch (status=running, DB row present)", async () => {
    const live = scope("live-1", 5 * 60_000);
    const deps = buildDeps({
      listScopes: async () => [live],
      queryDispatches: async () => [{ id: "live-1", status: "running" }],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([]);
    expect(deps.loggedLines).toEqual([]);
  });

  it("reaps when the DB row is terminal (status=failed)", async () => {
    const orphan = scope("orphan-1", 5 * 60_000);
    const deps = buildDeps({
      listScopes: async () => [orphan],
      queryDispatches: async () => [{ id: "orphan-1", status: "failed" }],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([orphan.unit]);
    expect(deps.loggedLines).toEqual([
      {
        name: "reap-orphan-dispatches",
        dispatchId: "orphan-1",
        unit: orphan.unit,
        reason: "terminal-row",
        killedAtIso: new Date(fixedNow()).toISOString(),
      },
    ]);
  });

  it("reaps for every terminal status (completed/failed/cancelled/recovered/throttled)", async () => {
    const scopes = [
      scope("a", 5 * 60_000),
      scope("b", 5 * 60_000),
      scope("c", 5 * 60_000),
      scope("d", 5 * 60_000),
      scope("e", 5 * 60_000),
    ];
    const deps = buildDeps({
      listScopes: async () => scopes,
      queryDispatches: async () => [
        { id: "a", status: "completed" },
        { id: "b", status: "failed" },
        { id: "c", status: "cancelled" },
        { id: "d", status: "recovered" },
        { id: "e", status: "throttled" },
      ],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls.sort()).toEqual(
      scopes.map((s) => s.unit).sort(),
    );
  });

  it("reaps when the DB row is missing", async () => {
    const orphan = scope("ghost", 5 * 60_000);
    const deps = buildDeps({
      listScopes: async () => [orphan],
      queryDispatches: async () => [],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([orphan.unit]);
    expect(deps.loggedLines).toEqual([
      {
        name: "reap-orphan-dispatches",
        dispatchId: "ghost",
        unit: orphan.unit,
        reason: "missing-row",
        killedAtIso: new Date(fixedNow()).toISOString(),
      },
    ]);
  });

  it("never reaps a fresh scope (age < 60s) even when DB row missing", async () => {
    const fresh = scope("just-spawned", SCOPE_AGE_THRESHOLD_MS - 1);
    let queried = false;
    const deps = buildDeps({
      listScopes: async () => [fresh],
      queryDispatches: async () => {
        queried = true;
        return [];
      },
    });

    await runReapOrphanDispatches(deps);

    expect(queried).toBe(false);
    expect(deps.reapCalls).toEqual([]);
  });

  it("reaps a scope exactly 60_001ms old (age threshold is strictly >)", async () => {
    const justOver = scope("just-over", SCOPE_AGE_THRESHOLD_MS + 1);
    const deps = buildDeps({
      listScopes: async () => [justOver],
      queryDispatches: async () => [],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([justOver.unit]);
  });

  it("never reaps a scope exactly at the threshold (age = 60_000ms)", async () => {
    const atThreshold = scope("at-threshold", SCOPE_AGE_THRESHOLD_MS);
    const deps = buildDeps({
      listScopes: async () => [atThreshold],
      queryDispatches: async () => [],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([]);
  });

  it("queries only the age-eligible dispatch ids", async () => {
    const fresh = scope("fresh", 30_000);
    const old = scope("old", 5 * 60_000);
    const queried: string[][] = [];
    const deps = buildDeps({
      listScopes: async () => [fresh, old],
      queryDispatches: async (ids) => {
        queried.push([...ids]);
        return [];
      },
    });

    await runReapOrphanDispatches(deps);

    expect(queried).toEqual([["old"]]);
    expect(deps.reapCalls).toEqual([old.unit]);
  });

  it("logs an error line when the reap action itself throws, and proceeds to the next scope", async () => {
    const broken = scope("kaboom", 5 * 60_000);
    const ok = scope("ok", 5 * 60_000);
    const reapAttempted: string[] = [];
    const deps = buildDeps({
      listScopes: async () => [broken, ok],
      queryDispatches: async () => [],
      reap: async (unit) => {
        reapAttempted.push(unit);
        if (unit === broken.unit) throw new Error("permission denied");
      },
    });

    await runReapOrphanDispatches(deps);

    expect(reapAttempted).toEqual([broken.unit, ok.unit]);
    const errLine = deps.loggedLines.find(
      (l) => l.dispatchId === "kaboom",
    );
    expect(errLine?.error).toMatch(/permission denied/);
    expect(errLine?.killedAtIso).toBeUndefined();

    const okLine = deps.loggedLines.find((l) => l.dispatchId === "ok");
    expect(okLine?.reason).toBe("missing-row");
    expect(okLine?.error).toBeUndefined();
  });

  it("treats clock skew (now < activeEnterEpochMs) as not-yet-eligible", async () => {
    const future = scope("from-future", -1_000);
    const deps = buildDeps({
      listScopes: async () => [future],
      queryDispatches: async () => [],
    });

    await runReapOrphanDispatches(deps);

    expect(deps.reapCalls).toEqual([]);
    expect(deps.loggedLines).toEqual([]);
  });
});

describe("reapOrphanDispatches export shape", () => {
  it("declares the name + intervalSec the cron tick gates on", () => {
    expect(reapOrphanDispatches.name).toBe("reap-orphan-dispatches");
    expect(reapOrphanDispatches.intervalSec).toBe(60);
  });

  it("default run() binding still fail-loud on missing env (no swallow)", async () => {
    clearEnv(ENV_KEYS);
    await expect(reapOrphanDispatches.run()).rejects.toThrow(/DANXBOT_DB_/);
  });
});

describe("integration with runTick — spawn scope → mark row failed → tick → scope killed", () => {
  let dir: string;

  beforeEach(() => {
    withEnv();
    dir = mkdtempSync(join(tmpdir(), "reap-integ-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("kills a scope on the next tick once its DB row is marked failed and age > 60s", async () => {
    const orphan = scope("integ-orphan", 5 * 60_000);
    const reapedUnits: string[] = [];

    const wrappedJob: CronJob = {
      name: reapOrphanDispatches.name,
      intervalSec: reapOrphanDispatches.intervalSec,
      run: () =>
        runReapOrphanDispatches({
          listScopes: async () => [orphan],
          queryDispatches: async () => [
            { id: "integ-orphan", status: "failed" },
          ],
          reap: async (unit) => {
            reapedUnits.push(unit);
          },
          now: fixedNow,
          log: () => {},
        }),
    };

    const result = await runTick({
      jobs: [wrappedJob],
      repoRoot: dir,
      now: fixedNow(),
    });

    expect(result.fired).toEqual([reapOrphanDispatches.name]);
    expect(result.failed).toEqual([]);
    expect(reapedUnits).toEqual([orphan.unit]);
  });

  it("preserves stamp-on-success contract — second tick within interval skips the job", async () => {
    const wrappedJob: CronJob = {
      name: reapOrphanDispatches.name,
      intervalSec: reapOrphanDispatches.intervalSec,
      run: () =>
        runReapOrphanDispatches({
          listScopes: async () => [],
          now: fixedNow,
          log: () => {},
        }),
    };

    const first = await runTick({
      jobs: [wrappedJob],
      repoRoot: dir,
      now: fixedNow(),
    });
    expect(first.fired).toEqual([reapOrphanDispatches.name]);

    const second = await runTick({
      jobs: [wrappedJob],
      repoRoot: dir,
      now: fixedNow() + 30_000,
    });
    expect(second.fired).toEqual([]);
    expect(second.skipped).toEqual([reapOrphanDispatches.name]);
  });
});

describe("default reap path — wraps systemctl --user stop <unit>", () => {
  it("invokes execFile('systemctl', ['--user', 'stop', <unit>])", async () => {
    // We can't exercise the real systemctl in CI, but the default reap
    // function is exported so we can pin its argv shape via the exec
    // dependency injection.
    withEnv();
    const calls: string[][] = [];
    const exec = vi.fn(async (cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: "", stderr: "" };
    });

    const orphan = scope("call-me", 5 * 60_000);
    await runReapOrphanDispatches({
      listScopes: async () => [orphan],
      queryDispatches: async () => [],
      exec,
      now: fixedNow,
      log: () => {},
    });

    expect(calls).toEqual([
      ["systemctl", "--user", "stop", orphan.unit],
    ]);
  });
});
