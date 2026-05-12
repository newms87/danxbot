/**
 * Tests for `src/cron/state.ts` — DX-324 cron tick state file
 * (`<repo>/.danxbot/cron-state.json`).
 *
 * Covers:
 *   - `readState`: missing file → `{}`; round-trips a written object;
 *     malformed JSON throws.
 *   - `writeState`: atomic via temp+rename — a crash between
 *     `writeFileSync` and `renameSync` cannot leave a torn primary
 *     file on disk.
 *   - `writeState`: PID-suffixed temp path so two writers cannot
 *     collide mid-rename.
 *   - `writeState`: creates `.danxbot/` if absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState, stateFilePath } from "./state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readState", () => {
  it("returns {} when the state file is missing", () => {
    expect(readState(dir)).toEqual({});
  });

  it("returns {} when .danxbot/ does not exist", () => {
    // No mkdir — `dir` has nothing inside it yet.
    expect(readState(dir)).toEqual({});
  });

  it("round-trips a written object", () => {
    writeState(dir, { reaper: 1700000000000, gc: 1700000060000 });
    expect(readState(dir)).toEqual({
      reaper: 1700000000000,
      gc: 1700000060000,
    });
  });

  it("throws on malformed JSON instead of silently returning {}", () => {
    mkdirSync(join(dir, ".danxbot"), { recursive: true });
    writeFileSync(stateFilePath(dir), "not-json", "utf-8");
    expect(() => readState(dir)).toThrow();
  });

  it("throws when the parsed JSON is not an object", () => {
    mkdirSync(join(dir, ".danxbot"), { recursive: true });
    writeFileSync(stateFilePath(dir), "[1,2,3]", "utf-8");
    expect(() => readState(dir)).toThrow(/object/i);
  });

  it("throws when the parsed JSON is null (matches the null-guard branch)", () => {
    mkdirSync(join(dir, ".danxbot"), { recursive: true });
    writeFileSync(stateFilePath(dir), "null", "utf-8");
    expect(() => readState(dir)).toThrow(/object/i);
  });
});

describe("writeState", () => {
  it("creates .danxbot/ when missing", () => {
    expect(existsSync(join(dir, ".danxbot"))).toBe(false);
    writeState(dir, { reaper: 42 });
    expect(existsSync(stateFilePath(dir))).toBe(true);
  });

  it("uses temp+rename — no .tmp file remains on a successful write", () => {
    writeState(dir, { reaper: 42 });
    const leftovers = readdirSync(join(dir, ".danxbot")).filter((f) =>
      f.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("survives two rapid sequential writes without leaking .tmp files", async () => {
    writeState(dir, { a: 1 });
    writeState(dir, { a: 1, b: 2 });
    expect(readState(dir)).toEqual({ a: 1, b: 2 });
    const leftovers = readdirSync(join(dir, ".danxbot")).filter((f) =>
      f.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });

  it("overwrites an existing state file atomically", () => {
    writeState(dir, { reaper: 1 });
    writeState(dir, { reaper: 2, gc: 3 });
    expect(readState(dir)).toEqual({ reaper: 2, gc: 3 });
  });
});

describe("stateFilePath", () => {
  it("derives <repo>/.danxbot/cron-state.json from the repo root", () => {
    expect(stateFilePath("/abs/repo")).toBe("/abs/repo/.danxbot/cron-state.json");
  });
});
