/**
 * Unit tests for branch-recovery dispatch routing (DX-161).
 *
 * Pure prompt content lives in `./recovery-prompt.test.ts`; the YAML-edit
 * + last-modified-card scan lives in `./recovery-card-update.test.ts`.
 * This file covers `dispatchWithRecovery` routing + `dispatchInRecoveryMode`
 * post-completion behaviour ONLY.
 *
 * No `vi.mock("./core.js")` here — `recovery-mode.ts` no longer imports
 * the dispatch default; `deps.dispatch` is required, so the test file
 * loads no transitive `config.ts` chain. (Code-review M2 fix.)
 */

import { describe, it, expect, vi } from "vitest";
import {
  dispatchInRecoveryMode,
  dispatchWithRecovery,
  type DirtyValidation,
} from "./recovery-mode.js";
import type {
  ValidationResult,
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
  validate?: () => Promise<ValidationResult>;
  resetClean?: () => Promise<void>;
}): WorktreeManager & {
  calls: { validate: number; resetClean: number; bootstrap: number; teardown: number };
} {
  const calls = { validate: 0, resetClean: 0, bootstrap: 0, teardown: 0 };
  return {
    calls,
    worktreePath: (ctx, name) => `${ctx.localPath}/.danxbot/worktrees/${name}`,
    bootstrap: async () => {
      calls.bootstrap++;
    },
    teardown: async () => {
      calls.teardown++;
    },
    validate: async () => {
      calls.validate++;
      return opts.validate ? opts.validate() : { state: "clean" };
    },
    resetClean: async () => {
      calls.resetClean++;
      if (opts.resetClean) await opts.resetClean();
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

const dirty: DirtyValidation = {
  state: "dirty",
  reason: "uncommitted changes",
  details: { porcelain: " M file", ahead: 0, behind: 0 },
};

// ============================================================
// dispatchWithRecovery — routing
// ============================================================

describe("dispatchWithRecovery", () => {
  it("clean validation → resetClean called, then deps.dispatch invoked verbatim", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-1",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({ validate: async () => ({ state: "clean" }) });
    const input = mkInput();

    const result = await dispatchWithRecovery(
      input,
      { agentName: "alice", manager },
      { dispatch: dispatchMock },
    );

    expect(manager.calls.validate).toBe(1);
    expect(manager.calls.resetClean).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0][0].task).toBe("do the thing");
    expect(result.dispatchId).toBe("id-1");
  });

  it("dirty validation → routes to recovery-mode dispatch with recovery prompt + 'internal:recovery' endpoint", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "recovery-id",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({ validate: async () => dirty });

    const result = await dispatchWithRecovery(
      mkInput({ task: "Original work card description" }),
      { agentName: "alice", manager },
      { dispatch: dispatchMock },
    );

    expect(manager.calls.validate).toBe(1);
    expect(manager.calls.resetClean).toBe(0); // never reset on dirty
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const handed = dispatchMock.mock.calls[0][0];
    expect(handed.task).toContain("<!-- danxbot-recovery -->");
    expect(handed.task).not.toContain("Original work card description");
    expect(handed.title).toBe("Branch recovery — alice");

    // M3 fix — the dispatch metadata now carries the recovery marker so
    // dashboards / log readers can spot recovery runs without a schema
    // change. The original `initialPrompt` is replaced with the recovery
    // prompt (the dispatch row's `initialPrompt` reflects what was
    // actually shipped to claude).
    expect(handed.apiDispatchMeta.trigger).toBe("api");
    if (handed.apiDispatchMeta.trigger === "api") {
      expect(handed.apiDispatchMeta.metadata.endpoint).toBe("internal:recovery");
      expect(handed.apiDispatchMeta.metadata.initialPrompt).toContain(
        "<!-- danxbot-recovery -->",
      );
    }
    expect(result.dispatchId).toBe("recovery-id");
  });
});

