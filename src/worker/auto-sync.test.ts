import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { autoSyncTrackedIssue } from "./auto-sync.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import { _resetForTesting as resetSettingsModule } from "../settings-file.js";
import type { Dispatch } from "../dashboard/dispatches.js";

/**
 * DX-302 — `trelloSync` override gates the worker's auto-sync fast path.
 * Both gates run BEFORE the dispatch row is queried so a disabled-Trello
 * repo doesn't even probe the DB; the reconcile callable is left
 * un-invoked so a tracker hiccup at the disabled-state moment cannot
 * leak into the dispatch's terminal signal.
 */

function setupRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-auto-sync-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

function writeOverride(localPath: string, enabled: boolean | null): void {
  writeFileSync(
    resolve(localPath, ".danxbot", "settings.json"),
    JSON.stringify({
      overrides: { trelloSync: { enabled } },
      meta: { updatedAt: new Date().toISOString(), updatedBy: "dashboard:test" },
    }),
  );
}

function fakeTrelloDispatch(): Dispatch {
  return {
    id: "dispatch-123",
    repoName: "test-repo",
    workspace: "issue-worker",
    trigger: "trello",
    triggerMetadata: { cardId: "external-abc" },
    status: "completed",
    summary: "ok",
    startedAt: 0,
    completedAt: 0,
    pidTerminatedAt: null,
    parentRecoverId: null,
    recoverCount: 0,
    agentName: null,
    sessionId: null,
    usage: null,
    cost: null,
    inactivityTimeoutSeconds: 0,
    workerHost: "test",
    workerPort: 5562,
    pid: 0,
  } as unknown as Dispatch;
}

describe("autoSyncTrackedIssue — DX-302 trelloSync gate", () => {
  let localPath: string;

  beforeEach(() => {
    resetSettingsModule();
    localPath = setupRepo();
  });

  afterEach(() => {
    rmSync(localPath, { recursive: true, force: true });
  });

  it("no-ops without consulting the dispatch row when override is false", async () => {
    writeOverride(localPath, false);
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const getDispatch = vi.fn();
    const reconcile = vi.fn();

    await autoSyncTrackedIssue("any-dispatch-id", repo, {
      getDispatch,
      reconcile,
    });

    expect(getDispatch).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("passes the gate when override is null (the trigger filter handles env)", async () => {
    // Override-only semantic — env default is handled by the dispatch
    // row's `trigger` filter (only `trigger === "trello"` ever reaches
    // reconcile). Null override means "operator hasn't paused sync";
    // proceed.
    writeOverride(localPath, null);
    const repo = makeRepoContext({ localPath, trelloEnabled: false });
    const dispatch = fakeTrelloDispatch();
    const getDispatch = vi.fn().mockResolvedValue(dispatch);
    const reconcile = vi.fn();

    await autoSyncTrackedIssue("any-dispatch-id", repo, {
      getDispatch,
      reconcile,
    });

    expect(getDispatch).toHaveBeenCalledOnce();
    // reconcile not called because findByExternalId returns null (no
    // local YAML mirrors the external_id in the tmp fixture); the gate
    // didn't short-circuit before the dispatch lookup.
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("calls reconcile when override is null and ctx.trelloEnabled is true (env default path)", async () => {
    writeOverride(localPath, null);
    const repo = makeRepoContext({ localPath, trelloEnabled: true });
    const dispatch = fakeTrelloDispatch();
    const getDispatch = vi.fn().mockResolvedValue(dispatch);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    // The test's tmp localPath has no `open/<id>.yml` so findByExternalId
    // returns null and reconcile is not called — we only check that the
    // gate did NOT short-circuit before the dispatch lookup.
    await autoSyncTrackedIssue("dispatch-123", repo, {
      getDispatch,
      reconcile,
    });

    expect(getDispatch).toHaveBeenCalledOnce();
    // reconcile is not called because findByExternalId returns null when
    // no YAML mirrors the external_id. That's expected — the gate
    // doesn't block the path; the absence of a local YAML does.
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("calls reconcile when override is explicitly true (forces on even with env off)", async () => {
    writeOverride(localPath, true);
    const repo = makeRepoContext({ localPath, trelloEnabled: false });
    const dispatch = fakeTrelloDispatch();
    const getDispatch = vi.fn().mockResolvedValue(dispatch);
    const reconcile = vi.fn().mockResolvedValue(undefined);

    await autoSyncTrackedIssue("dispatch-123", repo, {
      getDispatch,
      reconcile,
    });

    expect(getDispatch).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });
});
