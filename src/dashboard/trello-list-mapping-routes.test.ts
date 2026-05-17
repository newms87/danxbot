import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Auth mock — Bearer "user-<name>" passes, everything else 401.
vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t || !t.startsWith("user-")) return { ok: false, status: 401 };
    return { ok: true, user: { userId: 1, username: t.slice("user-".length) } };
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockEventBusPublish(...args) },
}));

const mockFetchBoardLists = vi.hoisted(() => vi.fn());
const mockCreateList = vi.hoisted(() => vi.fn());
vi.mock("./trello-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./trello-api.js")>();
  return {
    ...actual,
    fetchBoardLists: mockFetchBoardLists,
    createList: mockCreateList,
  };
});

import {
  _resetBoardListCache,
  handleGetBoardLists,
  handleGetListMapping,
  handlePatchListMapping,
  handlePostBootstrapBacklog,
} from "./trello-list-mapping-routes.js";
import {
  _resetForTesting as resetListsForTesting,
  ensureListsFile,
} from "../lists-file.js";
import {
  _resetForTesting as resetTrelloListMapForTesting,
  readTrelloListMap,
} from "../trello-list-map.js";
import { TrelloApiError } from "./trello-api.js";
import {
  createMockReq,
  createMockReqWithBody,
  createMockRes,
  type MockResponse,
} from "../__tests__/helpers/http-mocks.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import type { RepoConfig } from "../types.js";

let tmpRoot: string;
let repoLocalPath: string;
let deps: DispatchProxyDeps;
let danxbotListIds: string[];

function makeDeps(): DispatchProxyDeps {
  const repos: RepoConfig[] = [
    {
      name: "danxbot",
      url: "https://example/danxbot.git",
      localPath: repoLocalPath,
      hostPath: repoLocalPath,
      workerPort: 5562,
    },
  ];
  return { token: "test-token", repos, resolveHost: () => "127.0.0.1" };
}

function writeTrelloYml(boardId: string | null): void {
  const dir = resolve(repoLocalPath, ".danxbot", "config");
  mkdirSync(dir, { recursive: true });
  // parseSimpleYaml requires section-nested indentation; flat dotted
  // keys like `lists.review:` are silently skipped.
  const lines = [
    boardId === null ? "" : `board_id: ${boardId}`,
    "lists:",
    "  review: lr",
    "  todo: lt",
    "  in_progress: li",
    "  needs_help: ln",
    "  done: ld",
    "  cancelled: lc",
    "  action_items: la",
    "labels:",
    "  bug: bL",
    "  feature: fL",
    "  epic: eL",
    "  needs_help: nL",
    "  blocked: blL",
  ];
  writeFileSync(resolve(dir, "trello.yml"), lines.filter((l) => l !== "").join("\n") + "\n");
}

function authedReq(method: string, body?: Record<string, unknown>) {
  const req = body ? createMockReqWithBody(method, body) : createMockReq(method, "/");
  req.headers = { authorization: "Bearer user-alice" };
  return req;
}

function unauthedReq(method: string, body?: Record<string, unknown>) {
  return body ? createMockReqWithBody(method, body) : createMockReq(method, "/");
}

beforeEach(async () => {
  resetListsForTesting();
  resetTrelloListMapForTesting();
  _resetBoardListCache();
  mockEventBusPublish.mockClear();
  mockFetchBoardLists.mockReset();
  mockCreateList.mockReset();
  tmpRoot = mkdtempSync(resolve(tmpdir(), "trello-list-mapping-test-"));
  repoLocalPath = resolve(tmpRoot, "danxbot");
  mkdirSync(resolve(repoLocalPath, ".danxbot"), { recursive: true });
  await ensureListsFile(repoLocalPath);
  danxbotListIds = readListsIdsFromDisk();
  writeTrelloYml("board-1");
  deps = makeDeps();
  // Default env vars present — overridden per test as needed.
  process.env.DASHBOARD_TRELLO_API_KEY = "k";
  process.env.DASHBOARD_TRELLO_API_TOKEN = "t";
});

