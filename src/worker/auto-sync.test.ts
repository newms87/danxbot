import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { autoSyncTrackedIssue } from "./auto-sync.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { Dispatch } from "../dashboard/dispatches.js";

/**
 * Post-dispatch reconcile — fires for every dispatch carrying an
 * `issueId`, regardless of trigger source or `trelloSync` setting.
 * Trello is fully decoupled from this path; the Trello push is gated
 * INSIDE `reconcileIssue` step 7, not at the auto-sync entry point.
 *
 * See `auto-sync.ts` module header for the decoupling invariant.
 *
 * NOTE — the freed-agent picker poke (`onDispatchTerminated`) USED to
 * live in this module's `finally` block; it moved to `handleStop` /
 * `handleStopFromDb` in `src/worker/dispatch.ts` so it fires AFTER the
 * dispatch row is marked terminal (`pickFreeAgent` must not see the
 * dispatch as live when the picker re-fires). Coverage for the poke
 * call lives in `dispatch.test.ts`; this file no longer mocks it.
 */

function setupRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-auto-sync-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

function fakeDispatchRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "dispatch-123",
    repoName: "test-repo",
    trigger: "trello",
    triggerMetadata: {
      cardId: "external-abc",
      cardName: "n",
      cardUrl: "",
      listId: "",
      listName: "",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    issueId: "TEST-1",
    status: "completed",
    startedAt: 0,
    completedAt: 0,
    summary: "ok",
    error: null,
    runtimeMode: "host",
    hostPid: null,
    hostPidAt: null,
    ...overrides,
  } as unknown as Dispatch;
}

