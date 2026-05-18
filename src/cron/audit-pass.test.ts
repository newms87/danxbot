/**
 * Tests for `runAuditPass` — DX-220 Phase 5 audit reconcile sweep.
 *
 * Covers:
 *   - happy path: every open YAML reconciled with trigger "audit", no
 *     drift recorded when `result.changed === false`.
 *   - drift detection: `result.changed === true` records a
 *     `recordSystemError({source: "audit-drift"})` per drifted card.
 *   - per-card failure isolation: one reconcile throw is logged + the
 *     scan continues; the throwing card surfaces in `errors[]`.
 *   - filesystem edge cases: missing open dir, readdir failure, .gitkeep
 *     and stray dirs ignored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import type { RepoContext } from "../types.js";

const reconcileMock = vi.hoisted(() => vi.fn());
const recordSystemErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../issue/reconcile.js", () => ({
  reconcileIssue: reconcileMock,
}));
vi.mock("../dashboard/system-errors.js", () => ({
  recordSystemError: recordSystemErrorMock,
}));

import { runAuditPass } from "./audit-pass.js";

function makeRepo(localPath: string): RepoContext {
  return {
    name: "test-repo",
    url: "",
    localPath,
    hostPath: localPath,
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
      blockedLabelId: "",
      requiresHumanLabelId: "",
    },
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: { host: "", port: 0, user: "", password: "", database: "", enabled: false },
    githubToken: "",
    trelloEnabled: false,
    workerPort: 0,
    issuePrefix: "DX",
  };
}

function makeReconcileResult(changed: boolean): {
  changed: boolean;
  prevHash: string | null;
  nextHash: string;
  errors: never[];
  fanout: {
    parentId: null;
    dependents: never[];
    dispatchableChanged: boolean;
  };
} {
  return {
    changed,
    prevHash: changed ? "old-hash" : "same-hash",
    nextHash: "new-hash",
    errors: [],
    fanout: { parentId: null, dependents: [], dispatchableChanged: false },
  };
}

describe("runAuditPass", () => {
  let tmpRoot: string;
  let openDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = mkdtempSync(resolve(tmpdir(), "audit-pass-"));
    openDir = resolve(tmpRoot, ".danxbot", "issues", "open");
    mkdirSync(openDir, { recursive: true });
  });

  it("walks every open YAML and calls reconcileIssue with trigger 'audit'", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, "DX-2.yml"), "");
    reconcileMock.mockResolvedValue(makeReconcileResult(false));

    const result = await runAuditPass(makeRepo(tmpRoot));

    expect(result.scanned).toBe(2);
    expect(result.drifted).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(reconcileMock).toHaveBeenCalledTimes(2);
    const triggers = reconcileMock.mock.calls.map((c) => c[2]);
    expect(triggers).toEqual(["audit", "audit"]);
  });

  it("records `audit-drift` system error per drifted card (changed: true)", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, "DX-2.yml"), "");
    reconcileMock
      .mockResolvedValueOnce(makeReconcileResult(true))
      .mockResolvedValueOnce(makeReconcileResult(false));

    const result = await runAuditPass(makeRepo(tmpRoot));

    expect(result.drifted).toEqual(["DX-1"]);
    expect(recordSystemErrorMock).toHaveBeenCalledTimes(1);
    const call = recordSystemErrorMock.mock.calls[0][0];
    expect(call.source).toBe("audit-drift");
    expect(call.severity).toBe("warn");
    expect(call.repo).toBe("test-repo");
    expect(call.message).toContain("DX-1");
    expect(call.details).toMatchObject({
      prevHash: "old-hash",
      nextHash: "new-hash",
    });
  });

  it("isolates per-card reconcile throws — logs + continues", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, "DX-2.yml"), "");
    writeFileSync(resolve(openDir, "DX-3.yml"), "");
    reconcileMock
      .mockResolvedValueOnce(makeReconcileResult(false))
      .mockRejectedValueOnce(new Error("reconcile crashed"))
      .mockResolvedValueOnce(makeReconcileResult(false));

    const result = await runAuditPass(makeRepo(tmpRoot));

    expect(result.scanned).toBe(3);
    expect(result.errors).toEqual(["DX-2"]);
    // Subsequent reconciles still ran — the rejection did not abort the loop.
    expect(reconcileMock).toHaveBeenCalledTimes(3);
    // No drift error recorded for the throwing card (only changed: true triggers it).
    expect(recordSystemErrorMock).not.toHaveBeenCalled();
  });

  it("skips non-.yml entries (.gitkeep, stray dirs)", async () => {
    writeFileSync(resolve(openDir, "DX-1.yml"), "");
    writeFileSync(resolve(openDir, ".gitkeep"), "");
    mkdirSync(resolve(openDir, "subdir"));
    reconcileMock.mockResolvedValue(makeReconcileResult(false));

    const result = await runAuditPass(makeRepo(tmpRoot));

    expect(result.scanned).toBe(1);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.calls[0][1]).toBe("DX-1");
  });

  it("returns empty result when open dir is missing (no throw)", async () => {
    rmSync(openDir, { recursive: true, force: true });

    const result = await runAuditPass(makeRepo(tmpRoot));

    expect(result).toEqual({ scanned: 0, drifted: [], errors: [] });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("handles readdir failure best-effort", async () => {
    // Strip read perms — readdirSync throws EACCES. Tolerated.
    chmodSync(openDir, 0o000);
    try {
      const result = await runAuditPass(makeRepo(tmpRoot));
      expect(result).toEqual({ scanned: 0, drifted: [], errors: [] });
    } finally {
      chmodSync(openDir, 0o755);
    }
  });

  it("yields between batches — DX-634 (drains macrotask queue to avoid pg-pool 15s timeout regression)", async () => {
    // 100 mocked YAMLs, default concurrency=4 → floor(100/4) = 25 yields.
    // The pre-DX-634 sync for-await loop never reached setImmediate; this
    // test pins the new contract so a future regression that drops the
    // yield surfaces here.
    const N = 100;
    for (let i = 1; i <= N; i++) {
      writeFileSync(resolve(openDir, `DX-${i}.yml`), "");
    }
    reconcileMock.mockResolvedValue(makeReconcileResult(false));

    const originalSetImmediate = global.setImmediate;
    let setImmediateCalls = 0;
    const spy = vi
      .spyOn(global, "setImmediate")
      .mockImplementation(((cb: (...args: unknown[]) => void, ...args: unknown[]) => {
        setImmediateCalls++;
        return originalSetImmediate(cb as never, ...(args as never[]));
      }) as typeof setImmediate);
    try {
      const result = await runAuditPass(makeRepo(tmpRoot));
      expect(result.scanned).toBe(N);
    } finally {
      spy.mockRestore();
    }
    // Default concurrency = 4, yieldEveryN = 4 → floor(100 / 4) = 25.
    // Allow slack for any setImmediate scheduled by surrounding code; the
    // contract is "at least floor(N / yieldEveryN)".
    expect(setImmediateCalls).toBeGreaterThanOrEqual(Math.floor(N / 4));
  });
});