afterEach(() => {
  delete process.env.DASHBOARD_TRELLO_API_KEY;
  delete process.env.DASHBOARD_TRELLO_API_TOKEN;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function readListsIdsFromDisk(): string[] {
  // ensureListsFile seeds defaults — pull their ids so we can build a
  // realistic map for the tests.
  return readListsFile().ids;
}

function readListsFile(): { ids: string[] } {
  const yml = require("yaml").parse(
    require("node:fs").readFileSync(
      resolve(repoLocalPath, ".danxbot", "lists.yaml"),
      "utf-8",
    ),
  ) as { lists: Array<{ id: string }> };
  return { ids: yml.lists.map((l) => l.id) };
}

function archivedDefaultListId(): string {
  const yml = require("yaml").parse(
    require("node:fs").readFileSync(
      resolve(repoLocalPath, ".danxbot", "lists.yaml"),
      "utf-8",
    ),
  ) as {
    lists: Array<{ id: string; type: string; is_default_for_type: boolean }>;
  };
  const archived = yml.lists.find(
    (l) => l.type === "archived" && l.is_default_for_type,
  );
  if (!archived) throw new Error("seed missing archived default");
  return archived.id;
}

describe("GET /api/trello/board-lists", () => {
  it("401 without bearer", async () => {
    const res: MockResponse = createMockRes();
    await handleGetBoardLists(unauthedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns lists on happy path", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl1", name: "ToDo" },
      { id: "tl2", name: "Done" },
    ]);
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      lists: [
        { id: "tl1", name: "ToDo" },
        { id: "tl2", name: "Done" },
      ],
    });
  });

  it("503 when board not configured", async () => {
    writeTrelloYml(null);
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(503);
  });

  it("503 when creds missing", async () => {
    delete process.env.DASHBOARD_TRELLO_API_KEY;
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(503);
  });

  it("502 on Trello upstream error with trello_status", async () => {
    mockFetchBoardLists.mockRejectedValueOnce(new TrelloApiError("upstream 403", 403));
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(502);
    const body = JSON.parse(res._getBody());
    expect(body.trello_status).toBe(403);
  });

  it("caches results for 30s within a single repo", async () => {
    mockFetchBoardLists.mockResolvedValue([{ id: "tl1", name: "ToDo" }]);
    await handleGetBoardLists(authedReq("GET"), createMockRes(), "danxbot", deps);
    await handleGetBoardLists(authedReq("GET"), createMockRes(), "danxbot", deps);
    expect(mockFetchBoardLists).toHaveBeenCalledTimes(1);
  });

  it("refresh=true bypasses the 30s cache (Settings Re-fetch button)", async () => {
    mockFetchBoardLists.mockResolvedValue([{ id: "tl1", name: "ToDo" }]);
    await handleGetBoardLists(authedReq("GET"), createMockRes(), "danxbot", deps);
    await handleGetBoardLists(
      authedReq("GET"),
      createMockRes(),
      "danxbot",
      deps,
      { refresh: true },
    );
    expect(mockFetchBoardLists).toHaveBeenCalledTimes(2);
  });

  it("400 missing repo query", async () => {
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, null, deps);
    expect(res._getStatusCode()).toBe(400);
  });

  it("404 unknown repo", async () => {
    const res = createMockRes();
    await handleGetBoardLists(authedReq("GET"), res, "nonexistent", deps);
    expect(res._getStatusCode()).toBe(404);
  });
});

describe("GET /api/trello/list-mapping", () => {
  it("401 without bearer", async () => {
    const res = createMockRes();
    await handleGetListMapping(unauthedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns empty map + all unmapped when nothing configured", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([]);
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.map).toEqual({ list_id_to_trello_list_id: {} });
    expect(Object.keys(body.classification).length).toBe(danxbotListIds.length);
    for (const id of danxbotListIds) {
      expect(body.classification[id].status).toBe("unmapped");
    }
    expect(body.trello_available).toBe(true);
  });

  it("returns mapped status when entry resolves on the board", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([{ id: "tl1", name: "ToDo Mirror" }]);
    // Persist a valid map via direct write helper.
    const { writeTrelloListMap } = await import("../trello-list-map.js");
    await writeTrelloListMap(
      repoLocalPath,
      { list_id_to_trello_list_id: { [danxbotListIds[0]]: "tl1" } },
      new Set(danxbotListIds),
    );
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    const body = JSON.parse(res._getBody());
    expect(body.classification[danxbotListIds[0]]).toEqual({
      status: "mapped",
      trello_list_id: "tl1",
      trello_list_name: "ToDo Mirror",
    });
  });

  it("returns orphaned status when mapped trello list is gone from the board", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([{ id: "tl-other", name: "Other" }]);
    const { writeTrelloListMap } = await import("../trello-list-map.js");
    await writeTrelloListMap(
      repoLocalPath,
      { list_id_to_trello_list_id: { [danxbotListIds[0]]: "tl-dead" } },
      new Set(danxbotListIds),
    );
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    const body = JSON.parse(res._getBody());
    expect(body.classification[danxbotListIds[0]].status).toBe("orphaned");
    expect(body.classification[danxbotListIds[0]].trello_list_id).toBe("tl-dead");
  });

  it("works even when Trello is unreachable (degrades to empty trelloLists)", async () => {
    mockFetchBoardLists.mockRejectedValueOnce(new TrelloApiError("network", null));
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.trello_available).toBe(false);
    for (const id of danxbotListIds) {
      expect(body.classification[id].status).toBe("unmapped");
    }
  });

  it("board_configured: true when trello.yml carries a board_id", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([]);
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    const body = JSON.parse(res._getBody());
    expect(body.board_configured).toBe(true);
  });

  it("board_configured: false when trello.yml has no board_id (SPA hides panel)", async () => {
    writeTrelloYml(null);
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.board_configured).toBe(false);
    expect(body.trello_available).toBe(false);
  });

  it("board_configured: true when Trello transiently down (panel stays visible)", async () => {
    mockFetchBoardLists.mockRejectedValueOnce(new TrelloApiError("502", 502));
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.board_configured).toBe(true);
    expect(body.trello_available).toBe(false);
  });

  it("board_configured: true when dashboard Trello creds missing (panel stays visible)", async () => {
    delete process.env.DASHBOARD_TRELLO_API_KEY;
    const res = createMockRes();
    await handleGetListMapping(authedReq("GET"), res, "danxbot", deps);
    const body = JSON.parse(res._getBody());
    expect(body.board_configured).toBe(true);
    expect(body.trello_available).toBe(false);
  });
});

