/**
 * Tests for {@link getSelfRepairThreshold} +
 * {@link ensureSelfRepairDisplayMirror} — DX-563.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSelfRepairThreshold,
  ensureSelfRepairDisplayMirror,
} from "./settings.js";
import { _resetForTesting } from "../settings-file.js";
import { DEFAULT_SELF_REPAIR_THRESHOLD } from "../settings-file.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "self-repair-settings-"));
  mkdirSync(join(dir, ".danxbot"), { recursive: true });
  return dir;
}

function writeJson(repoLocalPath: string, content: object): void {
  writeFileSync(
    join(repoLocalPath, ".danxbot", "settings.json"),
    JSON.stringify(content, null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  _resetForTesting();
});

describe("getSelfRepairThreshold", () => {
  it("returns DEFAULT_SELF_REPAIR_THRESHOLD when settings file is missing", () => {
    const repo = makeRepo();
    expect(getSelfRepairThreshold(repo)).toBe(DEFAULT_SELF_REPAIR_THRESHOLD);
  });

  it("returns the configured threshold when present", () => {
    const repo = makeRepo();
    writeJson(repo, { selfRepair: { threshold: 7 } });
    expect(getSelfRepairThreshold(repo)).toBe(7);
  });

  it("falls back to default when threshold is invalid (zero, negative, NaN, non-number)", () => {
    const repo = makeRepo();
    writeJson(repo, { selfRepair: { threshold: 0 } });
    expect(getSelfRepairThreshold(repo)).toBe(DEFAULT_SELF_REPAIR_THRESHOLD);
    writeJson(repo, { selfRepair: { threshold: -1 } });
    expect(getSelfRepairThreshold(repo)).toBe(DEFAULT_SELF_REPAIR_THRESHOLD);
    writeJson(repo, { selfRepair: { threshold: "five" } });
    expect(getSelfRepairThreshold(repo)).toBe(DEFAULT_SELF_REPAIR_THRESHOLD);
  });

  it("floors fractional thresholds", () => {
    const repo = makeRepo();
    writeJson(repo, { selfRepair: { threshold: 4.9 } });
    expect(getSelfRepairThreshold(repo)).toBe(4);
  });
});

describe("ensureSelfRepairDisplayMirror", () => {
  it("creates display.selfRepair when missing", async () => {
    const repo = makeRepo();
    writeJson(repo, { selfRepair: { threshold: 4 } });
    await ensureSelfRepairDisplayMirror(repo);
    const raw = JSON.parse(
      readFileSync(join(repo, ".danxbot", "settings.json"), "utf-8"),
    );
    expect(raw.display.selfRepair).toEqual({ threshold: 4 });
  });

  it("updates display.selfRepair when threshold changes", async () => {
    const repo = makeRepo();
    writeJson(repo, {
      selfRepair: { threshold: 9 },
      display: { selfRepair: { threshold: 3 } },
    });
    await ensureSelfRepairDisplayMirror(repo);
    const raw = JSON.parse(
      readFileSync(join(repo, ".danxbot", "settings.json"), "utf-8"),
    );
    expect(raw.display.selfRepair).toEqual({ threshold: 9 });
  });

  it("uses default when no selfRepair block configured", async () => {
    const repo = makeRepo();
    writeJson(repo, {});
    await ensureSelfRepairDisplayMirror(repo);
    const raw = JSON.parse(
      readFileSync(join(repo, ".danxbot", "settings.json"), "utf-8"),
    );
    expect(raw.display.selfRepair).toEqual({
      threshold: DEFAULT_SELF_REPAIR_THRESHOLD,
    });
  });
});
