/**
 * Unit tests for `autoSyncTrackedIssue` (Phase 3 of tracker-agnostic-
 * agents — Trello wsb4TVNT). Verifies AC #4: `danxbot_complete`
 * automatically calls `danx_issue_save` on the dispatch's tracked issue
 * before the agent process terminates.
 *
 * Mocks the DB lookup (`getDispatch`) + the actual sync invocation
 * (`runSync`) via the `AutoSyncDeps` injection seam, so tests don't need
 * a live MySQL pool, dispatch row, or filesystem layout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoSyncTrackedIssue } from "../../worker/auto-sync.js";
import { writeIssue } from "../../poller/yaml-lifecycle.js";
import { createEmptyIssue } from "../../issue-tracker/yaml.js";
import type { Dispatch } from "../../dashboard/dispatches.js";
import type { RepoContext } from "../../types.js";

let scratchRoot = "/tmp/test-repo";

function buildRepo(): RepoContext {
  return {
    name: "test",
    url: "",
    localPath: scratchRoot,
    workerPort: 0,
    githubToken: "",
    trello: {
      apiKey: "",
      apiToken: "",
      boardId: "",
      reviewListId: "",
      todoListId: "",
      inProgressListId: "",
      needsHelpListId: "",
      doneListId: "",
      cancelledListId: "",
      actionItemsListId: "",
      bugLabelId: "",
      featureLabelId: "",
      epicLabelId: "",
      needsHelpLabelId: "",
    },
    trelloEnabled: false,
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: {
      host: "",
      port: 0,
      user: "",
      password: "",
      database: "",
      enabled: false,
    },
  };
}

function buildTrelloRow(cardId: string): Dispatch {
  return {
    id: "job-1",
    repoName: "test",
    trigger: "trello",
    triggerMetadata: {
      cardId,
      cardName: "test card",
      cardUrl: "",
      listId: "",
      listName: "ToDo",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "running",
    startedAt: 0,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "docker",
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
  };
}

describe("autoSyncTrackedIssue", () => {
  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "danxbot-autosync-"));
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("AC #4: translates trello cardId → internal id via findByExternalId, then calls runSync", async () => {
    // Seed a YAML file on disk that maps external_id "card-99" → id "ISS-9".
    // The real findByExternalId implementation scans this dir and returns
    // the parsed issue, from which auto-sync extracts `.id`.
    const repo = buildRepo();
    const issue = {
      ...createEmptyIssue({
        id: "ISS-9",
        external_id: "card-99",
        title: "Tracked card",
      }),
    };
    writeIssue(repo.localPath, issue);

    const runSync = vi.fn().mockResolvedValue({ ok: true, errors: [] });
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-99"));
    await autoSyncTrackedIssue("job-1", repo, { getDispatch, runSync });

    expect(runSync).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledWith(
      "job-1",
      expect.any(Object),
      "ISS-9",
    );
  });

  it("skips runSync when no local YAML carries the trello cardId (no migration done)", async () => {
    // No YAML file on disk → findByExternalId returns null → no sync.
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("ghost"));
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("skips sync for slack-triggered dispatches", async () => {
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue({
      ...buildTrelloRow("ignored"),
      trigger: "slack",
      triggerMetadata: {
        channelId: "C0",
        threadTs: "0",
        messageTs: "0",
        user: "u",
        userName: null,
        messageText: "",
      },
    });
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("skips sync for api-triggered dispatches", async () => {
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue({
      ...buildTrelloRow("ignored"),
      trigger: "api",
      triggerMetadata: {
        endpoint: "/api/launch",
        callerIp: null,
        statusUrl: null,
        initialPrompt: "",
      },
    });
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("skips sync when the dispatch row is missing", async () => {
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue(null);
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("never throws when getDispatch rejects (non-fatal)", async () => {
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      autoSyncTrackedIssue("job-1", buildRepo(), { getDispatch, runSync }),
    ).resolves.toBeUndefined();
    expect(runSync).not.toHaveBeenCalled();
  });

  it("never throws when runSync rejects (non-fatal)", async () => {
    const runSync = vi.fn().mockRejectedValue(new Error("sync exploded"));
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-1"));
    await expect(
      autoSyncTrackedIssue("job-1", buildRepo(), { getDispatch, runSync }),
    ).resolves.toBeUndefined();
  });

  it("skips sync when trello dispatch row has empty cardId", async () => {
    const runSync = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue({
      ...buildTrelloRow(""),
    });
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("skips sync when trello dispatch row has missing cardId field entirely", async () => {
    const runSync = vi.fn();
    const trelloRow = buildTrelloRow("temp");
    // Strip cardId off the metadata object completely — simulates an
    // earlier-format dispatch row missing the field.
    const meta = { ...trelloRow.triggerMetadata } as Record<string, unknown>;
    delete meta.cardId;
    const getDispatch = vi.fn().mockResolvedValue({
      ...trelloRow,
      triggerMetadata: meta,
    });
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      runSync,
    });
    expect(runSync).not.toHaveBeenCalled();
  });

  it("logs but does not throw when runSync reports validation errors", async () => {
    const repo = buildRepo();
    const issue = {
      ...createEmptyIssue({
        id: "ISS-1",
        external_id: "card-1",
        title: "Tracked",
      }),
    };
    writeIssue(repo.localPath, issue);

    const runSync = vi.fn().mockResolvedValue({
      ok: false,
      errors: ["missing required field: title"],
    });
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-1"));
    await expect(
      autoSyncTrackedIssue("job-1", repo, { getDispatch, runSync }),
    ).resolves.toBeUndefined();
    expect(runSync).toHaveBeenCalledTimes(1);
  });
});
