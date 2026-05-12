/**
 * Unit tests for the worker-boot self-heal pass that re-provisions
 * `<worktree>/node_modules` (DX-242) and `<worktree>/.env` (DX-244)
 * for every agent declared in `settings.json`.
 *
 * Tests use real tmpdirs so the `readSettings` IO path runs unchanged,
 * but the worktree manager itself is a hand-rolled stub so we can
 * inject deterministic per-agent outcomes (success / failure /
 * absent-worktree) without a real `git worktree add`. The boot module
 * is meant to be a thin orchestrator — most of the per-agent logic
 * lives in `worktree-manager.ts` and is covered by its own suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureWorktreesProvisioned } from "./ensure-worktrees-provisioned.js";
import { WorktreeError, type WorktreeManager } from "./worktree-manager.js";
import * as systemErrorsModule from "../dashboard/system-errors.js";

interface StubManagerOptions {
  /** Per-agent outcomes — agent name -> "ok" | Error to throw. */
  outcomes: Record<string, "ok" | Error>;
}

function stubManager(opts: StubManagerOptions): {
  manager: WorktreeManager;
  calls: string[];
} {
  const calls: string[] = [];
  const manager: WorktreeManager = {
    worktreePath: () => "/unused",
    bootstrap: async () => {},
    teardown: async () => {},
    syncWorktree: async () => ({ kind: "noop" }),
    fetchOrigin: async () => true,
    async ensureProvisioned(_ctx, agentName) {
      calls.push(agentName);
      const outcome = opts.outcomes[agentName];
      if (outcome instanceof Error) {
        throw outcome;
      }
      // "ok" — return cleanly.
    },
  };
  return { manager, calls };
}

function writeAgents(localPath: string, agents: Record<string, unknown>): void {
  const settings = {
    overrides: {},
    display: {},
    agents,
  };
  mkdirSync(join(localPath, ".danxbot"), { recursive: true });
  writeFileSync(
    join(localPath, ".danxbot", "settings.json"),
    JSON.stringify(settings, null, 2),
  );
}

function makeAgentRecord(): Record<string, unknown> {
  return {
    type: "agent",
    bio: "",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      mon: ["00:00-23:59"],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
  };
}

describe("ensureWorktreesProvisioned (DX-242)", () => {
  let localPath: string;
  let recordSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localPath = mkdtempSync(join(tmpdir(), "danxbot-ensure-"));
    recordSpy = vi.spyOn(systemErrorsModule, "recordSystemError");
  });

  afterEach(() => {
    rmSync(localPath, { recursive: true, force: true });
    recordSpy.mockRestore();
  });

  function ctx(): { name: string; localPath: string; hostPath: string } {
    return { name: "danxbot", localPath, hostPath: localPath };
  }

  it("returns scanned: 0 when settings.json has no agents block", async () => {
    // No file written — readSettings returns the default empty shape.
    const { manager, calls } = stubManager({ outcomes: {} });
    const result = await ensureWorktreesProvisioned(ctx(), manager);
    expect(result).toEqual({ scanned: 0, provisioned: [], failed: [] });
    expect(calls).toEqual([]);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("provisions every agent and records no system error on full success", async () => {
    writeAgents(localPath, {
      alice: makeAgentRecord(),
      bob: makeAgentRecord(),
    });
    const { manager, calls } = stubManager({
      outcomes: { alice: "ok", bob: "ok" },
    });
    const result = await ensureWorktreesProvisioned(ctx(), manager);
    expect(result.scanned).toBe(2);
    expect(result.provisioned.sort()).toEqual(["alice", "bob"]);
    expect(result.failed).toEqual([]);
    expect(calls.sort()).toEqual(["alice", "bob"]);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("records a system error for every failed agent and continues to the next", async () => {
    writeAgents(localPath, {
      alice: makeAgentRecord(),
      bob: makeAgentRecord(),
      carol: makeAgentRecord(),
    });
    const { manager } = stubManager({
      outcomes: {
        alice: new WorktreeError("alice broke"),
        bob: "ok",
        carol: new WorktreeError("carol broke"),
      },
    });
    const result = await ensureWorktreesProvisioned(ctx(), manager);
    expect(result.scanned).toBe(3);
    expect(result.provisioned).toEqual(["bob"]);
    expect(result.failed.map((f) => f.agent).sort()).toEqual(["alice", "carol"]);
    // Each failure surfaces as a `worktree`-source system error so the
    // dashboard agent card flags broken state.
    expect(recordSpy).toHaveBeenCalledTimes(2);
    const sources = recordSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { source: string }).source,
    );
    expect(sources).toEqual(["worktree", "worktree"]);
    const messages = recordSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { message: string }).message,
    );
    // Each message names the affected agent so the operator can act.
    expect(messages.some((m: string) => m.includes("alice"))).toBe(true);
    expect(messages.some((m: string) => m.includes("carol"))).toBe(true);
    // DX-244: messages enumerate BOTH artifacts so the operator
    // doesn't have to grep the helper to know which one's missing.
    // A regression that drops `.env` (or reverts to the
    // node_modules-only wording) trips this.
    expect(
      messages.every((m: string) => m.includes("node_modules / .env")),
    ).toBe(true);
  });

  it("does not throw when a single agent's ensureProvisioned rejects", async () => {
    writeAgents(localPath, { alice: makeAgentRecord() });
    const { manager } = stubManager({
      outcomes: { alice: new WorktreeError("alice broke") },
    });
    // Boot must not abort on a per-agent failure — healthy agents are
    // still dispatchable.
    await expect(
      ensureWorktreesProvisioned(ctx(), manager),
    ).resolves.toMatchObject({
      scanned: 1,
      provisioned: [],
    });
  });

  it("the returned `failed` entries carry the error message verbatim", async () => {
    writeAgents(localPath, { alice: makeAgentRecord() });
    const { manager } = stubManager({
      outcomes: { alice: new WorktreeError("npm install missing") },
    });
    const result = await ensureWorktreesProvisioned(ctx(), manager);
    expect(result.failed).toEqual([
      { agent: "alice", error: "npm install missing" },
    ]);
  });
});
