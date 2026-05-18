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

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
const findByExternalIdMock = vi.hoisted(() => vi.fn());
const hydrateFromRemoteMock = vi.hoisted(() => vi.fn());
const writeIssueMock = vi.hoisted(() => vi.fn());
const readListsMock = vi.hoisted(() => vi.fn());
const getDefaultListForTypeMock = vi.hoisted(() => vi.fn());
const readTrelloListMapMock = vi.hoisted(() => vi.fn());
const recordSystemErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../settings-file.js", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));
vi.mock("../poller/yaml-lifecycle.js", () => ({
  findByExternalId: findByExternalIdMock,
  hydrateFromRemote: hydrateFromRemoteMock,
  writeIssue: writeIssueMock,
}));
vi.mock("../lists-file.js", () => ({
  readLists: readListsMock,
  getDefaultListForType: getDefaultListForTypeMock,
}));
vi.mock("../trello-list-map.js", async () => {
  const actual = await vi.importActual<typeof import("../trello-list-map.js")>(
    "../trello-list-map.js",
  );
  return {
    ...actual,
    readTrelloListMap: readTrelloListMapMock,
  };
});
vi.mock("../dashboard/system-errors.js", () => ({
  recordSystemError: recordSystemErrorMock,
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
    moveToList: vi.fn(),
    updateCard: vi.fn(),
    setLabels: vi.fn(),
    addAcItem: vi.fn(),
    updateAcItem: vi.fn(),
    deleteAcItem: vi.fn(),
  } as unknown as IssueTracker;
}

function makeRef(externalId: string, externalListId = ""): IssueRef {
  return {
    id: "",
    external_id: externalId,
    title: `card ${externalId}`,
    external_list_id: externalListId,
  };
}

// DX-621 — checkNeedsHelp needs blocked + ready default lists mapped to
// Trello list ids. Test setup helper that wires both mocks in lockstep.
describe("runInboundFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findByExternalIdMock.mockResolvedValue(null);
    hydrateFromRemoteMock.mockResolvedValue({ id: "DX-1", list_name: null });
    writeIssueMock.mockResolvedValue(undefined);
    readListsMock.mockReturnValue({ lists: [], tombstone_ids: [] });
    readTrelloListMapMock.mockReturnValue({ list_id_to_trello_list_id: {} });
    getDefaultListForTypeMock.mockReturnValue({ id: "default-review", name: "Review" });
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
    expect(tracker.moveToList).not.toHaveBeenCalled();
  });

  // DX-658 — `checkNeedsHelp` is a no-op now; the `"blocked"` ListType
  // was retired and Blocked cards no longer get auto-moved from a
  // Blocked list to a ToDo list when the latest comment lacks the
  // danxbot marker. The two tests covering that behavior were removed
  // because `seedMappedLists` itself relied on the retired
  // `type: "blocked"` list seed.

  it("DX-619: hydrates with list_name resolved via reverse-map (mapped trello list)", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    readListsMock.mockReturnValue({
      lists: [
        { id: "in-prog-id", name: "In Progress", type: "in_progress", order: 0, is_default_for_type: true, color: "#f59e0b" },
      ],
      tombstone_ids: [],
    });
    readTrelloListMapMock.mockReturnValue({
      list_id_to_trello_list_id: { "in-prog-id": "trello-ip" },
    });

    const issue: { id: string; list_name: string | null } = { id: "DX-1", list_name: null };
    hydrateFromRemoteMock.mockResolvedValue(issue);

    const tracker = makeTracker();
    vi.mocked(tracker.fetchOpenCards)
      .mockResolvedValue([makeRef("ext-1", "trello-ip")]);

    await runInboundFetch(makeRepo(), tracker);

    expect(writeIssueMock).toHaveBeenCalledTimes(1);
    const written = writeIssueMock.mock.calls[0][1];
    expect(written.list_name).toBe("In Progress");
    expect(recordSystemErrorMock).not.toHaveBeenCalled();
  });

  it("DX-619: unmapped trello list → list_name defaults to Review list", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    readListsMock.mockReturnValue({
      lists: [
        { id: "rev-id", name: "Review", type: "review", order: 0, is_default_for_type: true, color: "#3b82f6" },
      ],
      tombstone_ids: [],
    });
    readTrelloListMapMock.mockReturnValue({ list_id_to_trello_list_id: {} });
    getDefaultListForTypeMock.mockReturnValue({
      id: "rev-id",
      name: "Review",
      type: "review",
      order: 0,
      is_default_for_type: true,
      color: "#3b82f6",
    });

    const issue: { id: string; list_name: string | null } = { id: "DX-1", list_name: null };
    hydrateFromRemoteMock.mockResolvedValue(issue);

    const tracker = makeTracker();
    vi.mocked(tracker.fetchOpenCards)
      .mockResolvedValue([makeRef("ext-1", "trello-unknown")]);

    await runInboundFetch(makeRepo(), tracker);

    expect(writeIssueMock).toHaveBeenCalledTimes(1);
    expect(writeIssueMock.mock.calls[0][1].list_name).toBe("Review");
    expect(getDefaultListForTypeMock).toHaveBeenCalledWith(expect.any(String), "review");
  });

  it("DX-619: ambiguous reverse map → picks first lists.yaml match, logs system error", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    readListsMock.mockReturnValue({
      lists: [
        { id: "first-id", name: "ToDo Alpha", type: "ready", order: 0, is_default_for_type: true, color: "#22d3ee" },
        { id: "second-id", name: "ToDo Beta", type: "ready", order: 1, is_default_for_type: false, color: "#22d3ee" },
      ],
      tombstone_ids: [],
    });
    readTrelloListMapMock.mockReturnValue({
      list_id_to_trello_list_id: {
        "first-id": "trello-shared",
        "second-id": "trello-shared",
      },
    });

    const issue: { id: string; list_name: string | null } = { id: "DX-1", list_name: null };
    hydrateFromRemoteMock.mockResolvedValue(issue);

    const tracker = makeTracker();
    vi.mocked(tracker.fetchOpenCards)
      .mockResolvedValue([makeRef("ext-1", "trello-shared")]);

    await runInboundFetch(makeRepo(), tracker);

    expect(writeIssueMock).toHaveBeenCalledTimes(1);
    expect(writeIssueMock.mock.calls[0][1].list_name).toBe("ToDo Alpha");
    expect(recordSystemErrorMock).toHaveBeenCalledTimes(1);
    const call = recordSystemErrorMock.mock.calls[0][0];
    expect(call.source).toBe("trello-list-mapping");
    expect(call.severity).toBe("warn");
    expect(call.message).toContain("trello-shared");
  });

  it("DX-619: missing external_list_id on ref (legacy tracker) → falls back to Review", async () => {
    isFeatureEnabledMock.mockReturnValue(true);
    getDefaultListForTypeMock.mockReturnValue({
      id: "rev-id",
      name: "Review",
      type: "review",
      order: 0,
      is_default_for_type: true,
      color: "#3b82f6",
    });

    const issue: { id: string; list_name: string | null } = { id: "DX-1", list_name: null };
    hydrateFromRemoteMock.mockResolvedValue(issue);

    const tracker = makeTracker();
    vi.mocked(tracker.fetchOpenCards)
      .mockResolvedValue([makeRef("ext-1", undefined)]);

    await runInboundFetch(makeRepo(), tracker);

    expect(writeIssueMock).toHaveBeenCalledTimes(1);
    expect(writeIssueMock.mock.calls[0][1].list_name).toBe("Review");
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
