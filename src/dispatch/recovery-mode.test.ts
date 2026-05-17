/**
 * Unit tests for `dispatchWithRecovery` (DX-291 P6 — collapsed wrapper).
 *
 * The dirty-routing + recovery-prompt branch was retired in DX-297; the
 * prep skill (DX-291 P4) now owns WIP recovery + branch-state inspection
 * (the `validate()` interface method itself was retired in DX-333). This
 * file covers the slimmer surface: fetch → syncWorktree → spawn; on
 * syncWorktree abort, persistent `agents.<name>.broken` stamp + throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchWithRecovery } from "./recovery-mode.js";
import type {
  SnapshotResult,
  SyncResult,
  WorktreeManager,
} from "../agent/worktree-manager.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { DispatchInput, DispatchResult } from "./core.js";
import type { AgentJob } from "../agent/launcher.js";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function mkManager(opts: {
  syncWorktree?: () => Promise<SyncResult>;
  fetchOrigin?: () => Promise<boolean>;
  snapshotIfDirty?: () => Promise<SnapshotResult>;
}): WorktreeManager & {
  calls: {
    syncWorktree: number;
    bootstrap: number;
    teardown: number;
    fetchOrigin: number;
    snapshotIfDirty: number;
  };
} {
  const calls = {
    syncWorktree: 0,
    bootstrap: 0,
    teardown: 0,
    fetchOrigin: 0,
    snapshotIfDirty: 0,
  };
  return {
    calls,
    worktreePath: (ctx, name) => `${ctx.localPath}/.danxbot/worktrees/${name}`,
    bootstrap: async () => {
      calls.bootstrap++;
    },
    teardown: async () => {
      calls.teardown++;
    },
    syncWorktree: async () => {
      calls.syncWorktree++;
      return opts.syncWorktree ? opts.syncWorktree() : { kind: "noop" };
    },
    ensureProvisioned: async () => {},
    fetchOrigin: async () => {
      calls.fetchOrigin++;
      return opts.fetchOrigin ? opts.fetchOrigin() : true;
    },
    snapshotIfDirty: async () => {
      calls.snapshotIfDirty++;
      return opts.snapshotIfDirty
        ? opts.snapshotIfDirty()
        : { kind: "clean" };
    },
  };
}

function mkInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    repo: makeRepoContext({ localPath: "/repo/x" }),
    task: "do the thing",
    workspace: "issue-worker",
    overlay: {},
    apiDispatchMeta: {
      trigger: "api",
      metadata: {
        endpoint: "/api/launch",
        callerIp: null,
        statusUrl: null,
        initialPrompt: "do the thing",
      },
    },
    ...overrides,
  };
}

function fakeJob(): AgentJob {
  return { status: "completed", summary: "ok" } as unknown as AgentJob;
}

/**
 * Build a per-test repo dir with a seeded `agents` roster, so the
 * setAgentBroken side-effect on the abort path lands on a real file the
 * test can read back. Returns the absolute repoLocalPath.
 */
function seedRepo(agentName: string): { repoLocalPath: string; cleanup: () => void } {
  const repoLocalPath = mkdtempSync(join(tmpdir(), "dispatch-with-recovery-"));
  mkdirSync(join(repoLocalPath, ".danxbot"), { recursive: true });
  const settings = {
    overrides: {
      slack: { enabled: null },
      issuePoller: { enabled: null, pickupNamePrefix: null },
      dispatchApi: { enabled: null },
      ideator: { enabled: null },
      autoTriage: { enabled: null },
      trelloSync: { enabled: null },
    },
    display: {},
    agents: {
      [agentName]: {
        type: "agent" as const,
        bio: "test agent",
        capabilities: ["issue-worker"],
        schedule: {
          tz: "America/Chicago",
          mon: [],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
          sun: [],
        },
        enabled: true,
        broken: null,
        created_at: "2026-05-08T12:00:00Z",
        updated_at: "2026-05-08T12:00:00Z",
      },
    },
    agentDefaults: { prepMode: "combined" },
    meta: { updatedAt: new Date(0).toISOString(), updatedBy: "worker" },
  };
  writeFileSync(
    join(repoLocalPath, ".danxbot", "settings.json"),
    JSON.stringify(settings, null, 2),
  );
  return {
    repoLocalPath,
    cleanup: () => rmSync(repoLocalPath, { recursive: true, force: true }),
  };
}

