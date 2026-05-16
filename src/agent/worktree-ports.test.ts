/**
 * Worktree port-registry unit tests.
 *
 * Covers allocation (existing surface) AND release (new surface for
 * symmetric teardown — without it, deleting an agent leaks its offset
 * forever and bootstrap rollback on a failed create leaves the offset
 * registered to an agent whose settings record was rolled back).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PORT_BASES,
  MAX_OFFSET,
  allocateOffset,
  derivePortOverrides,
  freeOffset,
  provisionWorktreePorts,
  readRegistry,
  registryPath,
  releaseWorktreePorts,
  writeRegistry,
  WorktreePortError,
  type PortRegistry,
} from "./worktree-ports.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "worktree-ports-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("allocateOffset", () => {
  it("returns existing offset for a known worktree without mutating", () => {
    const reg: PortRegistry = { offsets: { harry: 2 } };
    const got = allocateOffset(reg, "harry");
    expect(got).toBe(2);
    expect(reg.offsets).toEqual({ harry: 2 });
  });

  it("picks the smallest unused offset starting at 1 for an empty registry", () => {
    const reg: PortRegistry = { offsets: {} };
    expect(allocateOffset(reg, "buildy")).toBe(1);
    expect(allocateOffset(reg, "harry")).toBe(2);
    expect(allocateOffset(reg, "sage")).toBe(3);
  });

  it("fills the smallest gap left by a freed offset before reaching for new", () => {
    const reg: PortRegistry = { offsets: { buildy: 1, harry: 2, sage: 3 } };
    delete reg.offsets.harry; // freed
    expect(allocateOffset(reg, "newman")).toBe(2);
  });

  it("throws WorktreePortError when every offset 1..MAX is taken", () => {
    const offsets: Record<string, number> = {};
    for (let i = 1; i <= MAX_OFFSET; i += 1) {
      offsets[`a${i}`] = i;
    }
    const reg: PortRegistry = { offsets };
    expect(() => allocateOffset(reg, "overflow")).toThrow(WorktreePortError);
  });
});

describe("derivePortOverrides", () => {
  it("computes base + offset for every port family", () => {
    const out = derivePortOverrides(3);
    expect(out.APP_PORT).toBe(String(PORT_BASES.APP_PORT + 3));
    expect(out.FORWARD_DB_PORT).toBe(String(PORT_BASES.FORWARD_DB_PORT + 3));
    expect(out.FORWARD_REDIS_PORT).toBe(String(PORT_BASES.FORWARD_REDIS_PORT + 3));
    expect(out.VITE_PORT).toBe(String(PORT_BASES.VITE_PORT + 3));
  });

  it("rejects out-of-range offsets", () => {
    expect(() => derivePortOverrides(0)).toThrow(WorktreePortError);
    expect(() => derivePortOverrides(MAX_OFFSET + 1)).toThrow(WorktreePortError);
    expect(() => derivePortOverrides(1.5)).toThrow(WorktreePortError);
  });
});

describe("provisionWorktreePorts (file round-trip)", () => {
  it("persists the registry on first allocation, reuses on second", () => {
    const first = provisionWorktreePorts(repoRoot, "buildy");
    expect(first.APP_PORT).toBe(String(PORT_BASES.APP_PORT + 1));
    expect(existsSync(registryPath(repoRoot))).toBe(true);

    // Second call MUST return the same ports — no re-allocation, no
    // disk churn.
    const second = provisionWorktreePorts(repoRoot, "buildy");
    expect(second).toEqual(first);
  });

  it("assigns distinct offsets to distinct worktrees on the same repo", () => {
    const a = provisionWorktreePorts(repoRoot, "buildy");
    const b = provisionWorktreePorts(repoRoot, "harry");
    expect(a.APP_PORT).not.toEqual(b.APP_PORT);
    expect(a.FORWARD_DB_PORT).not.toEqual(b.FORWARD_DB_PORT);
  });
});

describe("freeOffset (RED — symmetric inverse of allocateOffset)", () => {
  it("removes an existing entry and returns true", () => {
    const reg: PortRegistry = { offsets: { buildy: 1, harry: 2 } };
    const freed = freeOffset(reg, "harry");
    expect(freed).toBe(true);
    expect(reg.offsets).toEqual({ buildy: 1 });
  });

  it("returns false when the name is not registered (idempotent rollback)", () => {
    const reg: PortRegistry = { offsets: { buildy: 1 } };
    const freed = freeOffset(reg, "ghost");
    expect(freed).toBe(false);
    expect(reg.offsets).toEqual({ buildy: 1 });
  });

  it("does not touch other entries", () => {
    const reg: PortRegistry = { offsets: { a: 1, b: 2, c: 3 } };
    freeOffset(reg, "b");
    expect(reg.offsets).toEqual({ a: 1, c: 3 });
  });
});

describe("releaseWorktreePorts (RED — file-round-trip release)", () => {
  it("removes the worktree from the on-disk registry", () => {
    provisionWorktreePorts(repoRoot, "buildy");
    provisionWorktreePorts(repoRoot, "harry");
    expect(readRegistry(repoRoot).offsets).toEqual({ buildy: 1, harry: 2 });

    const result = releaseWorktreePorts(repoRoot, "harry");
    expect(result).toBe(true);
    expect(readRegistry(repoRoot).offsets).toEqual({ buildy: 1 });
  });

  it("is idempotent on unknown name — returns false, no error", () => {
    provisionWorktreePorts(repoRoot, "buildy");
    const result = releaseWorktreePorts(repoRoot, "ghost");
    expect(result).toBe(false);
    expect(readRegistry(repoRoot).offsets).toEqual({ buildy: 1 });
  });

  it("is idempotent when the registry file does not exist yet", () => {
    // Fresh repoRoot — no registry file yet (no prior allocation).
    expect(existsSync(registryPath(repoRoot))).toBe(false);
    const result = releaseWorktreePorts(repoRoot, "anybody");
    expect(result).toBe(false);
    // Should NOT have created an empty registry file as a side effect.
    expect(existsSync(registryPath(repoRoot))).toBe(false);
  });

  it("frees the offset so the next provision reuses the gap", () => {
    provisionWorktreePorts(repoRoot, "buildy"); // 1
    provisionWorktreePorts(repoRoot, "harry"); // 2
    provisionWorktreePorts(repoRoot, "sage"); // 3
    releaseWorktreePorts(repoRoot, "harry"); // frees 2
    const newman = provisionWorktreePorts(repoRoot, "newman");
    expect(newman.APP_PORT).toBe(String(PORT_BASES.APP_PORT + 2));
  });

  it("writes valid JSON the reader can round-trip", () => {
    provisionWorktreePorts(repoRoot, "buildy");
    provisionWorktreePorts(repoRoot, "harry");
    releaseWorktreePorts(repoRoot, "buildy");
    const raw = readFileSync(registryPath(repoRoot), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ offsets: { harry: 2 } });
    // Ends in a newline (matches writeRegistry's contract).
    expect(raw.endsWith("\n")).toBe(true);
  });
});
