import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrelloConfig } from "../types.js";

import { fetchTodoCards, fetchNeedsHelpCards, fetchInProgressCards, fetchCard, fetchLatestComment, moveCardToList, addComment, isUserResponse } from "./trello-client.js";

const MOCK_TRELLO: TrelloConfig = {
  apiKey: "test-key",
  apiToken: "test-token",
  boardId: "test-board",
  reviewListId: "review-list",
  todoListId: "698fc5be16a280cc321a13ec",
  inProgressListId: "ip-list",
  needsHelpListId: "6990129be21ee37b649281a5",
  doneListId: "done-list",
  cancelledListId: "cancelled-list",
  actionItemsListId: "ai-list",
  bugLabelId: "bug-label",
  featureLabelId: "feature-label",
  epicLabelId: "epic-label",
  needsHelpLabelId: "nh-label",
};

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

    await fetchTodoCards(MOCK_TRELLO);

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

    const cards = await fetchTodoCards(MOCK_TRELLO);

    expect(cards).toEqual([
      { id: "card1", name: "First card" },
      { id: "card2", name: "Second card" },
    ]);
  });

  it("returns empty array when no cards exist", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const cards = await fetchTodoCards(MOCK_TRELLO);

    expect(cards).toEqual([]);
  });

  it("throws on non-200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(fetchTodoCards(MOCK_TRELLO)).rejects.toThrow(
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

    await expect(fetchTodoCards(MOCK_TRELLO)).rejects.toThrow(
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

    await fetchNeedsHelpCards(MOCK_TRELLO);

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/lists/6990129be21ee37b649281a5/cards");
  });

  it("returns mapped card objects", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "c1", name: "Help card" }]), { status: 200 }),
    );

    const cards = await fetchNeedsHelpCards(MOCK_TRELLO);
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

    await fetchLatestComment(MOCK_TRELLO, "card123");

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

    const result = await fetchLatestComment(MOCK_TRELLO, "card123");
    expect(result).toEqual(comment);
  });

  it("returns null when no comments exist", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const result = await fetchLatestComment(MOCK_TRELLO, "card123");
    expect(result).toBeNull();
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchLatestComment(MOCK_TRELLO, "card123")).rejects.toThrow("Trello API error: 404 Not Found");
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

    await moveCardToList(MOCK_TRELLO, "card123", "list456", "top");

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

    await moveCardToList(MOCK_TRELLO, "card123", "list456");

    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(opts.body as string).pos).toBe("top");
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(moveCardToList(MOCK_TRELLO, "card123", "list456")).rejects.toThrow("Trello API error: 403 Forbidden");
  });
});

describe("fetchInProgressCards", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls the In Progress list URL", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    await fetchInProgressCards(MOCK_TRELLO);

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/lists/ip-list/cards");
    expect(calledUrl).toContain("key=test-key");
    expect(calledUrl).toContain("token=test-token");
  });

  it("returns mapped card objects", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([{ id: "c1", name: "In Progress card" }]), { status: 200 }),
    );

    const cards = await fetchInProgressCards(MOCK_TRELLO);
    expect(cards).toEqual([{ id: "c1", name: "In Progress card" }]);
  });
});

describe("fetchCard", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches the card by id and requests id, name, idList fields", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ id: "c1", name: "My card", idList: "todo-list" }),
        { status: 200 },
      ),
    );

    const card = await fetchCard(MOCK_TRELLO, "c1");

    expect(card).toEqual({ id: "c1", name: "My card", idList: "todo-list" });
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("/1/cards/c1");
    expect(calledUrl).toContain("fields=id,name,idList");
    expect(calledUrl).toContain("key=test-key");
    expect(calledUrl).toContain("token=test-token");
  });

  it("throws on non-ok response so the caller can log and skip", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Not found", { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchCard(MOCK_TRELLO, "missing")).rejects.toThrow(
      "Trello API error: 404 Not Found",
    );
  });

  it("throws when the response body is missing idList (fail-loud on malformed shape)", async () => {
    // A malformed Trello response with no idList would silently cause
    // the post-dispatch halt check to treat the card as "moved" (since
    // `undefined !== todoListId` is true). Throwing here forces the
    // caller's try/catch to log and skip — no false-negative halts.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "c1", name: "Card" }), { status: 200 }),
    );

    await expect(fetchCard(MOCK_TRELLO, "c1")).rejects.toThrow(
      /without idList/,
    );
  });

  it("throws when the response body is missing id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ name: "Card", idList: "l" }), {
        status: 200,
      }),
    );

    await expect(fetchCard(MOCK_TRELLO, "c1")).rejects.toThrow(/without id/);
  });
});

describe("addComment", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST to the comments endpoint with text body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await addComment(MOCK_TRELLO, "card123", "Agent failed with error");

    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;

    expect(calledUrl).toContain("/1/cards/card123/actions/comments");
    expect(calledUrl).toContain("key=test-key");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ text: "Agent failed with error" });
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    );

    await expect(addComment(MOCK_TRELLO, "card123", "test")).rejects.toThrow("Trello API error: 403 Forbidden");
  });
});

describe("isUserResponse", () => {
  it("returns false when comment is null (no comments)", () => {
    expect(isUserResponse(null)).toBe(false);
  });

  it("returns false when comment contains the danxbot marker", () => {
    const comment = { id: "a1", data: { text: "This needs help\n\n<!-- danxbot -->" } };
    expect(isUserResponse(comment)).toBe(false);
  });

  it("returns true when comment does not contain the danxbot marker", () => {
    const comment = { id: "a1", data: { text: "I've updated the Slack config, try again" } };
    expect(isUserResponse(comment)).toBe(true);
  });

  it("returns true for plain user text without any HTML comments", () => {
    const comment = { id: "a1", data: { text: "Done, the API key is refreshed" } };
    expect(isUserResponse(comment)).toBe(true);
  });

  it("returns false when marker is embedded in longer text", () => {
    const comment = { id: "a1", data: { text: "Auto-created error card\n\nSome details here\n\n<!-- danxbot -->" } };
    expect(isUserResponse(comment)).toBe(false);
  });
});