describe("dispatchWithRecovery", () => {
  it("happy path: fetchOrigin → syncWorktree → deps.dispatch invoked verbatim", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-happy",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({});
    const input = mkInput();

    const result = await dispatchWithRecovery(
      input,
      { agentName: "alice", manager },
      { dispatch: dispatchMock },
    );

    expect(manager.calls.fetchOrigin).toBe(1);
    expect(manager.calls.syncWorktree).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0].task).toBe("do the thing");
    expect(result.dispatchId).toBe("id-happy");
  });

  it("ordering: fetchOrigin → snapshotIfDirty → syncWorktree → dispatch (DX-359)", async () => {
    const order: string[] = [];
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => {
        order.push("dispatch");
        return { dispatchId: "id-order", job: fakeJob() };
      },
    );
    const manager = mkManager({
      fetchOrigin: async () => {
        order.push("fetchOrigin");
        return true;
      },
      snapshotIfDirty: async () => {
        order.push("snapshotIfDirty");
        return { kind: "clean" };
      },
      syncWorktree: async () => {
        order.push("syncWorktree");
        return { kind: "noop" };
      },
    });

    await dispatchWithRecovery(
      mkInput(),
      { agentName: "alice", manager },
      { dispatch: dispatchMock },
    );

    // snapshotIfDirty MUST run AFTER fetchOrigin (so the agent branch
    // is on top of the freshly-fetched origin/main when rebase replays
    // the snapshot) and BEFORE syncWorktree (so the dirty tree is
    // already clean when ff-only pull runs).
    expect(order).toEqual([
      "fetchOrigin",
      "snapshotIfDirty",
      "syncWorktree",
      "dispatch",
    ]);
  });

  it("dispatch proceeds when fetchOrigin returns false (transient network failure does not dead-letter)", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-flaky",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({
      fetchOrigin: async () => false,
    });

    const result = await dispatchWithRecovery(
      mkInput(),
      { agentName: "alice", manager },
      { dispatch: dispatchMock },
    );

    expect(manager.calls.fetchOrigin).toBe(1);
    expect(manager.calls.syncWorktree).toBe(1);
    expect(result.dispatchId).toBe("id-flaky");
  });

  it("deps.dispatch rejection propagates AS-IS — no agents.<name>.broken stamp on downstream spawn failure", async () => {
    // Regression pin: only `syncWorktree` abort is supposed to stamp
    // `agents.<name>.broken`. A spawn-side failure (workspace resolve
    // throws, OS spawn error, MCP probe failure) must bubble up to the
    // multi-agent-pick caller's try/catch verbatim — wrapping it in a
    // broken stamp would lock the agent out for an unrelated transient
    // error.
    const seeded = seedRepo("alice");
    try {
      const dispatchMock = vi.fn(
        async (_input: DispatchInput): Promise<DispatchResult> => {
          throw new Error("spawn failed: workspace resolver error");
        },
      );
      const manager = mkManager({});
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      await expect(
        dispatchWithRecovery(
          input,
          { agentName: "alice", manager },
          { dispatch: dispatchMock },
        ),
      ).rejects.toThrow(/spawn failed/);

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toBeNull();
    } finally {
      seeded.cleanup();
    }
  });

  describe("syncWorktree conflict → passes through to deps.dispatch (NO broken stamp)", () => {
    // Rebase conflict against origin/main is the EXPECTED collision when
    // two agents (or a human PR merge + an agent's local commits) touch
    // the same files. The wrapper-level rebase backs out cleanly (kind
    // "conflict" carries the captured stderr), but the dispatch then
    // hands off to the agent — the prep skill's Step 4 re-runs the rebase
    // and resolves conflicts in place semantically. Stamping
    // agents.<name>.broken on a rebase conflict locks the agent out
    // forever (operator must clear via dashboard) for what is supposed
    // to be a self-healing in-session flow. Regression: DX-293 wired
    // the conflict path to the broken-stamp branch by mistake; this
    // test pins the correct behavior.
    let seeded: { repoLocalPath: string; cleanup: () => void };

    beforeEach(() => {
      seeded = seedRepo("alice");
    });

    afterEach(() => {
      seeded.cleanup();
    });

    it("rebase conflict → deps.dispatch invoked, agents.<name>.broken stays null", async () => {
      const dispatchMock = vi.fn(
        async (_input: DispatchInput): Promise<DispatchResult> => ({
          dispatchId: "id-conflict-handoff",
          job: fakeJob(),
        }),
      );
      const manager = mkManager({
        syncWorktree: async () => ({
          kind: "conflict",
          reason: "rebase conflict against origin/main",
          details:
            "CONFLICT (content): Merge conflict in src/foo.ts\nerror: could not apply ...",
        }),
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      const result = await dispatchWithRecovery(
        input,
        { agentName: "alice", manager },
        { dispatch: dispatchMock },
      );

      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(result.dispatchId).toBe("id-conflict-handoff");

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toBeNull();
    });
  });

  describe("syncWorktree abort → stamps agents.<name>.broken + throws", () => {
    let seeded: { repoLocalPath: string; cleanup: () => void };

    beforeEach(() => {
      seeded = seedRepo("alice");
    });

    afterEach(() => {
      seeded.cleanup();
    });

    it("stamps agents.<name>.broken persistently then throws plain Error", async () => {
      const dispatchMock = vi.fn();
      const manager = mkManager({
        syncWorktree: async () => ({
          kind: "abort",
          reason: "ff-only pull rejected",
          details: "fatal: Not possible to fast-forward",
        }),
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      await expect(
        dispatchWithRecovery(
          input,
          { agentName: "alice", manager },
          { dispatch: dispatchMock },
        ),
      ).rejects.toThrow(/syncWorktree aborted/);
      expect(dispatchMock).not.toHaveBeenCalled();

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toMatchObject({
        reason: "syncWorktree aborted: ff-only pull rejected",
        suggested_steps: ["fatal: Not possible to fast-forward"],
      });
      expect(settings.agents.alice.broken.set_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    });

    it("empty sync.details → suggested_steps stays empty (not stamped with empty string)", async () => {
      const dispatchMock = vi.fn();
      const manager = mkManager({
        syncWorktree: async () => ({
          kind: "abort",
          reason: "fetch failed",
          details: "",
        }),
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      await expect(
        dispatchWithRecovery(
          input,
          { agentName: "alice", manager },
          { dispatch: dispatchMock },
        ),
      ).rejects.toThrow(/syncWorktree aborted/);

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken.suggested_steps).toEqual([]);
    });
  });

  // ============================================================
  // DX-359 — pre-sync WIP snapshot prevents the agent broken-stamp
  // after a prior dispatch died unclean leaving the worktree dirty.
  // ============================================================

  describe("snapshotIfDirty (DX-359)", () => {
    let seeded: { repoLocalPath: string; cleanup: () => void };

    beforeEach(() => {
      seeded = seedRepo("alice");
    });

    afterEach(() => {
      seeded.cleanup();
    });

    it("a dirty-tree snapshot commit unwedges ff-only pull (happy path: snapshotted → syncWorktree → dispatch)", async () => {
      // The exact failure mode this is fixing: prior dispatch died with
      // WIP in the worktree; without the snapshot pass, syncWorktree's
      // ff-only pull would abort and the agent would land in broken=YES.
      // With the snapshot pass, the WIP is committed FIRST and sync
      // rebases the snapshot onto fresh origin/main.
      const order: string[] = [];
      const dispatchMock = vi.fn(
        async (_input: DispatchInput): Promise<DispatchResult> => {
          order.push("dispatch");
          return { dispatchId: "id-snapshot-rebase", job: fakeJob() };
        },
      );
      const manager = mkManager({
        snapshotIfDirty: async () => {
          order.push("snapshotIfDirty(snapshotted)");
          return { kind: "snapshotted", sha: "abc123" };
        },
        syncWorktree: async () => {
          order.push("syncWorktree(rebased)");
          return { kind: "rebased", commits: 1 };
        },
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      const result = await dispatchWithRecovery(
        input,
        { agentName: "alice", manager },
        { dispatch: dispatchMock },
      );

      expect(result.dispatchId).toBe("id-snapshot-rebase");
      expect(order).toEqual([
        "snapshotIfDirty(snapshotted)",
        "syncWorktree(rebased)",
        "dispatch",
      ]);
      // Agent stays unbroken — the snapshot pass + rebase is a normal,
      // non-error recovery path.
      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toBeNull();
    });

    it("snapshotIfDirty abort → stamps agents.<name>.broken with snapshot reason + throws, never calls syncWorktree or dispatch", async () => {
      const dispatchMock = vi.fn();
      const syncWorktreeMock = vi.fn();
      const manager = mkManager({
        snapshotIfDirty: async () => ({
          kind: "abort",
          reason: "worktree HEAD not on agent branch",
          details: "expected branch alice, got bob",
        }),
        syncWorktree: async () => {
          syncWorktreeMock();
          return { kind: "noop" };
        },
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      await expect(
        dispatchWithRecovery(
          input,
          { agentName: "alice", manager },
          { dispatch: dispatchMock },
        ),
      ).rejects.toThrow(/snapshotIfDirty aborted/);

      // Critical: bailing on snapshot abort does NOT proceed into
      // syncWorktree (would lose / duplicate the WIP) and does NOT
      // spawn the agent (worktree state is corrupt).
      expect(syncWorktreeMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toMatchObject({
        reason: "snapshotIfDirty aborted: worktree HEAD not on agent branch",
        suggested_steps: ["expected branch alice, got bob"],
        // DX-364 — sync-recovery abort uses `defaultBrokenEvaluator()`;
        // pin the stamped evaluator block so the contract can't drift.
        evaluator_status: "completed",
        evaluator_dispatch_id: null,
      });
    });

    it("clean tree → no snapshot, proceeds straight to syncWorktree (most common path)", async () => {
      const dispatchMock = vi.fn(
        async (_input: DispatchInput): Promise<DispatchResult> => ({
          dispatchId: "id-clean",
          job: fakeJob(),
        }),
      );
      const manager = mkManager({
        snapshotIfDirty: async () => ({ kind: "clean" }),
        syncWorktree: async () => ({ kind: "noop" }),
      });
      const input = mkInput({
        repo: makeRepoContext({ localPath: seeded.repoLocalPath }),
      });

      await dispatchWithRecovery(
        input,
        { agentName: "alice", manager },
        { dispatch: dispatchMock },
      );

      expect(manager.calls.snapshotIfDirty).toBe(1);
      expect(manager.calls.syncWorktree).toBe(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);

      const settings = JSON.parse(
        readFileSync(
          join(seeded.repoLocalPath, ".danxbot", "settings.json"),
          "utf-8",
        ),
      );
      expect(settings.agents.alice.broken).toBeNull();
    });
  });
});

describe("dispatchWithRecovery — persona inheritance (DX-162)", () => {
  it("deps.dispatch receives input.agent verbatim (no spread loss)", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-with-agent",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({});
    const input = mkInput({
      agent: { name: "alice", bio: "Senior backend engineer." },
    });

    await dispatchWithRecovery(input, { agentName: "alice", manager }, {
      dispatch: dispatchMock,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0].agent).toEqual({
      name: "alice",
      bio: "Senior backend engineer.",
    });
  });
});