describe("PATCH /api/trello/list-mapping", () => {
  it("401 without bearer", async () => {
    const res = createMockRes();
    await handlePatchListMapping(
      unauthedReq("PATCH", { map: { list_id_to_trello_list_id: {} } }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(401);
  });

  it("writes valid map + publishes SSE topic", async () => {
    const map = { list_id_to_trello_list_id: { [danxbotListIds[0]]: "tl-new" } };
    const res = createMockRes();
    await handlePatchListMapping(authedReq("PATCH", { map }), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    expect(readTrelloListMap(repoLocalPath)).toEqual(map);
    expect(mockEventBusPublish).toHaveBeenCalledWith({
      topic: "trello-list-map:updated",
      data: { repoName: "danxbot", map },
    });
  });

  it("400 when map references an unknown danxbot list id", async () => {
    const res = createMockRes();
    await handlePatchListMapping(
      authedReq("PATCH", {
        map: { list_id_to_trello_list_id: { "list-nope": "tl1" } },
      }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).errors).toBeDefined();
  });

  it("400 when body shape is wrong", async () => {
    const res = createMockRes();
    await handlePatchListMapping(
      authedReq("PATCH", { map: "not an object" } as unknown as Record<string, unknown>),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
  });

  it("400 when an entry value is empty", async () => {
    const res = createMockRes();
    await handlePatchListMapping(
      authedReq("PATCH", {
        map: { list_id_to_trello_list_id: { [danxbotListIds[0]]: "" } },
      }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
  });

  it("allows write even when Trello board not configured (operator can pre-edit)", async () => {
    writeTrelloYml(null);
    const res = createMockRes();
    await handlePatchListMapping(
      authedReq("PATCH", {
        map: { list_id_to_trello_list_id: { [danxbotListIds[0]]: "tl-future" } },
      }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(200);
  });
});

describe("POST /api/trello/list-mapping/bootstrap-backlog (DX-620)", () => {
  it("401 without bearer", async () => {
    const res = createMockRes();
    await handlePostBootstrapBacklog(unauthedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(401);
  });

  it("400 missing repo", async () => {
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, null, deps);
    expect(res._getStatusCode()).toBe(400);
  });

  it("404 unknown repo", async () => {
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "nope", deps);
    expect(res._getStatusCode()).toBe(404);
  });

  it("happy path: creates Trello list, persists map, publishes SSE, returns created", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl-review", name: "Review" },
      { id: "tl-todo", name: "To Do" },
    ]);
    mockCreateList.mockResolvedValueOnce({ id: "tl-backlog-new", name: "Backlog" });
    const archivedId = archivedDefaultListId();
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      status: "created",
      trello_list_id: "tl-backlog-new",
      trello_list_name: "Backlog",
    });
    expect(mockCreateList).toHaveBeenCalledWith(
      "board-1",
      "Backlog",
      { apiKey: "k", apiToken: "t" },
      { pos: "bottom" },
    );
    expect(readTrelloListMap(repoLocalPath)).toEqual({
      list_id_to_trello_list_id: { [archivedId]: "tl-backlog-new" },
    });
    expect(mockEventBusPublish).toHaveBeenCalledWith({
      topic: "trello-list-map:updated",
      data: {
        repoName: "danxbot",
        map: { list_id_to_trello_list_id: { [archivedId]: "tl-backlog-new" } },
      },
    });
  });

  it("idempotent: already-mapped returns 200 status=already-mapped without touching Trello", async () => {
    const archivedId = archivedDefaultListId();
    const { writeTrelloListMap } = await import("../trello-list-map.js");
    await writeTrelloListMap(
      repoLocalPath,
      { list_id_to_trello_list_id: { [archivedId]: "tl-pre-existing" } },
      new Set(danxbotListIds),
    );
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      status: "already-mapped",
      trello_list_id: "tl-pre-existing",
    });
    expect(mockCreateList).not.toHaveBeenCalled();
    expect(mockFetchBoardLists).not.toHaveBeenCalled();
  });

  it("name-conflict: existing Trello list named Backlog → 200 status=name-conflict, no create", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([
      { id: "tl-pre", name: "Backlog" },
      { id: "tl-other", name: "Review" },
    ]);
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.status).toBe("name-conflict");
    expect(body.trello_list_id).toBe("tl-pre");
    expect(body.trello_list_name).toBe("Backlog");
    expect(body.message).toContain("dropdown");
    expect(mockCreateList).not.toHaveBeenCalled();
    // Map left unchanged.
    expect(readTrelloListMap(repoLocalPath)).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("name-conflict is case-insensitive + trim-insensitive", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([{ id: "tl-pre", name: "  BACKLOG  " }]);
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    const body = JSON.parse(res._getBody());
    expect(body.status).toBe("name-conflict");
    expect(mockCreateList).not.toHaveBeenCalled();
  });

  it("503 when board not configured", async () => {
    writeTrelloYml(null);
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(503);
  });

  it("503 when dashboard Trello creds missing", async () => {
    delete process.env.DASHBOARD_TRELLO_API_KEY;
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(503);
  });

  it("502 when Trello upstream errors during the name-conflict probe", async () => {
    mockFetchBoardLists.mockRejectedValueOnce(new TrelloApiError("rate-limited", 429));
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(502);
    expect(JSON.parse(res._getBody()).trello_status).toBe(429);
    expect(mockCreateList).not.toHaveBeenCalled();
  });

  it("502 when Trello rejects the create call", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([]);
    mockCreateList.mockRejectedValueOnce(new TrelloApiError("forbidden", 403));
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(502);
    const body = JSON.parse(res._getBody());
    expect(body.trello_status).toBe(403);
    // Map untouched on failure.
    expect(readTrelloListMap(repoLocalPath)).toEqual({ list_id_to_trello_list_id: {} });
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it("409 when writeTrelloListMap rejects post-create (defensive race — list deleted mid-request); response carries trello_list_id for recovery", async () => {
    mockFetchBoardLists.mockResolvedValueOnce([]);
    mockCreateList.mockResolvedValueOnce({ id: "tl-orphan", name: "Backlog" });
    // Force the post-create write to fail by deleting the archived
    // list from lists.yaml between createList and writeTrelloListMap.
    // Done via a spy that intercepts writeTrelloListMap after createList
    // returns — simulates the operator-deleted-list race.
    const trelloMapMod = await import("../trello-list-map.js");
    const original = trelloMapMod.writeTrelloListMap;
    const spy = vi
      .spyOn(trelloMapMod, "writeTrelloListMap")
      .mockImplementationOnce(async () => {
        throw new trelloMapMod.TrelloListMapValidationError([
          'list_id_to_trello_list_id["whatever"] references unknown danxbot list id "whatever"',
        ]);
      });
    try {
      const res = createMockRes();
      await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
      expect(res._getStatusCode()).toBe(409);
      const body = JSON.parse(res._getBody());
      expect(body.trello_list_id).toBe("tl-orphan");
      expect(body.errors).toBeDefined();
      expect(body.errors.length).toBeGreaterThan(0);
      expect(mockEventBusPublish).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      // Restore identity (defensive — vi.spyOn already does this on mockRestore)
      void original;
    }
  });

  it("preserves other mappings (merges, does not overwrite)", async () => {
    // Pre-seed a non-archived mapping.
    const otherDanxbotId = danxbotListIds.find((id) => id !== archivedDefaultListId())!;
    const { writeTrelloListMap } = await import("../trello-list-map.js");
    await writeTrelloListMap(
      repoLocalPath,
      { list_id_to_trello_list_id: { [otherDanxbotId]: "tl-other-existing" } },
      new Set(danxbotListIds),
    );
    mockFetchBoardLists.mockResolvedValueOnce([]);
    mockCreateList.mockResolvedValueOnce({ id: "tl-backlog-new", name: "Backlog" });
    const res = createMockRes();
    await handlePostBootstrapBacklog(authedReq("POST"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const map = readTrelloListMap(repoLocalPath);
    expect(map.list_id_to_trello_list_id[otherDanxbotId]).toBe("tl-other-existing");
    expect(map.list_id_to_trello_list_id[archivedDefaultListId()]).toBe("tl-backlog-new");
  });
});
