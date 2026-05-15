/**
 * Tests for `src/cron/worker-loop.ts` — DX-551.
 *
 * The worker-loop replaces the system-cron `tick.ts` dispatcher. It
 * fires the same `jobs[]` registry at startup (one-shot boot pass)
 * and then every 60s while the worker is alive, persisting per-job
 * `lastRunMs` to the same `cron-state.json` so a worker restart
 * inside an interval does not double-fire a recently-run job.
 *
 * Covers the parity-with-tick contract that DX-324 (tick.test.ts)
 * pinned — gating, throw isolation, success stamping, empty registry,
 * state persistence — plus the worker-loop-only contract:
 *
 *   - immediate first tick on `startWorkerCronLoop` (one-shot boot pass)
 *   - subsequent ticks fire every 60s under fake timers
 *   - `stop()` clears the interval (no further ticks fire)
 *   - lastRunMs gate persists across `stop` → `start` (no double-fire
 *     on worker restart inside the window)
 *   - jobs fire in registry-declaration order (sequential, not parallel)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick, startWorkerCronLoop } from "./worker-loop.js";
import { readState, writeState } from "./state.js";
import type { CronJob } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-worker-loop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeJob(opts: {
  name: string;
  intervalSec: number;
  run?: () => Promise<void>;
}): CronJob & { runs: number } {
  let runs = 0;
  const job = {
    name: opts.name,
    intervalSec: opts.intervalSec,
    run: async () => {
      runs++;
      if (opts.run) await opts.run();
    },
    get runs() {
      return runs;
    },
  } as CronJob & { runs: number };
  return job;
}

describe("runTick — parity with retired tick.ts", () => {
  it("fires a job with no prior lastRunMs on the first tick", async () => {
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({ jobs: [job], repoRoot: dir, now: 1000 });
    expect(job.runs).toBe(1);
    expect(result.fired).toEqual(["reaper"]);
  });

  it("skips a job whose lastRunMs is within intervalSec", async () => {
    writeState(dir, { reaper: 1000 });
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({
      jobs: [job],
      repoRoot: dir,
      now: 1000 + 59_999,
    });
    expect(job.runs).toBe(0);
    expect(result.skipped).toEqual(["reaper"]);
  });

  it("fires at the exact boundary — elapsed === intervalSec * 1000", async () => {
    writeState(dir, { reaper: 1000 });
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({
      jobs: [job],
      repoRoot: dir,
      now: 1000 + 60_000,
    });
    expect(result.fired).toEqual(["reaper"]);
  });

  it("isolates throws — other jobs still fire; failed lastRunMs not stamped", async () => {
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        throw new Error("boom");
      },
    });
    const b = makeJob({ name: "b", intervalSec: 60 });
    const result = await runTick({
      jobs: [a, b],
      repoRoot: dir,
      now: 1000,
    });
    expect(a.runs).toBe(1);
    expect(b.runs).toBe(1);
    expect(result.failed).toEqual([{ name: "a", error: "boom" }]);
    expect(readState(dir).a).toBeUndefined();
    expect(readState(dir).b).toBe(1000);
  });

  it("preserves unknown keys in the state file across a tick", async () => {
    writeState(dir, { legacy_job: 12345, a: 1000 });
    const a = makeJob({ name: "a", intervalSec: 60 });
    await runTick({ jobs: [a], repoRoot: dir, now: 1000 + 60_000 });
    expect(readState(dir)).toEqual({
      legacy_job: 12345,
      a: 1000 + 60_000,
    });
  });

  it("does NOT rewrite state when every job is skipped", async () => {
    writeState(dir, { reaper: 1000 });
    const { statSync } = await import("node:fs");
    const path = join(dir, ".danxbot", "cron-state.json");
    const mtimeBefore = statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const reaper = makeJob({ name: "reaper", intervalSec: 600 });
    await runTick({ jobs: [reaper], repoRoot: dir, now: 1000 + 30_000 });
    expect(statSync(path).mtimeMs).toBe(mtimeBefore);
  });

  it("is a clean no-op for an empty registry", async () => {
    const result = await runTick({ jobs: [], repoRoot: dir, now: 1000 });
    expect(result.fired).toEqual([]);
    expect(readState(dir)).toEqual({});
  });

  it("runs jobs sequentially in declaration order, not concurrently", async () => {
    let aEnd = 0;
    let bStart = 0;
    const a: CronJob = {
      name: "a",
      intervalSec: 60,
      run: async () => {
        await new Promise((r) => setTimeout(r, 20));
        aEnd = Date.now();
      },
    };
    const b: CronJob = {
      name: "b",
      intervalSec: 60,
      run: async () => {
        bStart = Date.now();
      },
    };
    await runTick({ jobs: [a, b], repoRoot: dir, now: 1000 });
    expect(bStart).toBeGreaterThanOrEqual(aEnd);
  });

  it("aborts loud when the state file is corrupt", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, ".danxbot"), { recursive: true });
    writeFileSync(
      join(dir, ".danxbot", "cron-state.json"),
      "garbage{",
      "utf-8",
    );
    const a = makeJob({ name: "a", intervalSec: 60 });
    await expect(
      runTick({ jobs: [a], repoRoot: dir, now: 1000 }),
    ).rejects.toThrow(/JSON/i);
  });
});

describe("startWorkerCronLoop — boot pass + 60s loop", () => {
  it("fires every due job once on the boot pass before returning", async () => {
    const a = makeJob({ name: "a", intervalSec: 60 });
    const b = makeJob({ name: "b", intervalSec: 60 });
    const handle = await startWorkerCronLoop({
      jobs: [a, b],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => 5000,
    });
    try {
      expect(a.runs).toBe(1);
      expect(b.runs).toBe(1);
      expect(readState(dir)).toEqual({ a: 5000, b: 5000 });
    } finally {
      handle.stop();
    }
  });

  it("fires another tick every 60s under fake timers", async () => {
    vi.useFakeTimers();
    let nowMs = 1_000_000;
    const a = makeJob({ name: "a", intervalSec: 60 });
    const handle = await startWorkerCronLoop({
      jobs: [a],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      // Boot pass ran synchronously.
      expect(a.runs).toBe(1);

      // Advance the clock 60s, advance timers, let the queued microtasks
      // drain so the awaited runTick resolves.
      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(2);

      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(3);
    } finally {
      handle.stop();
    }
  });

  it("stop() clears the interval — no further ticks fire", async () => {
    vi.useFakeTimers();
    let nowMs = 1_000_000;
    const a = makeJob({ name: "a", intervalSec: 60 });
    const handle = await startWorkerCronLoop({
      jobs: [a],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    expect(a.runs).toBe(1);

    handle.stop();

    nowMs += 600_000;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(a.runs).toBe(1);
  });

  it("does not double-fire a job on restart inside its interval window", async () => {
    // Worker A starts the loop at t=0 — a fires once and stamps t=0.
    // Worker A stops (simulating a crash inside the 60s window).
    // Worker B starts the loop at t=30s — a is still within its 60s
    // window, MUST be skipped on the boot pass.
    let nowMs = 0;
    const aFirst = makeJob({ name: "a", intervalSec: 60 });
    const first = await startWorkerCronLoop({
      jobs: [aFirst],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    expect(aFirst.runs).toBe(1);
    first.stop();

    nowMs = 30_000;
    const aSecond = makeJob({ name: "a", intervalSec: 60 });
    const second = await startWorkerCronLoop({
      jobs: [aSecond],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      expect(aSecond.runs).toBe(0);
    } finally {
      second.stop();
    }
  });

  it("respects per-job intervalSec — fast loop, slow job", async () => {
    // The loop tick is 60s. Job b has intervalSec=180 (every 3 ticks).
    // After 3 timer advances we expect b to have fired 2 times (boot + tick 3).
    vi.useFakeTimers();
    let nowMs = 0;
    const a = makeJob({ name: "a", intervalSec: 60 });
    const b = makeJob({ name: "b", intervalSec: 180 });
    const handle = await startWorkerCronLoop({
      jobs: [a, b],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      expect(a.runs).toBe(1);
      expect(b.runs).toBe(1);

      nowMs = 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(2);
      expect(b.runs).toBe(1); // not yet due

      nowMs = 120_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(3);
      expect(b.runs).toBe(1); // not yet due

      nowMs = 180_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(4);
      expect(b.runs).toBe(2); // boundary — fires
    } finally {
      handle.stop();
    }
  });

  it("isolates a per-tick job failure — the loop keeps ticking", async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let aShouldThrow = true;
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        if (aShouldThrow) throw new Error("transient");
      },
    });
    const b = makeJob({ name: "b", intervalSec: 60 });
    const handle = await startWorkerCronLoop({
      jobs: [a, b],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      expect(a.runs).toBe(1);
      expect(b.runs).toBe(1);
      // a threw — not stamped; b succeeded — stamped.
      expect(readState(dir).a).toBeUndefined();
      expect(readState(dir).b).toBe(0);

      // Recovery tick — a no longer throws.
      aShouldThrow = false;
      nowMs = 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs).toBe(2);
      expect(b.runs).toBe(2);
      expect(readState(dir).a).toBe(60_000);
    } finally {
      handle.stop();
    }
  });

  it("skips overlapping ticks — a slow job exceeding the interval does not re-enter", async () => {
    // Reentrancy guard: a job whose run() takes longer than intervalMs
    // would otherwise race with itself on the cron-state.json file.
    // The guard skips the next interval-driven tick while a prior one
    // is still in flight. The boot pass returns fast; the SECOND tick
    // is the slow one, and subsequent ticks while it hangs must skip.
    let invocations = 0;
    let releaseSlow: (() => void) | null = null;
    const slow: CronJob = {
      name: "slow",
      intervalSec: 0,
      run: async () => {
        invocations += 1;
        if (invocations === 1) return; // boot pass: fast
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      },
    };
    vi.useFakeTimers();
    let nowMs = 0;
    const handle = await startWorkerCronLoop({
      jobs: [slow],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      expect(invocations).toBe(1); // boot pass ran

      // Tick 1 — slow run starts, hangs on releaseSlow.
      nowMs = 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invocations).toBe(2);
      expect(releaseSlow).not.toBeNull();

      // Tick 2 — guard skips re-entry because tick 1 is in flight.
      nowMs = 120_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invocations).toBe(2);

      // Tick 3 — still skipped.
      nowMs = 180_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invocations).toBe(2);

      // Release the slow run. Microtasks drain so `finally` clears
      // the inFlight flag.
      releaseSlow!();
      releaseSlow = null;
      await vi.advanceTimersByTimeAsync(0);

      // Tick 4 — guard now releases; next tick fires.
      nowMs = 240_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invocations).toBe(3);
      // Release the new pending run() so teardown is clean.
      if (releaseSlow !== null) (releaseSlow as () => void)();
    } finally {
      handle.stop();
    }
  });

  it("logs but does not throw when a tick rejects (no UnhandledPromiseRejection)", async () => {
    // The setInterval callback fires runTick(); runTick() reads the
    // state file. A corrupt state file rejects. The interval handler
    // MUST swallow this so the timer keeps firing — an unhandled
    // rejection would crash the worker.
    vi.useFakeTimers();
    let nowMs = 0;
    const a = makeJob({ name: "a", intervalSec: 60 });
    const handle = await startWorkerCronLoop({
      jobs: [a],
      repoRoot: dir,
      intervalMs: 60_000,
      now: () => nowMs,
    });
    try {
      // Corrupt the state file behind the loop's back.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(dir, ".danxbot", "cron-state.json"),
        "not json",
        "utf-8",
      );
      const errSpy = vi
        .spyOn(process.stderr, "write")
        .mockReturnValue(true);

      nowMs = 60_000;
      // Should NOT throw despite the corrupt state.
      await vi.advanceTimersByTimeAsync(60_000);

      // Surfaced via stderr (matches tick.ts contract).
      const calls = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(calls).toMatch(/cron|JSON/i);
      errSpy.mockRestore();
    } finally {
      handle.stop();
    }
  });
});