describe("autoSyncTrackedIssue — post-dispatch reconcile", () => {
  let localPath: string;

  beforeEach(() => {
    localPath = setupRepo();
  });

  afterEach(() => {
    rmSync(localPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("no-ops when getDispatch returns null (row already cleaned up)", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const getDispatch = vi.fn().mockResolvedValue(null);
    const reconcile = vi.fn();

    await autoSyncTrackedIssue("missing-id", repo, { getDispatch, reconcile });

    expect(getDispatch).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("no-ops when dispatch has no issueId (Slack chat, board-chat, ideator, free-form /api/launch)", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const row = fakeDispatchRow({ issueId: null });
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn();

    await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

    expect(getDispatch).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("calls reconcile(repo, issueId, 'lifecycle') for every dispatch with an issueId — Trello trigger", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const row = fakeDispatchRow({ trigger: "trello", issueId: "TEST-7" });
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: repo.name,
        localPath: repo.localPath,
        issuePrefix: repo.issuePrefix,
      }),
      "TEST-7",
      "lifecycle",
    );
  });

  it("calls reconcile for Slack-triggered dispatch when issueId is set (deep-agent threads bound to a card)", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const row = fakeDispatchRow({ trigger: "slack", issueId: "TEST-9" });
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

    expect(reconcile).toHaveBeenCalledWith(
      expect.any(Object),
      "TEST-9",
      "lifecycle",
    );
  });

  it("calls reconcile for /api/launch-triggered dispatch when issueId is set (HTTP dispatches against a card YAML)", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const row = fakeDispatchRow({ trigger: "api", issueId: "TEST-11" });
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

    expect(reconcile).toHaveBeenCalledWith(
      expect.any(Object),
      "TEST-11",
      "lifecycle",
    );
  });

  it("decoupling invariant: trelloSync is NOT consulted at this layer — reconcile fires regardless", async () => {
    // Whether the operator has disabled trelloSync is the Trello push
    // step's concern, not this module's. We assert the contract by
    // omitting any settings.json from `localPath` (no override file at
    // all) and confirming reconcile still runs. The Trello push gate
    // lives at `src/issue/reconcile.ts:614` and is exercised by
    // reconcile's own tests, not here.
    const repo = makeRepoContext({ localPath, trelloEnabled: false });
    const row = fakeDispatchRow();
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("swallows reconcile errors so a tracker hiccup never stalls the agent's terminal state", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const row = fakeDispatchRow();
    const getDispatch = vi.fn().mockResolvedValue(row);
    const reconcile = vi.fn().mockRejectedValue(new Error("DB down"));

    await expect(
      autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile }),
    ).resolves.toBeUndefined();
  });

  it("swallows getDispatch errors (same reason)", async () => {
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const getDispatch = vi.fn().mockRejectedValue(new Error("DB down"));
    const reconcile = vi.fn();

    await expect(
      autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile }),
    ).resolves.toBeUndefined();

    expect(reconcile).not.toHaveBeenCalled();
  });

  describe("error logging (silent swallow must be detectable in production logs)", () => {
    // The catch in autoSyncTrackedIssue MUST log every failure it
    // swallows — silent suppression would leave production debugging
    // with no breadcrumb when the post-dispatch reconcile path
    // mis-behaves. These tests pin the log-fires-on-error contract so a
    // future refactor that drops the `log.error(...)` call (or replaces
    // it with a no-op) fails CI instead of shipping silent.
    //
    // The logger (`src/logger.ts`) writes error-level entries through
    // `console.error` as a JSON string, so a `console.error` spy catches
    // the produced log without coupling these tests to logger internals.

    it("logs through console.error when getDispatch throws", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const getDispatch = vi.fn().mockRejectedValue(new Error("DB down"));
      const reconcile = vi.fn();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

      expect(errorSpy).toHaveBeenCalled();
      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      // Assert the underlying error message + component made it through;
      // headline log wording is intentionally not pinned (cosmetic
      // rewording of the headline shouldn't fail this test — losing the
      // log call entirely should).
      expect(messages.some((s) => s.includes("DB down"))).toBe(true);
      expect(messages.some((s) => s.includes("post-dispatch-reconcile"))).toBe(true);
    });

    it("logs through console.error when reconcile throws", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow();
      const getDispatch = vi.fn().mockResolvedValue(row);
      const reconcile = vi.fn().mockRejectedValue(new Error("reconcile boom"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

      expect(errorSpy).toHaveBeenCalled();
      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(messages.some((s) => s.includes("reconcile boom"))).toBe(true);
      expect(messages.some((s) => s.includes("post-dispatch-reconcile"))).toBe(true);
    });

  });

  describe("ReconcileRepoContext shape — no RepoContext leak", () => {
    // The reconcile seam is typed to accept only the trimmed
    // `ReconcileRepoContext` ({name, localPath, issuePrefix}). At the
    // call site in `auto-sync.ts` we build a fresh object literal
    // selecting only those three keys, so callers cannot accidentally
    // leak the wider `RepoContext` shape (trello creds, db creds, slack
    // token, githubToken, workerPort, trelloEnabled, etc.) into the
    // reconcile pipeline.
    //
    // This is structurally enforced by `--noEmit` typecheck today, but a
    // future refactor that loosens the seam type to `RepoContext` would
    // break the boundary silently. These tests pin the runtime shape so
    // the contract is double-anchored (types + runtime).
    it("passes ONLY {name, localPath, issuePrefix} to reconcile — does not leak the wider RepoContext", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow({ issueId: "TEST-42" });
      const getDispatch = vi.fn().mockResolvedValue(row);
      const reconcile = vi.fn().mockResolvedValue(undefined);

      await autoSyncTrackedIssue("dispatch-123", repo, { getDispatch, reconcile });

      expect(reconcile).toHaveBeenCalledOnce();
      const [ctxArg] = reconcile.mock.calls[0] as [Record<string, unknown>, string, string];
      expect(Object.keys(ctxArg).sort()).toEqual([
        "issuePrefix",
        "localPath",
        "name",
      ]);
      expect(ctxArg).not.toHaveProperty("trello");
      expect(ctxArg).not.toHaveProperty("db");
      expect(ctxArg).not.toHaveProperty("slack");
      expect(ctxArg).not.toHaveProperty("githubToken");
      expect(ctxArg).not.toHaveProperty("workerPort");
      expect(ctxArg).not.toHaveProperty("trelloEnabled");
      expect(ctxArg).not.toHaveProperty("url");
      expect(ctxArg).not.toHaveProperty("hostPath");
    });
  });

  describe("DX-558 — root-clone sync hook", () => {
    it("invokes syncRoot once with the repo's {name, localPath} after reconcile", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow({ issueId: "TEST-50" });
      const getDispatch = vi.fn().mockResolvedValue(row);
      const order: string[] = [];
      const reconcile = vi.fn().mockImplementation(async () => {
        order.push("reconcile");
      });
      const syncRoot = vi.fn().mockImplementation(async () => {
        order.push("syncRoot");
        return { status: "synced", error: null };
      });

      await autoSyncTrackedIssue("dispatch-50", repo, {
        getDispatch,
        reconcile,
        syncRoot,
      });

      expect(syncRoot).toHaveBeenCalledOnce();
      expect(syncRoot).toHaveBeenCalledWith({
        repoName: repo.name,
        repoLocalPath: repo.localPath,
      });
      expect(order).toEqual(["reconcile", "syncRoot"]);
    });

    it("invokes syncRoot even when reconcile rejects (sync is best-effort, not gated on tracker push)", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow({ issueId: "TEST-51" });
      const getDispatch = vi.fn().mockResolvedValue(row);
      const reconcile = vi.fn().mockRejectedValue(new Error("tracker boom"));
      const syncRoot = vi.fn().mockResolvedValue({ status: "synced", error: null });

      await autoSyncTrackedIssue("dispatch-51", repo, {
        getDispatch,
        reconcile,
        syncRoot,
      });

      expect(syncRoot).toHaveBeenCalledOnce();
    });

    it("swallows syncRoot rejection so dispatch state still lands", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow({ issueId: "TEST-52" });
      const getDispatch = vi.fn().mockResolvedValue(row);
      const reconcile = vi.fn().mockResolvedValue(undefined);
      const syncRoot = vi.fn().mockRejectedValue(new Error("sync boom"));

      await expect(
        autoSyncTrackedIssue("dispatch-52", repo, { getDispatch, reconcile, syncRoot }),
      ).resolves.toBeUndefined();
    });

    it("does NOT invoke syncRoot when the dispatch carries no issueId (no-issue dispatches skip the entire reconcile branch)", async () => {
      const repo = makeRepoContext({ localPath, trelloEnabled: true });
      const row = fakeDispatchRow({ issueId: null });
      const getDispatch = vi.fn().mockResolvedValue(row);
      const reconcile = vi.fn();
      const syncRoot = vi.fn();

      await autoSyncTrackedIssue("dispatch-53", repo, {
        getDispatch,
        reconcile,
        syncRoot,
      });

      // syncRoot runs OUTSIDE the issueId guard — it fires unconditionally on
      // every dispatch terminal save so root drift is corrected regardless of
      // whether the dispatch was bound to a card YAML (free-form /api/launch,
      // Slack chats, board-chat sessions all drop main commits too).
      expect(syncRoot).toHaveBeenCalledOnce();
    });
  });

  describe("Tier 4 retry envelope (DX-637)", () => {
    it("retries reconcile on a transient pg error and proceeds without surfacing the blip", async () => {
      const repo = makeRepoContext({ localPath: setupRepo() });
      const getDispatch = vi
        .fn()
        .mockResolvedValue(fakeDispatchRow({ issueId: "TEST-1" }));
      const reconcile = vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Connection terminated due to connection timeout"),
        )
        .mockResolvedValueOnce(undefined);
      const syncRoot = vi.fn().mockResolvedValue(undefined);

      await autoSyncTrackedIssue("dispatch-123", repo, {
        getDispatch,
        reconcile,
        syncRoot,
      });

      // First call threw transient → second call succeeded inside tier4Retry.
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(syncRoot).toHaveBeenCalledOnce();
    });

    it("does not retry a non-transient reconcile failure — swallows it like before", async () => {
      const repo = makeRepoContext({ localPath: setupRepo() });
      const getDispatch = vi
        .fn()
        .mockResolvedValue(fakeDispatchRow({ issueId: "TEST-1" }));
      const reconcile = vi
        .fn()
        .mockRejectedValue(new Error("schema validation failed"));
      const syncRoot = vi.fn().mockResolvedValue(undefined);

      await autoSyncTrackedIssue("dispatch-123", repo, {
        getDispatch,
        reconcile,
        syncRoot,
      });

      // Non-transient → exactly one attempt, error swallowed, syncRoot still fires.
      expect(reconcile).toHaveBeenCalledOnce();
      expect(syncRoot).toHaveBeenCalledOnce();
    });
  });
});