describe("dispatchWithRecovery — persona inheritance (DX-162)", () => {
  // The persona block prepended by `dispatch()` (Phase 4) lives on
  // `DispatchInput.agent`. Recovery-mode wraps the input via `...input`
  // spread + task-override; if the spread drops `agent`, recovery
  // dispatches lose the persona. Pin that here so a future refactor
  // can't regress the inheritance silently.
  it("clean validation: deps.dispatch receives input.agent verbatim (no spread loss)", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-clean-with-agent",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({ validate: async () => ({ state: "clean" }) });
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

  it("dirty validation: recovery-mode dispatch ALSO carries input.agent verbatim through the spread", async () => {
    const dispatchMock = vi.fn(
      async (_input: DispatchInput): Promise<DispatchResult> => ({
        dispatchId: "id-recovery-with-agent",
        job: fakeJob(),
      }),
    );
    const manager = mkManager({ validate: async () => dirty });
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
    // The recovery prompt replaced the task body, so `dispatch()` will
    // prepend the persona in front of the recovery prompt — exactly
    // what we want.
    expect(dispatchMock.mock.calls[0][0].task).toContain("alice");
  });
});

// ============================================================
// dispatchInRecoveryMode — post-completion re-validate
// ============================================================

describe("dispatchInRecoveryMode post-completion behaviour", () => {
  it("re-validates after completion; clean → no Needs Help comment filed", async () => {
    const manager = mkManager({ validate: async () => ({ state: "clean" }) });
    const dispatchMock = vi.fn(
      async (input: DispatchInput): Promise<DispatchResult> => {
        await input.onComplete?.(fakeJob());
        return { dispatchId: "id-x", job: fakeJob() };
      },
    );
    const findLast = vi.fn().mockResolvedValue({ id: "DX-1", path: "/p/DX-1.yml" });
    const append = vi.fn().mockResolvedValue(undefined);

    await dispatchInRecoveryMode(mkInput(), "alice", dirty, manager, {
      dispatch: dispatchMock,
      findLastModifiedOpenCard: findLast,
      appendNeedsHelpComment: append,
    });

    expect(findLast).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("re-validates after completion; still-dirty → files Needs Help on the last-modified card", async () => {
    const stillDirty: DirtyValidation = {
      state: "dirty",
      reason: "branch has unmerged commits",
      details: { porcelain: "", ahead: 5, behind: 0 },
    };
    const manager = mkManager({ validate: async () => stillDirty });
    const dispatchMock = vi.fn(
      async (input: DispatchInput): Promise<DispatchResult> => {
        await input.onComplete?.(fakeJob());
        return { dispatchId: "id-y", job: fakeJob() };
      },
    );
    const findLast = vi.fn().mockResolvedValue({ id: "DX-42", path: "/p/DX-42.yml" });
    const append = vi.fn().mockResolvedValue(undefined);

    await dispatchInRecoveryMode(mkInput(), "alice", dirty, manager, {
      dispatch: dispatchMock,
      findLastModifiedOpenCard: findLast,
      appendNeedsHelpComment: append,
    });

    expect(findLast).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    const [path, body] = append.mock.calls[0];
    expect(path).toBe("/p/DX-42.yml");
    expect(body).toContain("Branch recovery still dirty");
    expect(body).toContain("alice");
    expect(body).toContain("branch has unmerged commits");
    expect(body).toContain("5"); // ahead count surfaces in the comment
  });

  it("still-dirty + no open cards → logs (no throw, no append)", async () => {
    const stillDirty: DirtyValidation = {
      state: "dirty",
      reason: "uncommitted changes",
      details: { porcelain: " M f", ahead: 0, behind: 0 },
    };
    const manager = mkManager({ validate: async () => stillDirty });
    const dispatchMock = vi.fn(
      async (input: DispatchInput): Promise<DispatchResult> => {
        await input.onComplete?.(fakeJob());
        return { dispatchId: "id-z", job: fakeJob() };
      },
    );
    const findLast = vi.fn().mockResolvedValue(null);
    const append = vi.fn();

    await expect(
      dispatchInRecoveryMode(mkInput(), "alice", dirty, manager, {
        dispatch: dispatchMock,
        findLastModifiedOpenCard: findLast,
        appendNeedsHelpComment: append,
      }),
    ).resolves.toBeDefined();

    expect(findLast).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  });

  it("preserves caller's onComplete — invoked alongside the recovery follow-up", async () => {
    const manager = mkManager({ validate: async () => ({ state: "clean" }) });
    const callerOnComplete = vi.fn();
    const dispatchMock = vi.fn(
      async (input: DispatchInput): Promise<DispatchResult> => {
        await input.onComplete?.(fakeJob());
        return { dispatchId: "id-q", job: fakeJob() };
      },
    );

    await dispatchInRecoveryMode(
      mkInput({ onComplete: callerOnComplete }),
      "alice",
      dirty,
      manager,
      { dispatch: dispatchMock },
    );

    expect(callerOnComplete).toHaveBeenCalledTimes(1);
  });

  it("caller's onComplete throws → error is logged, recovery follow-up still runs (H1 fix)", async () => {
    // Caller's onComplete throws; the post-recovery validate + append
    // chain MUST still execute. This is the H1 contract — the recovery
    // dispatch's lifecycle isn't held hostage to the caller's bookkeeping.
    const stillDirty: DirtyValidation = {
      state: "dirty",
      reason: "uncommitted changes",
      details: { porcelain: " M f", ahead: 0, behind: 0 },
    };
    const manager = mkManager({ validate: async () => stillDirty });
    const callerOnComplete = vi.fn().mockRejectedValue(new Error("caller bug"));
    const append = vi.fn().mockResolvedValue(undefined);
    const findLast = vi
      .fn()
      .mockResolvedValue({ id: "DX-1", path: "/p/DX-1.yml" });

    const dispatchMock = vi.fn(
      async (input: DispatchInput): Promise<DispatchResult> => {
        await input.onComplete?.(fakeJob());
        return { dispatchId: "id-q", job: fakeJob() };
      },
    );

    await expect(
      dispatchInRecoveryMode(
        mkInput({ onComplete: callerOnComplete }),
        "alice",
        dirty,
        manager,
        {
          dispatch: dispatchMock,
          findLastModifiedOpenCard: findLast,
          appendNeedsHelpComment: append,
        },
      ),
    ).resolves.toBeDefined();

    expect(callerOnComplete).toHaveBeenCalledTimes(1);
    expect(findLast).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
  });
});
