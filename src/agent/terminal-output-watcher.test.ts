import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    const logPath = join(dir, "terminal.log");
    writeFileSync(logPath, "first line\n");

    const watcher = new TerminalOutputWatcher(logPath, 50);
    watcher.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const firstActivityAt = watcher.lastActivityAt;
      expect(firstActivityAt).not.toBeNull();

      // Append thinking char — should be detected as new content
      await new Promise((resolve) => setTimeout(resolve, 100));
      appendFileSync(logPath, `${THINKING_CHAR}\n`);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(watcher.lastThinkingAt).not.toBeNull();
      expect(watcher.lastThinkingAt).toBeGreaterThan(firstActivityAt!);
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
