/**
 * Tests for `runInboundFetch` — DX-220 Phase 5 cron inbound mirror.
 *
 * Covers:
 *   - DX-302 `trelloSync` short-circuit: when settings toggle is OFF,
 *     zero tracker calls fire and the function returns early.
 *   - Needs Help → ToDo move: when the latest comment on a Blocked
 *     card lacks `DANXBOT_COMMENT_MARKER`, the card moves to ToDo.
 *   - `tracker.fetchOpenCards` rejection returns empty openCards
 *     without throwing past the catch (DX-149-style isolation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueRef, IssueTracker } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";
import { DANXBOT_COMMENT_MARKER } from "../issue-tracker/markers.js";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
const findByExternalIdMock = vi.hoisted(() => vi.fn());
const hydrateFromRemoteMock = vi.hoisted(() => vi.fn());
const writeIssueMock = vi.hoisted(() => vi.fn());

vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));
vi.mock("../poller/yaml-lifecycle.js", () => ({
  findByExternalId: findByExternalIdMock,
  hydrateFromRemote: hydrateFromRemoteMock,
  writeIssue: writeIssueMock,
}));

import { runInboundFetch } from "./inbound-fetch.js";

function makeRepo(): RepoContext {
  return {
    name: "test-repo",
    url: "",
    localPath: "/tmp/test-repo",
    hostPath: "/tmp/test-repo",
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
    slack: { enabled: false, botToken: "", appToken: "", channelId: "" },
    db: { host: "", port: 0, user: "", password: "", database: "", enabled: false },
    githubToken: "",
    trelloEnabled: true,
    workerPort: 0,
    issuePrefix: "DX",
  };
}

function makeTracker(): IssueTracker {
  return {
    fetchOpenCards: vi.fn(),
    getCard: vi.fn(),
    getComments: vi.fn(),
    addComment: vi.fn(),
    editComment: vi.fn(),
    moveToStatus: vi.fn(),
    updateCard: vi.fn(),
    setLabels: vi.fn(),
    addAcItem: vi.fn(),
    updateAcItem: vi.fn(),
    deleteAcItem: vi.fn(),
    isValidExternalId: vi.fn().mockReturnValue(true),
  } as unknown as IssueTracker;
}

function makeRef(externalId: string, status: IssueRef["status"]): IssueRef {
  return {
    external_id: externalId,
    title: `card ${externalId}`,
    status,
  } as IssueRef;
}

describe("runInboundFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByExternalIdMock.mockResolvedValue(null);
    hydrateFromRemoteMock.mockResolvedValue({ id: "DX-1" });
    writeIssueMock.mockResolvedValue(undefined);
  });

  it("DX-302: when trelloSync is OFF, short-circuits with zero tracker calls", async () => {
    isFeatureEnabledMock.mockReturnValue(false);
    const tracker = makeTracker();

    const result = await runInboundFetch(makeRepo(), tracker);

    expect(result.trelloSyncEnabled).toBe(false);
    expect(result.hydrated).toEqual([]);
    expect(result.openCards).toEqual([]);
    expect(tracker.fetchOpenCards).not.toHaveBeenCalled();
    expect(tracker.getComments).not.toHaveBeenCalled();
    expect(tracker.moveToStatus).not.toHaveBeenCalled();
  });

  it("moves a Blocked card to ToDo when latest comment lacks the danxbot marker", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    const tracker = makeTracker();
    const blockedRef = makeRef("ext-1", "Blocked");
    vi.mocked(tracker.fetchOpenCards).mockResolvedValue([blockedRef]);
    vi.mocked(tracker.getComments).mockResolvedValue([
      // ascending order — last is newest.
      { id: "c1", author: "danxbot", text: `${DANXBOT_COMMENT_MARKER} earlier reply`, timestamp: "2026-01-01" },
      { id: "c2", author: "user", text: "User: please look again", timestamp: "2026-01-02" },
    ]);

    await runInboundFetch(makeRepo(), tracker);

    expect(tracker.moveToStatus).toHaveBeenCalledWith("ext-1", "ToDo");
  });

  it("does NOT move when latest comment carries the danxbot marker (still our turn)", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    const tracker = makeTracker();
    const blockedRef = makeRef("ext-1", "Blocked");
    vi.mocked(tracker.fetchOpenCards).mockResolvedValue([blockedRef]);
    vi.mocked(tracker.getComments).mockResolvedValue([
      { id: "c1", author: "danxbot", text: `${DANXBOT_COMMENT_MARKER} latest is from us`, timestamp: "2026-01-02" },
    ]);

    await runInboundFetch(makeRepo(), tracker);

    expect(tracker.moveToStatus).not.toHaveBeenCalled();
  });

  it("fetchOpenCards rejection → openCards empty, no throw past catch", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    const tracker = makeTracker();
    // checkNeedsHelp's internal fetchOpenCards: succeed with empty so we
    // reach the main fetch branch.
    vi.mocked(tracker.fetchOpenCards)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("trello 500"));

    const result = await runInboundFetch(makeRepo(), tracker);

    expect(result.openCards).toEqual([]);
    expect(result.hydrated).toEqual([]);
  });
});
