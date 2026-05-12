/**
 * Tests for `src/cron/tick.ts#runTick` — DX-324 system cron tick
 * dispatcher.
 *
 * Covers:
 *   - Due gating: a job fires when `now - lastRunMs >= intervalSec * 1000`
 *     OR when no prior `lastRunMs` is recorded.
 *   - Not-due gating: a job whose last run is within its interval is
 *     skipped.
 *   - Throw isolation: a thrown job does NOT block the rest of the
 *     registry from firing; its `lastRunMs` is NOT stamped.
 *   - Stamp-on-success: only successful runs update
 *     `state[job.name] = now`. A failed run preserves the prior
 *     value (or leaves the key absent).
 *   - State persistence: the dispatcher writes the post-tick state
 *     atomically via `writeState`.
 *   - Empty registry: a tick with zero jobs is a clean no-op (the
 *     installed-but-unused state at DX-324 completion).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick } from "./tick.js";
import { readState, writeState } from "./state.js";
import type { CronJob } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-tick-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

describe("runTick — due gating", () => {
  it("fires a job with no prior lastRunMs on the first tick", async () => {
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({ jobs: [job], repoRoot: dir, now: 1000 });
    expect(job.runs).toBe(1);
    expect(result.fired).toEqual(["reaper"]);
    expect(result.skipped).toEqual([]);
  });

  it("fires a job whose lastRunMs is older than intervalSec", async () => {
    writeState(dir, { reaper: 1000 });
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({
      jobs: [job],
      repoRoot: dir,
      now: 1000 + 60_000,
    });
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
    expect(result.fired).toEqual([]);
    expect(result.skipped).toEqual(["reaper"]);
  });

  it("fires at the exact boundary — elapsed === intervalSec * 1000", async () => {
    // The dispatcher uses `>=`; a regression to `>` would slip past
    // the 59_999 / 60_000 gap. This test pins the equality case.
    writeState(dir, { reaper: 1000 });
    const job = makeJob({ name: "reaper", intervalSec: 60 });
    const result = await runTick({
      jobs: [job],
      repoRoot: dir,
      now: 1000 + 60_000,
    });
    expect(job.runs).toBe(1);
    expect(result.fired).toEqual(["reaper"]);
  });

  it("with intervalSec=0, always fires regardless of lastRunMs", async () => {
    writeState(dir, { always: 999_999 });
    const job = makeJob({ name: "always", intervalSec: 0 });
    const result = await runTick({
      jobs: [job],
      repoRoot: dir,
      now: 999_999, // identical to lastRunMs — elapsed 0
    });
    expect(job.runs).toBe(1);
    expect(result.fired).toEqual(["always"]);
  });
});

describe("runTick — throw isolation", () => {
  it("continues firing remaining jobs when one throws", async () => {
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        throw new Error("boom");
      },
    });
    const b = makeJob({ name: "b", intervalSec: 60 });
    const c = makeJob({ name: "c", intervalSec: 60 });
    const result = await runTick({
      jobs: [a, b, c],
      repoRoot: dir,
      now: 1000,
    });
    expect(a.runs).toBe(1);
    expect(b.runs).toBe(1);
    expect(c.runs).toBe(1);
    expect(result.fired.sort()).toEqual(["b", "c"]);
    expect(result.failed).toEqual([{ name: "a", error: "boom" }]);
  });

  it("does NOT stamp lastRunMs for a failed run", async () => {
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        throw new Error("boom");
      },
    });
    await runTick({ jobs: [a], repoRoot: dir, now: 5000 });
    const state = readState(dir);
    expect(state.a).toBeUndefined();
  });

  it("preserves a prior successful lastRunMs across a later failure", async () => {
    writeState(dir, { a: 1000 });
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        throw new Error("boom");
      },
    });
    await runTick({ jobs: [a], repoRoot: dir, now: 1000 + 120_000 });
    const state = readState(dir);
    // The job tried to run (was due) and failed — the prior 1000
    // remains so the operator can see when it last succeeded.
    expect(state.a).toBe(1000);
  });
});

describe("runTick — success stamping", () => {
  it("stamps state[job.name] = now ONLY for successful runs", async () => {
    const a = makeJob({ name: "a", intervalSec: 60 });
    await runTick({ jobs: [a], repoRoot: dir, now: 5000 });
    const state = readState(dir);
    expect(state.a).toBe(5000);
  });

  it("leaves skipped jobs' prior lastRunMs untouched", async () => {
    writeState(dir, { a: 1000 });
    const a = makeJob({ name: "a", intervalSec: 600 });
    await runTick({ jobs: [a], repoRoot: dir, now: 1000 + 30_000 });
    const state = readState(dir);
    expect(state.a).toBe(1000);
  });
});

describe("runTick — empty registry", () => {
  it("is a clean no-op (DX-324 ships with zero jobs)", async () => {
    const result = await runTick({ jobs: [], repoRoot: dir, now: 1000 });
    expect(result.fired).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    // No state file written when there is nothing to record.
    expect(readState(dir)).toEqual({});
  });

  it("does NOT rewrite state when every job is skipped", async () => {
    // Pins the `fired.length > 0 || failed.length > 0` gate in
    // tick.ts: an all-skipped tick must leave the file's mtime
    // (and bytes) unchanged so the operator can `ls -la` to spot
    // a stuck dispatcher.
    writeState(dir, { reaper: 1000 });
    const path = join(dir, ".danxbot", "cron-state.json");
    const mtimeBefore = (await import("node:fs")).statSync(path).mtimeMs;
    await new Promise((r) => setTimeout(r, 10)); // mtime resolution slack
    const reaper = makeJob({ name: "reaper", intervalSec: 600 });
    await runTick({ jobs: [reaper], repoRoot: dir, now: 1000 + 30_000 });
    const mtimeAfter = (await import("node:fs")).statSync(path).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe("runTick — state persistence", () => {
  it("writes the post-tick state to .danxbot/cron-state.json", async () => {
    const a = makeJob({ name: "a", intervalSec: 60 });
    const b = makeJob({ name: "b", intervalSec: 60 });
    await runTick({ jobs: [a, b], repoRoot: dir, now: 5000 });
    const state = readState(dir);
    expect(state).toEqual({ a: 5000, b: 5000 });
  });

  it("logs job failures to stderr without halting the tick", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const a = makeJob({
      name: "a",
      intervalSec: 60,
      run: async () => {
        throw new Error("boom-message");
      },
    });
    await runTick({ jobs: [a], repoRoot: dir, now: 1000 });
    const calls = stderr.mock.calls.map((c) => String(c[0])).join("\n");
    expect(calls).toMatch(/boom-message/);
    stderr.mockRestore();
  });

  it("preserves unknown keys in the state file across a tick", async () => {
    // Forward-compat: a previously-registered job removed from the
    // registry leaves its key in the state file. Tick MUST preserve
    // it so a re-registration doesn't lose history, and so a stale
    // operator running an older release doesn't wipe the new
    // release's keys.
    writeState(dir, { legacy_job: 12345, a: 1000 });
    const a = makeJob({ name: "a", intervalSec: 60 });
    await runTick({ jobs: [a], repoRoot: dir, now: 1000 + 60_000 });
    expect(readState(dir)).toEqual({
      legacy_job: 12345,
      a: 1000 + 60_000,
    });
  });

  it("aborts loud when the state file is corrupt", async () => {
    // Corrupt state file: writeFileSync raw bytes that won't JSON.parse.
    mkdtempSync; // (no-op import marker)
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(dir, ".danxbot"), { recursive: true });
    writeFileSync(join(dir, ".danxbot", "cron-state.json"), "garbage{", "utf-8");
    const a = makeJob({ name: "a", intervalSec: 60 });
    await expect(
      runTick({ jobs: [a], repoRoot: dir, now: 1000 }),
    ).rejects.toThrow(/JSON/i);
  });

  it("runs jobs sequentially, not concurrently", async () => {
    // The `for...of await` contract means job N+1 starts only after
    // job N's promise resolves. Pin it: job A delays 30ms then
    // records its end time; job B records its start time; B's
    // start MUST be >= A's end.
    let aEnd = 0;
    let bStart = 0;
    const a = {
      name: "a",
      intervalSec: 60,
      run: async () => {
        await new Promise((r) => setTimeout(r, 30));
        aEnd = Date.now();
      },
    };
    const b = {
      name: "b",
      intervalSec: 60,
      run: async () => {
        bStart = Date.now();
      },
    };
    await runTick({ jobs: [a, b], repoRoot: dir, now: 1000 });
    expect(bStart).toBeGreaterThanOrEqual(aEnd);
  });
});
