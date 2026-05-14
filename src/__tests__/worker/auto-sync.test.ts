/**
 * Integration tests for `autoSyncTrackedIssue` — the post-dispatch
 * reconcile fired from `handleStop` on every dispatch terminal state.
 * See `src/worker/auto-sync.ts` module header for the decoupling
 * invariant (Trello is NOT consulted at this layer; this module runs
 * for every dispatch carrying an `issueId` regardless of trigger source
 * or `trelloSync` setting).
 *
 * The unit-level mock coverage lives at `src/worker/auto-sync.test.ts`.
 * This file adds DB-backed assertions: with a real `issues` row in the
 * mirror table, confirm `reconcileIssue` is invoked with the
 * dispatch row's `issueId` directly (no `findByExternalId` translation —
 * that step was removed when the Trello-trigger filter was dropped).
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
      requiresHumanLabelId: "",
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

function buildDispatchRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-1",
    repoName: "test",
    trigger: "trello",
    triggerMetadata: {
      cardId: "card-99",
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
    issueId: "ISS-9",
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
    recoverCount: 0,
    parentRecoverId: null,
    ...overrides,
  } as Dispatch;
}

describe("autoSyncTrackedIssue (DB-backed)", () => {
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
    "calls reconcile with the dispatch row's issueId directly (no external-id translation)",
    async () => {
      // Seed an `issues` row so the mirror has something to reconcile
      // against. Auto-sync no longer reads `triggerMetadata.cardId` —
      // it reads `dispatch.issueId` and hands it straight to reconcile.
      const repo = buildRepo();
      const issue = {
        ...createEmptyIssue({
          id: "ISS-9",
          external_id: "card-99",
          title: "Tracked card",
        }),
      };
      await seedDb(issue);

      const reconcile = vi.fn().mockResolvedValue(undefined);
      const getDispatch = vi.fn().mockResolvedValue(buildDispatchRow());

      await autoSyncTrackedIssue("job-1", repo, { getDispatch, reconcile });

      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ name: "test", localPath: scratchRoot }),
        "ISS-9",
        "lifecycle",
      );
    },
  );

  it("decoupling invariant: Slack-triggered dispatches with an issueId DO reconcile", async () => {
    // Pre-decoupling, this module short-circuited on `trigger !== 'trello'`.
    // Post-decoupling, every dispatch carrying an `issueId` reconciles —
    // a Slack-routed deep-agent that worked on a card is no different
    // from a Trello-routed one once the work is done.
    const repo = buildRepo();
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const getDispatch = vi.fn().mockResolvedValue(
      buildDispatchRow({
        trigger: "slack",
        triggerMetadata: {
          channelId: "C0",
          threadTs: "0",
          messageTs: "0",
          user: "u",
          userName: null,
          messageText: "",
        },
        issueId: "ISS-42",
      }),
    );
    await autoSyncTrackedIssue("job-1", repo, { getDispatch, reconcile });
    expect(reconcile).toHaveBeenCalledWith(
      expect.any(Object),
      "ISS-42",
      "lifecycle",
    );
  });

  it("decoupling invariant: api-triggered dispatches with an issueId DO reconcile", async () => {
    const repo = buildRepo();
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const getDispatch = vi.fn().mockResolvedValue(
      buildDispatchRow({
        trigger: "api",
        triggerMetadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "",
        },
        issueId: "ISS-7",
      }),
    );
    await autoSyncTrackedIssue("job-1", repo, { getDispatch, reconcile });
    expect(reconcile).toHaveBeenCalledWith(
      expect.any(Object),
      "ISS-7",
      "lifecycle",
    );
  });

  it("skips reconcile when dispatch row has no issueId (Slack chat / board-chat / ideator runs)", async () => {
    const reconcile = vi.fn();
    const getDispatch = vi
      .fn()
      .mockResolvedValue(buildDispatchRow({ issueId: null }));
    await autoSyncTrackedIssue("job-1", buildRepo(), {
      getDispatch,
      reconcile,
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("skips reconcile when the dispatch row is missing", async () => {
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

  it("never throws when reconcile rejects (non-fatal — tracker hiccup must not stall terminal state)", async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error("sync exploded"));
    const getDispatch = vi.fn().mockResolvedValue(buildDispatchRow());
    await expect(
      autoSyncTrackedIssue("job-1", buildRepo(), { getDispatch, reconcile }),
    ).resolves.toBeUndefined();
  });
});
