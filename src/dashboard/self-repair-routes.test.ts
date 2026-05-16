/**
 * DX-565 (Phase 5): tests for the four `/api/self-repair/errors/*`
 * route handlers. Each handler is invoked with a stub `ServerResponse`
 * + URLSearchParams + a mocked `db-reads` dependency surface. The
 * blanket `/api/*` user-auth gate is asserted via the routing layer
 * test elsewhere; these tests focus on handler behavior (param
 * parsing, status codes, body shapes, error handling).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  listSpy,
  detailSpy,
  resetSpy,
  unfixSpy,
  publishSpy,
} = vi.hoisted(() => ({
  listSpy: vi.fn(),
  detailSpy: vi.fn(),
  resetSpy: vi.fn(),
  unfixSpy: vi.fn(),
  publishSpy: vi.fn(),
}));
vi.mock("../system-repair/db-reads.js", () => ({
  listRepairErrors: listSpy,
  getRepairErrorDetail: detailSpy,
  resetRepairError: resetSpy,
  markUnfixable: unfixSpy,
}));
vi.mock("../system-repair/publish.js", () => ({
  publishRepairErrorUpdated: publishSpy,
}));

import {
  handleListRepairErrors,
  handleGetRepairError,
  handleResetRepairError,
  handleMarkUnfixable,
} from "./self-repair-routes.js";

interface CapturedResponse {
  status: number | null;
  body: unknown;
}

function makeRes(): {
  res: {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { status: null, body: null };
  const writeHead = vi.fn((status: number) => {
    captured.status = status;
  });
  const end = vi.fn((body: string) => {
    captured.body = JSON.parse(body);
  });
  return { res: { writeHead, end }, captured };
}

const deps = { db: {} as never };

beforeEach(() => {
  listSpy.mockReset();
  detailSpy.mockReset();
  resetSpy.mockReset();
  unfixSpy.mockReset();
  publishSpy.mockReset();
  publishSpy.mockResolvedValue(undefined);
});

describe("handleListRepairErrors", () => {
  it("returns 200 + {errors} on success", async () => {
    listSpy.mockResolvedValueOnce([
      { error: { id: 1, status: "open" }, attempts: [] },
    ]);
    const { res, captured } = makeRes();
    await handleListRepairErrors(
      res as never,
      new URLSearchParams("repo=danxbot"),
      deps,
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      errors: [{ error: { id: 1, status: "open" }, attempts: [] }],
    });
    expect(listSpy).toHaveBeenCalledWith({
      db: deps.db,
      repo: "danxbot",
      limit: 200,
    });
  });

  it("treats empty repo string as null filter", async () => {
    listSpy.mockResolvedValueOnce([]);
    const { res } = makeRes();
    await handleListRepairErrors(res as never, new URLSearchParams(""), deps);
    expect(listSpy.mock.calls[0][0]).toMatchObject({ repo: null });
  });

  it("clamps limit to 200", async () => {
    listSpy.mockResolvedValueOnce([]);
    const { res } = makeRes();
    await handleListRepairErrors(
      res as never,
      new URLSearchParams("limit=5000"),
      deps,
    );
    expect(listSpy.mock.calls[0][0]).toMatchObject({ limit: 200 });
  });

  it("returns 500 on DB failure", async () => {
    listSpy.mockRejectedValueOnce(new Error("db down"));
    const { res, captured } = makeRes();
    await handleListRepairErrors(res as never, new URLSearchParams(""), deps);
    expect(captured.status).toBe(500);
    expect(captured.body).toMatchObject({ error: expect.any(String) });
  });
});

describe("handleGetRepairError", () => {
  it("returns 400 on non-numeric id", async () => {
    const { res, captured } = makeRes();
    await handleGetRepairError(res as never, "abc", deps);
    expect(captured.status).toBe(400);
    expect(detailSpy).not.toHaveBeenCalled();
  });

  it("returns 400 on zero / negative id", async () => {
    const { res, captured } = makeRes();
    await handleGetRepairError(res as never, "0", deps);
    expect(captured.status).toBe(400);
  });

  it("returns 404 when not found", async () => {
    detailSpy.mockResolvedValueOnce(null);
    const { res, captured } = makeRes();
    await handleGetRepairError(res as never, "7", deps);
    expect(captured.status).toBe(404);
  });

  it("returns 200 + body on hit", async () => {
    detailSpy.mockResolvedValueOnce({
      error: { id: 7, status: "fixed" },
      attempts: [{ id: 1, attempt_n: 1 }],
    });
    const { res, captured } = makeRes();
    await handleGetRepairError(res as never, "7", deps);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      error: { id: 7, status: "fixed" },
    });
  });
});

describe("handleResetRepairError", () => {
  it("returns 400 on invalid id", async () => {
    const { res, captured } = makeRes();
    await handleResetRepairError({} as never, res as never, "nope", deps);
    expect(captured.status).toBe(400);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when not-found", async () => {
    resetSpy.mockResolvedValueOnce({ kind: "not-found" });
    const { res, captured } = makeRes();
    await handleResetRepairError({} as never, res as never, "9", deps);
    expect(captured.status).toBe(404);
  });

  it("returns 200 + post-reset row + publishes SSE on success", async () => {
    resetSpy.mockResolvedValueOnce({
      kind: "reset",
      row: { id: 9, status: "open" },
    });
    const { res, captured } = makeRes();
    await handleResetRepairError({} as never, res as never, "9", deps);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ row: { id: 9, status: "open" } });
    expect(publishSpy).toHaveBeenCalledWith({ db: deps.db, errorId: 9 });
  });

  it("does NOT publish when the row is not found", async () => {
    resetSpy.mockResolvedValueOnce({ kind: "not-found" });
    const { res } = makeRes();
    await handleResetRepairError({} as never, res as never, "9", deps);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("returns 500 on db error", async () => {
    resetSpy.mockRejectedValueOnce(new Error("boom"));
    const { res, captured } = makeRes();
    await handleResetRepairError({} as never, res as never, "9", deps);
    expect(captured.status).toBe(500);
  });
});

describe("handleMarkUnfixable", () => {
  it("returns 400 on invalid id", async () => {
    const { res, captured } = makeRes();
    await handleMarkUnfixable({} as never, res as never, "x", deps);
    expect(captured.status).toBe(400);
    expect(unfixSpy).not.toHaveBeenCalled();
  });

  it("returns 404 when not-found", async () => {
    unfixSpy.mockResolvedValueOnce({ kind: "not-found" });
    const { res, captured } = makeRes();
    await handleMarkUnfixable({} as never, res as never, "9", deps);
    expect(captured.status).toBe(404);
  });

  it("returns 200 + post-update row + publishes SSE on success", async () => {
    unfixSpy.mockResolvedValueOnce({
      kind: "marked",
      row: { id: 9, status: "unfixable" },
    });
    const { res, captured } = makeRes();
    await handleMarkUnfixable({} as never, res as never, "9", deps);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ row: { id: 9, status: "unfixable" } });
    expect(publishSpy).toHaveBeenCalledWith({ db: deps.db, errorId: 9 });
  });

  it("returns 500 on db error", async () => {
    unfixSpy.mockRejectedValueOnce(new Error("boom"));
    const { res, captured } = makeRes();
    await handleMarkUnfixable({} as never, res as never, "9", deps);
    expect(captured.status).toBe(500);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});
