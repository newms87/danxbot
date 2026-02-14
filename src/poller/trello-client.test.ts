import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  config: {
    trello: { apiKey: "test-key", apiToken: "test-token" },
  },
  TODO_LIST_ID: "698fc5be16a280cc321a13ec",
}));

import { fetchTodoCards } from "./trello-client.js";

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
