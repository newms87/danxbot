import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  config: {
    trello: { apiKey: "test-key", apiToken: "test-token" },
  },
  TODO_LIST_ID: "698fc5be16a280cc321a13ec",
  NEEDS_HELP_LIST_ID: "6990129be21ee37b649281a5",
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
}));

import { fetchTodoCards, fetchNeedsHelpCards, fetchLatestComment, moveCardToList, isUserResponse } from "./trello-client.js";

describe("fetchTodoCards", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the correct Trello API URL", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await fetchTodoCards();

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/lists/698fc5be16a280cc321a13ec/cards");
    expect(calledUrl).toContain("key=test-key");
    expect(calledUrl).toContain("token=test-token");
    expect(calledUrl).toContain("fields=id,name");
  });

  it("returns mapped card objects with id and name", async () => {
    const apiResponse = [
      { id: "card1", name: "First card", extra: "ignored" },
      { id: "card2", name: "Second card", extra: "ignored" },
    ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(apiResponse), { status: 200 }),
    );

    const cards = await fetchTodoCards();

    expect(cards).toEqual([
      { id: "card1", name: "First card" },
      { id: "card2", name: "Second card" },
    ]);
  });

  it("returns empty array when no cards exist", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const cards = await fetchTodoCards();

    expect(cards).toEqual([]);
  });

  it("throws on non-200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(fetchTodoCards()).rejects.toThrow(
      "Trello API error: 401 Unauthorized",
    );
  });

  it("throws on 500 server error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(fetchTodoCards()).rejects.toThrow(
      "Trello API error: 500 Internal Server Error",
    );
  });
});

describe("fetchNeedsHelpCards", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the Needs Help list URL", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await fetchNeedsHelpCards();

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/lists/6990129be21ee37b649281a5/cards");
  });

  it("returns mapped card objects", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "c1", name: "Help card" }]), { status: 200 }),
    );

    const cards = await fetchNeedsHelpCards();
    expect(cards).toEqual([{ id: "c1", name: "Help card" }]);
  });
});

describe("fetchLatestComment", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the card actions endpoint with commentCard filter and limit=1", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await fetchLatestComment("card123");

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/cards/card123/actions");
    expect(calledUrl).toContain("filter=commentCard");
    expect(calledUrl).toContain("limit=1");
  });

  it("returns the comment when one exists", async () => {
    const comment = { id: "action1", data: { text: "Hello" } };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([comment]), { status: 200 }),
    );

    const result = await fetchLatestComment("card123");
    expect(result).toEqual(comment);
  });

  it("returns null when no comments exist", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const result = await fetchLatestComment("card123");
    expect(result).toBeNull();
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchLatestComment("card123")).rejects.toThrow("Trello API error: 404 Not Found");
  });
});

describe("moveCardToList", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends PUT request with idList and pos in body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await moveCardToList("card123", "list456", "top");

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;

    expect(calledUrl).toContain("/1/cards/card123");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body as string)).toEqual({ idList: "list456", pos: "top" });
  });

  it("defaults position to top", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await moveCardToList("card123", "list456");

    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(opts.body as string).pos).toBe("top");
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(moveCardToList("card123", "list456")).rejects.toThrow("Trello API error: 403 Forbidden");
  });
});

describe("isUserResponse", () => {
  it("returns false when comment is null (no comments)", () => {
    expect(isUserResponse(null)).toBe(false);
  });

  it("returns false when comment contains the flytebot marker", () => {
    const comment = { id: "a1", data: { text: "This needs help\n\n<!-- flytebot -->" } };
    expect(isUserResponse(comment)).toBe(false);
  });

  it("returns true when comment does not contain the flytebot marker", () => {
    const comment = { id: "a1", data: { text: "I've updated the Slack config, try again" } };
    expect(isUserResponse(comment)).toBe(true);
  });

  it("returns true for plain user text without any HTML comments", () => {
    const comment = { id: "a1", data: { text: "Done, the API key is refreshed" } };
    expect(isUserResponse(comment)).toBe(true);
  });

  it("returns false when marker is embedded in longer text", () => {
    const comment = { id: "a1", data: { text: "Auto-created error card\n\nSome details here\n\n<!-- flytebot -->" } };
    expect(isUserResponse(comment)).toBe(false);
  });
});
