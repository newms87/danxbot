import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// Auth mock — Bearer "user-<name>" passes, everything else 401.
// Mirrors the issue-write test pattern.
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

import {
  handleCreateList,
  handleDeleteList,
  handleListLists,
  handleSwapListOrder,
  handleUpdateList,
} from "./lists-routes.js";
import {
  _resetForTesting as resetListsForTesting,
  applyCreateList,
  ensureListsFile,
  readLists,
  writeLists,
} from "../lists-file.js";
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
  return {
    token: "test-token",
    repos,
    resolveHost: () => "127.0.0.1",
  };
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
  mockEventBusPublish.mockClear();
  tmpRoot = mkdtempSync(resolve(tmpdir(), "lists-routes-test-"));
  repoLocalPath = resolve(tmpRoot, "danxbot");
  mkdirSync(resolve(repoLocalPath, ".danxbot"), { recursive: true });
  await ensureListsFile(repoLocalPath);
  deps = makeDeps();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function bodyOf(res: MockResponse): Record<string, unknown> {
  return JSON.parse(res._getBody()) as Record<string, unknown>;
}

describe("auth gate", () => {
  it("GET returns 401 without bearer", async () => {
    const res = createMockRes();
    await handleListLists(unauthedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(401);
  });

  it("POST returns 401 without bearer", async () => {
    const res = createMockRes();
    await handleCreateList(
      unauthedReq("POST", { name: "x", type: "review" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(401);
  });

  it("PATCH returns 401 without bearer", async () => {
    const res = createMockRes();
    await handleUpdateList(
      unauthedReq("PATCH", { name: "x" }),
      res,
      "anything",
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(401);
  });

  it("DELETE returns 401 without bearer", async () => {
    const res = createMockRes();
    await handleDeleteList(unauthedReq("DELETE"), res, "anything", "danxbot", deps);
    expect(res._getStatusCode()).toBe(401);
  });
});

describe("repo resolution", () => {
  it("GET returns 400 when repo query missing", async () => {
    const res = createMockRes();
    await handleListLists(authedReq("GET"), res, null, deps);
    expect(res._getStatusCode()).toBe(400);
  });

  it("GET returns 404 when repo not configured", async () => {
    const res = createMockRes();
    await handleListLists(authedReq("GET"), res, "nope", deps);
    expect(res._getStatusCode()).toBe(404);
  });
});

describe("GET /api/lists", () => {
  it("returns the seeded 6-list file", async () => {
    const res = createMockRes();
    await handleListLists(authedReq("GET"), res, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = bodyOf(res);
    const file = body.file as { lists: unknown[] };
    expect(file.lists).toHaveLength(6);
  });
});

describe("POST /api/lists", () => {
  it("creates a list and publishes SSE", async () => {
    const res = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "Triage", type: "review" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(201);
    const body = bodyOf(res);
    const list = body.list as { name: string; type: string };
    expect(list.name).toBe("Triage");
    expect(list.type).toBe("review");
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const event = mockEventBusPublish.mock.calls[0][0] as {
      topic: string;
      data: { repoName: string };
    };
    expect(event.topic).toBe("lists:updated");
    expect(event.data.repoName).toBe("danxbot");
  });

  it("returns 400 on missing required fields", async () => {
    const res = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "Triage" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    const body = bodyOf(res);
    expect(body.errors).toBeDefined();
  });

  it("returns 400 on unknown type", async () => {
    const res = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "X", type: "unknown" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 400 on invalid hex color", async () => {
    const res = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "X", type: "review", color: "not-a-hex" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    const body = bodyOf(res);
    expect((body.errors as string[]).join(" ")).toMatch(/hex color/);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/lists/:id", () => {
  it("renames a list and publishes SSE", async () => {
    const file = readLists(repoLocalPath);
    const target = file.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", { name: "Triage" }),
      res,
      target.id,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(200);
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const back = readLists(repoLocalPath);
    expect(back.lists.find((l) => l.id === target.id)!.name).toBe("Triage");
  });

  it("returns 400 on Field not patchable", async () => {
    const file = readLists(repoLocalPath);
    const target = file.lists[0];
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", { foo: "bar" }),
      res,
      target.id,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 404 on unknown id", async () => {
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", { name: "x" }),
      res,
      "nope-id",
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(404);
  });
});

describe("POST /api/lists/swap-order", () => {
  async function seedSecondReview(): Promise<{ aId: string; bId: string }> {
    const current = readLists(repoLocalPath);
    const review = current.lists.find((l) => l.type === "review")!;
    const { file: next, created } = applyCreateList(current, {
      name: "Second Review",
      type: "review",
      order: 5,
    });
    await writeLists(repoLocalPath, next);
    return { aId: review.id, bId: created.id };
  }

  it("returns 401 without bearer", async () => {
    const res = createMockRes();
    await handleSwapListOrder(
      unauthedReq("POST", { a_id: "x", b_id: "y" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(401);
  });

  it("swaps order atomically and publishes SSE", async () => {
    const { aId, bId } = await seedSecondReview();
    const before = readLists(repoLocalPath);
    const aOrig = before.lists.find((l) => l.id === aId)!.order;
    const bOrig = before.lists.find((l) => l.id === bId)!.order;
    expect(aOrig).not.toBe(bOrig);
    mockEventBusPublish.mockClear();
    const res = createMockRes();
    await handleSwapListOrder(
      authedReq("POST", { a_id: aId, b_id: bId }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(200);
    const after = readLists(repoLocalPath);
    expect(after.lists.find((l) => l.id === aId)!.order).toBe(bOrig);
    expect(after.lists.find((l) => l.id === bId)!.order).toBe(aOrig);
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const event = mockEventBusPublish.mock.calls[0][0] as { topic: string };
    expect(event.topic).toBe("lists:updated");
  });

  it("returns 400 on missing ids", async () => {
    const res = createMockRes();
    await handleSwapListOrder(
      authedReq("POST", { a_id: "" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it("returns 404 on unknown id", async () => {
    const current = readLists(repoLocalPath);
    const review = current.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleSwapListOrder(
      authedReq("POST", { a_id: review.id, b_id: "bogus" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 409 on cross-type swap", async () => {
    const current = readLists(repoLocalPath);
    const review = current.lists.find((l) => l.type === "review")!;
    const ready = current.lists.find((l) => l.type === "ready")!;
    const res = createMockRes();
    await handleSwapListOrder(
      authedReq("POST", { a_id: review.id, b_id: ready.id }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(409);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it("returns 400 on identical ids", async () => {
    const current = readLists(repoLocalPath);
    const review = current.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleSwapListOrder(
      authedReq("POST", { a_id: review.id, b_id: review.id }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
  });
});

describe("PATCH promote-default — atomic demote", () => {
  it("promoting a sibling to default demotes the prior default in the same write", async () => {
    // Seed: create a second review list (auto-non-default since one
    // already exists with is_default_for_type=true).
    const create = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "Second Review", type: "review" }),
      create,
      "danxbot",
      deps,
    );
    const second = bodyOf(create).list as { id: string; is_default_for_type: boolean };
    expect(second.is_default_for_type).toBe(false);
    mockEventBusPublish.mockClear();

    // Promote the second list to default-of-type.
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", { is_default_for_type: true }),
      res,
      second.id,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(200);

    // Re-read the file: exactly one default per type, and it's the
    // newly-promoted list. The prior "Review" default is now false.
    const after = readLists(repoLocalPath);
    const reviewLists = after.lists.filter((l) => l.type === "review");
    const defaults = reviewLists.filter((l) => l.is_default_for_type);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);
    const priorDefault = reviewLists.find((l) => l.name === "Review")!;
    expect(priorDefault.is_default_for_type).toBe(false);
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH — `type` field rejected", () => {
  it("returns 400 Field not patchable: type", async () => {
    const file = readLists(repoLocalPath);
    const target = file.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", { type: "blocked" }),
      res,
      target.id,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    const body = bodyOf(res);
    expect((body.errors as string[]).some((e) => /type/.test(e))).toBe(true);
  });
});

describe("PATCH — empty body", () => {
  it("returns 400 Empty patch", async () => {
    const file = readLists(repoLocalPath);
    const target = file.lists[0];
    const res = createMockRes();
    await handleUpdateList(
      authedReq("PATCH", {}),
      res,
      target.id,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    const body = bodyOf(res);
    expect((body.errors as string[]).join(" ")).toMatch(/Empty patch/);
  });
});

describe("no SSE publish on validation failure", () => {
  it("POST 400 does NOT publish", async () => {
    const res = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "" }),
      res,
      "danxbot",
      deps,
    );
    expect(res._getStatusCode()).toBe(400);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });

  it("DELETE last-of-type 409 does NOT publish", async () => {
    const file = readLists(repoLocalPath);
    const review = file.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleDeleteList(authedReq("DELETE"), res, review.id, "danxbot", deps);
    expect(res._getStatusCode()).toBe(409);
    expect(mockEventBusPublish).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/lists/:id", () => {
  it("refuses last-of-type with 409", async () => {
    const file = readLists(repoLocalPath);
    const review = file.lists.find((l) => l.type === "review")!;
    const res = createMockRes();
    await handleDeleteList(authedReq("DELETE"), res, review.id, "danxbot", deps);
    expect(res._getStatusCode()).toBe(409);
    const body = bodyOf(res);
    expect((body.errors as string[]).join(" ")).toContain("last list of type");
  });

  it("returns 404 on unknown id", async () => {
    const res = createMockRes();
    await handleDeleteList(authedReq("DELETE"), res, "nope", "danxbot", deps);
    expect(res._getStatusCode()).toBe(404);
  });

  it("deletes a non-default sibling and reassigns affected cards", async () => {
    // First, create a second review list.
    const create = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "Second Review", type: "review" }),
      create,
      "danxbot",
      deps,
    );
    const created = (bodyOf(create).list as { id: string; name: string });
    mockEventBusPublish.mockClear();

    // Seed an issue YAML whose list_name matches "Second Review".
    const openDir = resolve(repoLocalPath, ".danxbot", "issues", "open");
    mkdirSync(openDir, { recursive: true });
    writeFileSync(
      resolve(openDir, "DX-99.yml"),
      `id: DX-99\nschema_version: 10\nlist_name: Second Review\ntitle: Card\n`,
    );
    // Seed another whose list_name does NOT match — must NOT be touched.
    writeFileSync(
      resolve(openDir, "DX-100.yml"),
      `id: DX-100\nschema_version: 10\nlist_name: Review\ntitle: Other\n`,
    );

    const res = createMockRes();
    await handleDeleteList(authedReq("DELETE"), res, created.id, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = bodyOf(res);
    expect((body.deleted as { id: string }).id).toBe(created.id);
    expect((body.reassignTo as { name: string }).name).toBe("Review");
    expect(body.reassignedCount).toBe(1);

    // Verify the affected YAML now points at the default list.
    const after = parseYaml(
      readFileSync(resolve(openDir, "DX-99.yml"), "utf-8"),
    ) as { list_name: string };
    expect(after.list_name).toBe("Review");
    // Verify the unaffected YAML is untouched.
    const untouched = parseYaml(
      readFileSync(resolve(openDir, "DX-100.yml"), "utf-8"),
    ) as { list_name: string };
    expect(untouched.list_name).toBe("Review");

    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
  });

  it("promotes a sibling to default when deleting the default-of-type", async () => {
    // Create a second list and the default + the second both exist.
    const create = createMockRes();
    await handleCreateList(
      authedReq("POST", { name: "Second Review", type: "review", order: 99 }),
      create,
      "danxbot",
      deps,
    );

    // Delete the original Review (the default-of-type).
    const file = readLists(repoLocalPath);
    const review = file.lists.find(
      (l) => l.type === "review" && l.name === "Review",
    )!;
    const res = createMockRes();
    await handleDeleteList(authedReq("DELETE"), res, review.id, "danxbot", deps);
    expect(res._getStatusCode()).toBe(200);
    const body = bodyOf(res);
    expect((body.reassignTo as { name: string }).name).toBe("Second Review");

    const after = readLists(repoLocalPath);
    const reviewLists = after.lists.filter((l) => l.type === "review");
    expect(reviewLists).toHaveLength(1);
    expect(reviewLists[0].is_default_for_type).toBe(true);
    expect(reviewLists[0].name).toBe("Second Review");
  });
});
