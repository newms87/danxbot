/**
 * # Why this file avoids comparing two `processChunk`-captured timestamps to each other
 *
 * `processChunk` records the wall clock for `lastActivityAt`, `lastTextAt`,
 * and `lastThinkingAt`. `Date.now()` is NOT guaranteed monotonic — NTP
 * corrections, VM clock fixups, container time-source jitter, and GC/IO
 * stalls can move it backward between adjacent calls by hundreds of ms.
 *
 * The earlier version of `"only reads new bytes added since last poll
 * (incremental)"` asserted `lastThinkingAt > firstActivityAt`, i.e. that the
 * timestamp captured for the appended `✻` chunk was strictly later than the
 * one captured for the initial `first line\n` chunk. Under a backward wall-
 * clock jump (~250ms apart in real time), that assertion fails even though
 * the watcher behaved correctly.
 *
 * Two flake fixes on this file/test pair are NOT the same class:
 * - `956b8dc` ("[Danxbot] Fix flaky TerminalOutputWatcher stop() test") was
 *   a real source bug — `poll()` didn't recheck `this.running` after each
 *   `await`, so I/O completing post-`stop()` could mutate state. Source fix.
 * - This card (`Ajf79Lfp`) fixed both (a) a brittle test assertion and (b)
 *   the latent stall-detector exposure to non-monotonic `Date.now()`. The
 *   source change here is a defensive `Math.max` clamp in `processChunk`
 *   that makes activity timestamps strictly non-decreasing.
 *
 * The clamp solves the StallDetector exposure too: `Date.now() -
 * tw.lastActivityAt < stallThresholdMs` would compute a negative duration on
 * a backward jump (false negative — fine) and a spuriously large duration
 * across a forward jump if `lastActivityAt` was set right before the jump
 * (false positive — would falsely declare a healthy agent stalled). With
 * the clamp, both anomalies are bounded.
 *
 * Don't reach for a third "fix flaky" patch on this file. If you need to
 * assert ordering across chunks, spy on `processChunk` and inspect call
 * arguments / `mock.calls` — don't lean on wall-clock comparisons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalOutputWatcher, THINKING_CHAR } from "./terminal-output-watcher.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "terminal-output-watcher-test-"));
}

describe("TerminalOutputWatcher.processChunk", () => {
  let watcher: TerminalOutputWatcher;

  beforeEach(() => {
    watcher = new TerminalOutputWatcher("/nonexistent/path");
  });

  it("detects thinking indicator and updates lastThinkingAt + lastActivityAt", () => {
    const before = Date.now();
    watcher.processChunk(`some text ${THINKING_CHAR} more text`);
    const after = Date.now();

    expect(watcher.lastThinkingAt).toBeGreaterThanOrEqual(before);
    expect(watcher.lastThinkingAt).toBeLessThanOrEqual(after);
    expect(watcher.lastActivityAt).toBe(watcher.lastThinkingAt);
    expect(watcher.lastTextAt).toBeNull();
  });

  it("detects non-thinking text and updates lastTextAt + lastActivityAt", () => {
    const before = Date.now();
    watcher.processChunk("regular output line");
    const after = Date.now();

    expect(watcher.lastTextAt).toBeGreaterThanOrEqual(before);
    expect(watcher.lastTextAt).toBeLessThanOrEqual(after);
    expect(watcher.lastActivityAt).toBe(watcher.lastTextAt);
    expect(watcher.lastThinkingAt).toBeNull();
  });

  it("strips ANSI escape sequences before processing", () => {
    // Output with ANSI color codes wrapping text
    watcher.processChunk("\x1b[32mgreen text\x1b[0m");

    expect(watcher.lastTextAt).not.toBeNull();
    expect(watcher.lastThinkingAt).toBeNull();
  });

  it("strips ANSI codes and detects thinking char within colored output", () => {
    watcher.processChunk(`\x1b[33m${THINKING_CHAR}\x1b[0m`);

    expect(watcher.lastThinkingAt).not.toBeNull();
    expect(watcher.lastActivityAt).toBe(watcher.lastThinkingAt);
  });

  it("ignores whitespace-only chunks", () => {
    watcher.processChunk("   \n\t  ");

    expect(watcher.lastThinkingAt).toBeNull();
    expect(watcher.lastTextAt).toBeNull();
    expect(watcher.lastActivityAt).toBeNull();
  });

  it("ignores empty chunks", () => {
    watcher.processChunk("");

    expect(watcher.lastThinkingAt).toBeNull();
    expect(watcher.lastTextAt).toBeNull();
    expect(watcher.lastActivityAt).toBeNull();
  });

  it("strips cursor movement ANSI codes", () => {
    // Cursor up, erase line, etc.
    watcher.processChunk("\x1b[1A\x1b[2K");

    expect(watcher.lastThinkingAt).toBeNull();
    expect(watcher.lastTextAt).toBeNull();
    expect(watcher.lastActivityAt).toBeNull();
  });

  it("lastActivityAt matches lastThinkingAt when thinking is most recent", () => {
    watcher.processChunk("some text");
    const textAt = watcher.lastTextAt;

    watcher.processChunk(THINKING_CHAR);

    expect(watcher.lastTextAt).toBe(textAt); // text not updated again
    expect(watcher.lastThinkingAt).not.toBeNull();
    expect(watcher.lastActivityAt).toBe(watcher.lastThinkingAt);
  });

  it("clamps activity timestamps monotonically when Date.now() jumps backward (text→thinking)", () => {
    // Replicates the exact failure shape from Trello Ajf79Lfp:
    // `lastThinkingAt = 1777089404405` was 566ms before
    // `firstActivityAt = 1777089404971`. The clamp in processChunk holds
    // activity timestamps non-decreasing across a backward wall-clock jump.
    const callsBefore = (Date.now as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0;
    const dateNowSpy = vi.spyOn(Date, "now");
    // Tripwire: any unexpected Date.now() call beyond the two we plan throws,
    // catching future maintainers who add a third processChunk to this test
    // without realizing the chained mocks would silently fall through.
    dateNowSpy
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(999_434)
      .mockImplementationOnce(() => {
        throw new Error("unexpected third Date.now() call — adjust the mock chain");
      });

    watcher.processChunk("first line\n");
    watcher.processChunk(THINKING_CHAR);

    expect(watcher.lastTextAt).toBe(1_000_000);
    // The thinking call captured `Date.now() = 999_434` but was clamped to
    // the prior `lastActivityAt` (1_000_000) — strictly non-decreasing.
    expect(watcher.lastThinkingAt).toBe(1_000_000);
    expect(watcher.lastActivityAt).toBe(1_000_000);
    // Belt and suspenders: ensure exactly two Date.now() reads occurred.
    expect(dateNowSpy.mock.calls.length - callsBefore).toBe(2);
  });

  it("clamps activity timestamps monotonically when Date.now() jumps backward (thinking→text)", () => {
    // Symmetric inverse of the case above — covers the path where
    // `lastThinkingAt` is set first (later wall-clock) and a follow-up text
    // chunk arrives with an EARLIER wall-clock value. The clamp must hold
    // for both branches of `processChunk`.
    const callsBefore = (Date.now as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0;
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy
      .mockReturnValueOnce(2_000_000)
      .mockReturnValueOnce(1_999_000)
      .mockImplementationOnce(() => {
        throw new Error("unexpected third Date.now() call — adjust the mock chain");
      });

    watcher.processChunk(THINKING_CHAR);
    watcher.processChunk("regular line\n");

    expect(watcher.lastThinkingAt).toBe(2_000_000);
    // Text chunk's wall-clock was 1_999_000 (backward jump) — clamped.
    expect(watcher.lastTextAt).toBe(2_000_000);
    expect(watcher.lastActivityAt).toBe(2_000_000);
    expect(dateNowSpy.mock.calls.length - callsBefore).toBe(2);
  });
});

describe("TerminalOutputWatcher file polling", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("polls a file and updates activity timestamps from new content", async () => {
    const logPath = join(dir, "terminal.log");
    writeFileSync(logPath, "initial line\n");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    watcher.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(watcher.lastTextAt).not.toBeNull();
    } finally {
      watcher.stop();
    }
  });

  it("detects thinking char appended to file after start", async () => {
    const logPath = join(dir, "terminal.log");
    writeFileSync(logPath, "");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    watcher.start();

    try {
      // Wait for initial poll, then append thinking char
      await new Promise((resolve) => setTimeout(resolve, 100));
      appendFileSync(logPath, `${THINKING_CHAR}\n`);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(watcher.lastThinkingAt).not.toBeNull();
      expect(watcher.lastActivityAt).toBe(watcher.lastThinkingAt);
    } finally {
      watcher.stop();
    }
  });

  it("handles missing file gracefully (ENOENT)", async () => {
    const logPath = join(dir, "nonexistent.log");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    watcher.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Should not throw — ENOENT is silently ignored
      expect(watcher.lastActivityAt).toBeNull();
    } finally {
      watcher.stop();
    }
  });

  it("only reads new bytes added since last poll (incremental)", async () => {
    // Verifies the watcher reads ONLY the appended bytes on each poll — i.e.
    // `byteOffset` is tracked correctly and the second poll doesn't re-read
    // "first line\n". The verification is by inspecting the chunks passed to
    // `processChunk`, NOT by comparing wall-clock timestamps. See the
    // file-level docblock for why timestamp ordering is fragile here.
    const logPath = join(dir, "terminal.log");
    writeFileSync(logPath, "first line\n");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    const processChunkSpy = vi.spyOn(watcher, "processChunk");
    watcher.start();

    try {
      // Wait for the initial poll to read "first line\n".
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(processChunkSpy).toHaveBeenCalled();
      expect(watcher.lastTextAt).not.toBeNull();
      expect(watcher.lastThinkingAt).toBeNull();

      const callsBeforeAppend = processChunkSpy.mock.calls.length;
      const chunksBeforeAppend = processChunkSpy.mock.calls.map((c) => c[0] as string);
      // Pre-append, every chunk must be a slice of "first line\n" — no ✻ yet.
      expect(chunksBeforeAppend.every((c) => !c.includes(THINKING_CHAR))).toBe(true);

      // Append the thinking char — this should be detected as new content.
      await new Promise((resolve) => setTimeout(resolve, 100));
      appendFileSync(logPath, `${THINKING_CHAR}\n`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // A new processChunk call must have happened after the append.
      expect(processChunkSpy.mock.calls.length).toBeGreaterThan(callsBeforeAppend);
      const newChunks = processChunkSpy.mock.calls
        .slice(callsBeforeAppend)
        .map((c) => c[0] as string);

      // At least one new chunk must contain the thinking char.
      expect(newChunks.some((c) => c.includes(THINKING_CHAR))).toBe(true);
      // Crucially, no new chunk re-reads the existing "first line" content —
      // that's the "incremental" property under test. If `byteOffset` were
      // not tracked, processChunk would receive "first line\n✻\n" instead
      // of just "✻\n".
      expect(newChunks.every((c) => !c.includes("first line"))).toBe(true);

      expect(watcher.lastThinkingAt).not.toBeNull();
    } finally {
      watcher.stop();
    }
  });

  it("stop() prevents further polling", async () => {
    const logPath = join(dir, "terminal.log");
    writeFileSync(logPath, "");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    watcher.start();
    watcher.stop();

    appendFileSync(logPath, "new content after stop\n");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // May have seen the initial empty file, but not the new content
    expect(watcher.lastTextAt).toBeNull();
    expect(watcher.lastThinkingAt).toBeNull();
  });
});
