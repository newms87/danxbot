import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushPromises } from "@vue/test-utils";

const COMPOSABLE_SOURCE_PATH = resolve(
  __dirname,
  "useTrelloListMapping.ts",
);

// ── Mocks ────────────────────────────────────────────────────────────

const mockFetchListMapping = vi.fn();
const mockFetchBoardLists = vi.fn();
const mockPatchListMapping = vi.fn();

vi.mock("../api", () => ({
  fetchTrelloListMapping: (...args: unknown[]) => mockFetchListMapping(...args),
  fetchTrelloBoardLists: (...args: unknown[]) => mockFetchBoardLists(...args),
  patchTrelloListMapping: (...args: unknown[]) => mockPatchListMapping(...args),
}));

// In-test SSE bridge — exposes a `publish` we call to deliver a synthetic
// `trello-list-map:updated` event into the composable's stream handler.
type StreamHandler = (event: { topic: string; data: unknown }) => void;
const handlers: Set<StreamHandler> = new Set();

vi.mock("./useStream", async () => {
  const actual = await vi.importActual<typeof import("./useStream")>(
    "./useStream",
  );
  return {
    ...actual,
    useStream: () => ({
      connectionState: { value: "connected" },
      subscribe: (_topic: string, handler: StreamHandler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      disconnect: () => undefined,
    }),
  };
});

function deliverSse(data: unknown): void {
  for (const h of [...handlers]) h({ topic: "trello-list-map:updated", data });
}

import {
  useTrelloListMapping,
  __resetSharedTrelloListMappingForTesting,
} from "./useTrelloListMapping";

const SEED_RESPONSE = {
  map: { list_id_to_trello_list_id: { "l-review": "tl1" } },
  classification: {
    "l-review": {
      status: "mapped" as const,
      trello_list_id: "tl1",
      trello_list_name: "Review on board",
    },
    "l-todo": { status: "unmapped" as const },
    "l-blocked": {
      status: "orphaned" as const,
      trello_list_id: "tl-dead",
    },
  },
  trello_available: true,
  board_configured: true,
};

beforeEach(() => {
  handlers.clear();
  __resetSharedTrelloListMappingForTesting();
  mockFetchListMapping.mockReset();
  mockFetchBoardLists.mockReset();
  mockPatchListMapping.mockReset();
  // Default board-lists resolver — every test gets a benign cached
  // payload. Individual tests can override with mockResolvedValueOnce.
  mockFetchBoardLists.mockResolvedValue([]);
});

describe("useTrelloListMapping", () => {
  it("source MUST NOT use setInterval (SSE-only per dashboard.md mandate)", () => {
    const source = readFileSync(COMPOSABLE_SOURCE_PATH, "utf-8");
    expect(source).not.toMatch(/setInterval\s*\(/);
  });

  it("init() hydrates BOTH mapping AND board lists in parallel (S1 fix)", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl1", name: "Review on board" },
      { id: "tl2", name: "Doing" },
    ]);
    const { init, destroy, mapping, boardLists, loading, error } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
    expect(mockFetchListMapping).toHaveBeenCalledWith("danxbot");
    // Default-cached path — no `{refresh: true}` here.
    expect(mockFetchBoardLists).toHaveBeenCalledWith("danxbot");
    expect(mapping.value?.board_configured).toBe(true);
    expect(boardLists.value).toEqual([
      { id: "tl1", name: "Review on board" },
      { id: "tl2", name: "Doing" },
    ]);
    destroy();
  });

  it("SSE trello-list-map:updated re-renders the map without re-fetching", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    const { init, destroy, mapping } = useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    expect(mapping.value?.map.list_id_to_trello_list_id["l-review"]).toBe(
      "tl1",
    );
    deliverSse({
      repoName: "danxbot",
      map: { list_id_to_trello_list_id: { "l-todo": "tl-new" } },
    });
    expect(mockFetchListMapping).toHaveBeenCalledTimes(1);
    expect(
      mapping.value?.map.list_id_to_trello_list_id["l-todo"],
    ).toBe("tl-new");
    expect(
      mapping.value?.map.list_id_to_trello_list_id["l-review"],
    ).toBeUndefined();
    destroy();
  });

  it("SSE event for a DIFFERENT repo is ignored", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    const { init, destroy, mapping } = useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    deliverSse({
      repoName: "platform",
      map: { list_id_to_trello_list_id: { foo: "bar" } },
    });
    expect(
      mapping.value?.map.list_id_to_trello_list_id["l-review"],
    ).toBe("tl1");
    destroy();
  });

  it("save() PATCHes the map then updates local state without a re-fetch", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    const next = { list_id_to_trello_list_id: { "l-todo": "tl-other" } };
    mockPatchListMapping.mockResolvedValueOnce(next);
    const { init, destroy, save, mapping } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    await save(next);
    expect(mockPatchListMapping).toHaveBeenCalledWith("danxbot", next);
    expect(mockFetchListMapping).toHaveBeenCalledTimes(1);
    expect(mapping.value?.map).toEqual(next);
  });

  it("refetchBoardLists() calls fetchTrelloBoardLists with refresh + re-runs hydrate", async () => {
    mockFetchListMapping.mockResolvedValue(SEED_RESPONSE);
    mockFetchBoardLists.mockReset();
    mockFetchBoardLists.mockResolvedValueOnce([]); // init() cached fetch
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl1", name: "Review on board" },
    ]); // refetchBoardLists explicit refresh
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl1", name: "Review on board" },
    ]); // hydrate's parallel default-cache fetch
    const { init, destroy, refetchBoardLists, boardLists } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    await refetchBoardLists();
    expect(mockFetchBoardLists).toHaveBeenCalledWith("danxbot", {
      refresh: true,
    });
    expect(mockFetchListMapping).toHaveBeenCalledTimes(2);
    expect(boardLists.value).toEqual([
      { id: "tl1", name: "Review on board" },
    ]);
    destroy();
  });

  it("init() surfaces fetch errors on error.value without throwing", async () => {
    mockFetchListMapping.mockRejectedValueOnce(new Error("boom"));
    const { init, destroy, error, loading } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    expect(loading.value).toBe(false);
    expect(error.value).toBe("boom");
    destroy();
  });

  it("save() failure sets error, leaves saving=false, preserves prior map, re-throws", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    mockPatchListMapping.mockRejectedValueOnce(new Error("400 invalid"));
    const { init, destroy, save, mapping, error, saving } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    const priorMap = mapping.value?.map;
    await expect(
      save({ list_id_to_trello_list_id: { "l-todo": "tl-x" } }),
    ).rejects.toThrow("400 invalid");
    expect(saving.value).toBe(false);
    expect(error.value).toBe("400 invalid");
    expect(mapping.value?.map).toBe(priorMap);
    destroy();
  });

  it("DX-688: two facades for the same repo fire ONE fetchTrelloListMapping + ONE fetchTrelloBoardLists call", async () => {
    mockFetchListMapping.mockResolvedValue(SEED_RESPONSE);
    mockFetchBoardLists.mockReset();
    mockFetchBoardLists.mockResolvedValue([
      { id: "tl1", name: "Review on board" },
    ]);

    const a = useTrelloListMapping("danxbot");
    const b = useTrelloListMapping("danxbot");
    a.init();
    b.init();
    await flushPromises();
    await flushPromises();

    expect(mockFetchListMapping).toHaveBeenCalledTimes(1);
    expect(mockFetchBoardLists).toHaveBeenCalledTimes(1);
    // Both facades observe the same data.
    expect(a.mapping.value?.board_configured).toBe(true);
    expect(b.mapping.value?.board_configured).toBe(true);
    expect(a.boardLists.value).toEqual([
      { id: "tl1", name: "Review on board" },
    ]);
    expect(b.boardLists.value).toEqual([
      { id: "tl1", name: "Review on board" },
    ]);

    a.destroy();
    b.destroy();
  });

  it("DX-688: different repos still get independent fetches + subscriptions", async () => {
    mockFetchListMapping.mockResolvedValue(SEED_RESPONSE);

    const a = useTrelloListMapping("danxbot");
    const b = useTrelloListMapping("platform");
    a.init();
    b.init();
    await flushPromises();
    await flushPromises();

    expect(mockFetchListMapping).toHaveBeenCalledTimes(2);
    expect(mockFetchListMapping).toHaveBeenCalledWith("danxbot");
    expect(mockFetchListMapping).toHaveBeenCalledWith("platform");
    expect(mockFetchBoardLists).toHaveBeenCalledTimes(2);

    a.destroy();
    b.destroy();
  });

  it("DX-688: partial destroy keeps shared alive; full destroy + re-init re-fetches", async () => {
    mockFetchListMapping.mockResolvedValue(SEED_RESPONSE);

    const a = useTrelloListMapping("danxbot");
    const b = useTrelloListMapping("danxbot");
    a.init();
    b.init();
    await flushPromises();
    await flushPromises();
    expect(mockFetchListMapping).toHaveBeenCalledTimes(1);

    // Partial destroy — second facade still alive, no fresh fetch.
    a.destroy();
    expect(b.mapping.value?.board_configured).toBe(true);

    // SSE still wired up — b receives the live update.
    deliverSse({
      repoName: "danxbot",
      map: { list_id_to_trello_list_id: { "l-todo": "tl-live" } },
    });
    expect(
      b.mapping.value?.map.list_id_to_trello_list_id["l-todo"],
    ).toBe("tl-live");

    // Full destroy — fresh init should re-fetch.
    b.destroy();
    const c = useTrelloListMapping("danxbot");
    c.init();
    await flushPromises();
    await flushPromises();
    expect(mockFetchListMapping).toHaveBeenCalledTimes(2);
    c.destroy();
  });

  it("save() in-flight guard — second save call while first is pending is a no-op", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    let resolveFirstPatch!: (v: { list_id_to_trello_list_id: Record<string, string> }) => void;
    mockPatchListMapping.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirstPatch = res;
        }),
    );
    const { init, destroy, save, saving } = useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    void save({ list_id_to_trello_list_id: { "l-todo": "tl-a" } });
    await Promise.resolve();
    expect(saving.value).toBe(true);
    // Second call while saving=true must NOT trigger another PATCH.
    await save({ list_id_to_trello_list_id: { "l-todo": "tl-b" } });
    expect(mockPatchListMapping).toHaveBeenCalledTimes(1);
    // Resolve the first to leave saving in a clean state.
    resolveFirstPatch({ list_id_to_trello_list_id: { "l-todo": "tl-a" } });
    await flushPromises();
    expect(saving.value).toBe(false);
    destroy();
  });

  it("saving ref is per-repo (cross-repo isolation)", async () => {
    mockFetchListMapping.mockResolvedValue(SEED_RESPONSE);
    let resolvePatch!: (v: { list_id_to_trello_list_id: Record<string, string> }) => void;
    mockPatchListMapping.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolvePatch = res;
        }),
    );
    const a = useTrelloListMapping("repo-a");
    const b = useTrelloListMapping("repo-b");
    a.init();
    b.init();
    await flushPromises();
    await flushPromises();
    void a.save({ list_id_to_trello_list_id: { "l-todo": "tl-a" } });
    await Promise.resolve();
    expect(a.saving.value).toBe(true);
    expect(b.saving.value).toBe(false);
    resolvePatch({ list_id_to_trello_list_id: { "l-todo": "tl-a" } });
    await flushPromises();
    a.destroy();
    b.destroy();
  });

  it("refetchBoardLists failure sets error and skips the follow-up hydrate", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl1", name: "Review on board" },
    ]);
    const { init, destroy, refetchBoardLists, error, boardLists } =
      useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    const fetchListMappingCallsBefore = mockFetchListMapping.mock.calls.length;
    const priorBoardLists = boardLists.value;
    // Re-fetch fails.
    mockFetchBoardLists.mockRejectedValueOnce(new Error("trello-503"));
    await refetchBoardLists();
    expect(error.value).toBe("trello-503");
    // No follow-up mapping re-hydrate fires when the refetch errors.
    expect(mockFetchListMapping.mock.calls.length).toBe(
      fetchListMappingCallsBefore,
    );
    // boardLists is left untouched.
    expect(boardLists.value).toBe(priorBoardLists);
    destroy();
  });

  it("SSE update preserves classification + trello_available + board_configured (only `map` mutates)", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    const { init, destroy, mapping } = useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    const classificationBefore = mapping.value?.classification;
    const trelloAvailableBefore = mapping.value?.trello_available;
    const boardConfiguredBefore = mapping.value?.board_configured;
    deliverSse({
      repoName: "danxbot",
      map: { list_id_to_trello_list_id: { "l-blocked": "tl-fresh" } },
    });
    expect(
      mapping.value?.map.list_id_to_trello_list_id["l-blocked"],
    ).toBe("tl-fresh");
    // Non-map fields untouched.
    expect(mapping.value?.classification).toBe(classificationBefore);
    expect(mapping.value?.trello_available).toBe(trelloAvailableBefore);
    expect(mapping.value?.board_configured).toBe(boardConfiguredBefore);
    destroy();
  });

  it("malformed SSE payload is dropped via runtime guard (does NOT clobber mapping)", async () => {
    mockFetchListMapping.mockResolvedValueOnce(SEED_RESPONSE);
    const { init, destroy, mapping } = useTrelloListMapping("danxbot");
    init();
    await flushPromises();
    await flushPromises();
    const before = mapping.value?.map;
    // Multiple shapes the guard must reject without throwing:
    deliverSse(null);
    deliverSse({ repoName: "danxbot" }); // missing map
    deliverSse({ repoName: "danxbot", map: null });
    deliverSse({ repoName: "danxbot", map: { wrong_key: 1 } });
    expect(mapping.value?.map).toBe(before);
    destroy();
  });
});
