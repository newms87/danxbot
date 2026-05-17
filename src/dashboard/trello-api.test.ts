import { describe, expect, it, vi } from "vitest";
import {
  TrelloApiError,
  createList,
  fetchBoardLists,
  getTrelloCreds,
} from "./trello-api.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("getTrelloCreds", () => {
  it("returns creds when both env vars are non-empty", () => {
    expect(
      getTrelloCreds({
        DASHBOARD_TRELLO_API_KEY: "k",
        DASHBOARD_TRELLO_API_TOKEN: "t",
      } as NodeJS.ProcessEnv),
    ).toEqual({ apiKey: "k", apiToken: "t" });
  });

  it("returns null when key missing", () => {
    expect(
      getTrelloCreds({ DASHBOARD_TRELLO_API_TOKEN: "t" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when token missing", () => {
    expect(
      getTrelloCreds({ DASHBOARD_TRELLO_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when key is empty string", () => {
    expect(
      getTrelloCreds({
        DASHBOARD_TRELLO_API_KEY: "",
        DASHBOARD_TRELLO_API_TOKEN: "t",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("fetchBoardLists", () => {
  const creds = { apiKey: "key1", apiToken: "tok1" };

  it("returns parsed lists on 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          { id: "l1", name: "ToDo" },
          { id: "l2", name: "In Progress" },
        ]),
      );
    const out = await fetchBoardLists("board-1", creds, { fetchImpl });
    expect(out).toEqual([
      { id: "l1", name: "ToDo" },
      { id: "l2", name: "In Progress" },
    ]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/boards/board-1/lists");
    expect(url).toContain("key=key1");
    expect(url).toContain("token=tok1");
    expect(url).toContain("filter=open");
  });

  it("skips malformed entries (missing id, non-string name)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        { id: "l1", name: "Real" },
        { id: "", name: "Empty id" },
        { id: "l3" }, // no name
        { name: "no id" },
        null,
        "garbage",
      ]),
    );
    const out = await fetchBoardLists("b", creds, { fetchImpl });
    expect(out).toEqual([{ id: "l1", name: "Real" }]);
  });

  it("throws TrelloApiError with status on non-2xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(fetchBoardLists("b", creds, { fetchImpl })).rejects.toMatchObject({
      name: "TrelloApiError",
      trelloStatus: 403,
    });
  });

  it("throws TrelloApiError with null status on timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const promise = fetchBoardLists("b", creds, { fetchImpl, timeoutMs: 5 });
    await expect(promise).rejects.toMatchObject({
      name: "TrelloApiError",
      trelloStatus: null,
    });
  });

  it("throws TrelloApiError on non-array body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ not: "array" }));
    await expect(fetchBoardLists("b", creds, { fetchImpl })).rejects.toBeInstanceOf(
      TrelloApiError,
    );
  });

  it("throws TrelloApiError on invalid JSON body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(fetchBoardLists("b", creds, { fetchImpl })).rejects.toBeInstanceOf(
      TrelloApiError,
    );
  });
});

describe("createList", () => {
  const creds = { apiKey: "key1", apiToken: "tok1" };

  it("POSTs to /lists with name + idBoard + pos and returns the summary", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "new-1", name: "Backlog" }));
    const out = await createList("board-1", "Backlog", creds, { fetchImpl });
    expect(out).toEqual({ id: "new-1", name: "Backlog" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(url).toContain("/lists?");
    expect(url).toContain("name=Backlog");
    expect(url).toContain("idBoard=board-1");
    expect(url).toContain("pos=bottom");
    expect(url).toContain("key=key1");
    expect(url).toContain("token=tok1");
  });

  it("URL-encodes the name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "n1", name: "My Backlog" }));
    await createList("b", "My Backlog", creds, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    // URLSearchParams encodes spaces as '+'
    expect(url).toContain("name=My+Backlog");
  });

  it("accepts numeric pos", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "n1", name: "X" }));
    await createList("b", "X", creds, { fetchImpl, pos: 4096 });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("pos=4096");
  });

  it("throws TrelloApiError on non-2xx with upstream status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 401 }));
    await expect(
      createList("b", "Backlog", creds, { fetchImpl }),
    ).rejects.toMatchObject({ name: "TrelloApiError", trelloStatus: 401 });
  });

  it("throws TrelloApiError on timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await expect(
      createList("b", "Backlog", creds, { fetchImpl, timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: "TrelloApiError", trelloStatus: null });
  });

  it("throws TrelloApiError on missing id in response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: "Backlog" }));
    await expect(
      createList("b", "Backlog", creds, { fetchImpl }),
    ).rejects.toBeInstanceOf(TrelloApiError);
  });

  it("throws TrelloApiError on invalid JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("garbage", { status: 200 }));
    await expect(
      createList("b", "Backlog", creds, { fetchImpl }),
    ).rejects.toBeInstanceOf(TrelloApiError);
  });
});
