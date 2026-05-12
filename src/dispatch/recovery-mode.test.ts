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
}): WorktreeManager & {
  calls: {
    syncWorktree: number;
    bootstrap: number;
    teardown: number;
    fetchOrigin: number;
  };
} {
  const calls = {
    syncWorktree: 0,
    bootstrap: 0,
    teardown: 0,
    fetchOrigin: 0,
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

  it("fetchOrigin runs before syncWorktree (refresh cached origin/main BEFORE deciding to ff)", async () => {
    const order: string[] = [];
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-order",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({
      fetchOrigin: async () => {
        order.push("fetchOrigin");
        return true;
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

    expect(order).toEqual(["fetchOrigin", "syncWorktree"]);
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

