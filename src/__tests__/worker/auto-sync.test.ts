/**
 * Unit tests for `autoSyncTrackedIssue` (Phase 3 of tracker-agnostic-
 * agents — Trello wsb4TVNT). Verifies that `danxbot_complete`
 * automatically pushes the dispatch's tracked issue YAML to the tracker
 * before the agent process terminates. DX-157 made this the SOLE
 * agent-driven post-edit tracker push (the legacy save HTTP route was
 * retired); the chokidar watcher mirrors agent edits to the DB on every
 * file write, while this auto-sync runs once on `danxbot_complete` to
 * cut the up-to-60s tracker lag the per-tick poller mirror would
 * otherwise produce.
 *
 * Mocks the DB lookup (`getDispatch`) + the actual sync invocation
 * (`runSync`) via the `AutoSyncDeps` injection seam, so tests don't need
 * a live MySQL pool, dispatch row, or filesystem layout.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { autoSyncTrackedIssue } from "../../worker/auto-sync.js";
import { writeIssue } from "../../poller/yaml-lifecycle.js";
import { createEmptyIssue } from "../../issue-tracker/yaml.js";
import { canonicalize, sha256 } from "../../db/canonicalize.js";
import { createTestDb, type TestDbHandle } from "../../db/test-db.js";
import { up as upIssuesMirror } from "../../db/migrations/016_issues_mirror.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "../../poller/issues-db.js";
import { clearAllRepoNames, setRepoName } from "../../poller/repo-name.js";
import type { Issue } from "../../issue-tracker/interface.js";
import type { Dispatch } from "../../dashboard/dispatches.js";
import type { RepoContext } from "../../types.js";

let scratchRoot = "/tmp/test-repo";

const TEST_REPO_NAME = "auto-sync-test-repo";

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[auto-sync] skipping DB-backed assertions — local Postgres not reachable",
  );
} else {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await upIssuesMirror(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

afterAll(async () => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
  if (handle) await handle.close();
});

if (handle) {
  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await handle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
  });
}

async function seedDb(issue: Issue): Promise<void> {
  if (!handle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  await handle.pool.query(
    `INSERT INTO issues (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, now())`,
    [TEST_REPO_NAME, JSON.stringify(data), contentHash],
  );
}

function buildRepo(): RepoContext {
  return {
    name: "test",
    url: "",
    localPath: scratchRoot,
    hostPath: scratchRoot,
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
      blockedLabelId: "",
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
    issuePrefix: "ISS",
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
    issueId: null,
    status: "running",
    startedAt: 0,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "docker",
    hostPid: process.pid,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    mcpSettingsPath: null,
  };
}

describe("autoSyncTrackedIssue", () => {
  beforeEach(async () => {
    scratchRoot = mkdtempSync(join(tmpdir(), "danxbot-autosync-"));
    if (handle) {
      await handle.pool.query("DELETE FROM issues");
      setRepoName(scratchRoot, TEST_REPO_NAME);
    }
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it.skipIf(!handle)(
    "AC #4: translates trello cardId → internal id via findByExternalId, then calls runSync",
    async () => {
    // Seed an `issues` row that maps external_id "card-99" → id "ISS-9".
    // findByExternalId queries the DB by repo_name + external_id and
    // auto-sync extracts `.id` from the resulting Issue.
    const repo = buildRepo();
    const issue = {
      ...createEmptyIssue({
        id: "ISS-9",
        external_id: "card-99",
        title: "Tracked card",
      }),
    };
    await seedDb(issue);
    void writeIssue;

    const reconcile = vi.fn().mockResolvedValue(undefined);
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-99"));
    await autoSyncTrackedIssue("job-1", repo, { getDispatch, reconcile });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test", localPath: scratchRoot }),
      "ISS-9",
      "lifecycle",
    );
    },
  );

  it("skips runSync when no local YAML carries the trello cardId (no migration done)", async () => {
    // No YAML file on disk → findByExternalId returns null → no sync.
    const reconcile = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("ghost"));
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips sync for slack-triggered dispatches", async () => {
    const reconcile = vi.fn();
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
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips sync for api-triggered dispatches", async () => {
    const reconcile = vi.fn();
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
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips sync when the dispatch row is missing", async () => {
    const reconcile = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue(null);
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("never throws when getDispatch rejects (non-fatal)", async () => {
    const reconcile = vi.fn();
    const getDispatch = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      autoSyncTrackedIssue("job-1", buildRepo(), { getDispatch, reconcile }),
    ).resolves.toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("never throws when runSync rejects (non-fatal)", async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error("sync exploded"));
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-1"));
    await expect(
      autoSyncTrackedIssue("job-1", buildRepo(), { getDispatch, reconcile }),
    ).resolves.toBeUndefined();
  });

  it("skips sync when trello dispatch row has empty cardId", async () => {
    const reconcile = vi.fn();
    const getDispatch = vi.fn().mockResolvedValue({
      ...buildTrelloRow(""),
    });
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips sync when trello dispatch row has missing cardId field entirely", async () => {
    const reconcile = vi.fn();
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
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.skipIf(!handle)(
    "logs but does not throw when runSync reports validation errors",
    async () => {
    const repo = buildRepo();
    const issue = {
      ...createEmptyIssue({
        id: "ISS-1",
        external_id: "card-1",
        title: "Tracked",
      }),
    };
    await seedDb(issue);

    const reconcile = vi.fn().mockResolvedValue({
      ok: false,
      errors: ["missing required field: title"],
    });
    const getDispatch = vi.fn().mockResolvedValue(buildTrelloRow("card-1"));
    await expect(
      autoSyncTrackedIssue("job-1", repo, { getDispatch, reconcile }),
    ).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    },
  );
});
