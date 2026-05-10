import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TrelloConfig } from "../types.js";

import { DANXBOT_COMMENT_MARKER } from "../issue-tracker/markers.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Dynamic import after mocks
const { notifyError } = await import("./trello-notifier.js");

const MOCK_TRELLO_CONFIG: TrelloConfig = {
  apiKey: "test-key",
  apiToken: "test-token",
  boardId: "test-board",
  reviewListId: "review-list",
  todoListId: "todo-list",
  inProgressListId: "ip-list",
  needsHelpListId: "nh-list",
  doneListId: "done-list",
  cancelledListId: "cancelled-list",
  actionItemsListId: "ai-list",
  bugLabelId: "bug-label",
  featureLabelId: "feature-label",
  epicLabelId: "epic-label",
  needsHelpLabelId: "nh-label",
  blockedLabelId: "blk-label",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// No-op when creds missing
// ============================================================

describe("when Trello creds are not configured", () => {
  it("returns without calling fetch when apiKey is empty", async () => {
    await notifyError(
      { ...MOCK_TRELLO_CONFIG, apiKey: "" },
      "Agent Timeout",
      "timed out",
      {},
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns without calling fetch when apiToken is empty", async () => {
    await notifyError(
      { ...MOCK_TRELLO_CONFIG, apiToken: "" },
      "Agent Crash",
      "crashed",
      {},
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ============================================================
// Duplicate detection
// ============================================================

describe("duplicate detection", () => {
  it("does not create a card when duplicate exists in ToDo", async () => {
    const cardName = "[Danxbot > Error] Agent Timeout: timed out";

    // First fetch: list cards — returns a duplicate
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: "existing-card", name: cardName }],
    });

    await notifyError(MOCK_TRELLO_CONFIG, "Agent Timeout", "timed out", {});

    // Only one fetch call (list cards), no POST to create
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/lists/"),
    );
  });
});

// ============================================================
// Card creation
// ============================================================

describe("card creation", () => {
  beforeEach(() => {
    // First fetch: list cards — returns empty (no duplicates)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Second fetch: create card — returns success with id
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "new-card-id" }),
    });
    // Third fetch: add marker comment — returns success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "comment-id" }),
    });
  });

  it("creates a card with correct name, label, and position", async () => {
    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Agent Timeout",
      "Agent timed out after 300s",
      {
        threadTs: "123.456",
        user: "U-HUMAN",
        channelId: "C-TEST",
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Second call is the POST to create card
    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const opts = createCall[1] as RequestInit;

    expect(url).toContain("https://api.trello.com/1/cards");
    expect(opts.method).toBe("POST");

    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("name")).toBe("[Danxbot > Error] Agent Timeout: Agent timed out after 300s");
    expect(params.get("pos")).toBe("top");
    expect(params.get("idLabels")).toBe("bug-label");
    expect(params.get("idList")).toBe("todo-list");
  });

  it("includes context fields in card description", async () => {
    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Agent Crash",
      "SDK process died",
      {
        threadTs: "123.456",
        user: "U-HUMAN",
        channelId: "C-TEST",
      },
    );

    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    const desc = params.get("desc") || "";

    expect(desc).toContain("Agent Crash");
    expect(desc).toContain("SDK process died");
    expect(desc).toContain("threadTs");
    expect(desc).toContain("123.456");
    expect(desc).toContain("U-HUMAN");
    expect(desc).toContain("C-TEST");
  });

  it("truncates card name when error message is very long", async () => {
    const longMessage = "x".repeat(200);

    await notifyError(MOCK_TRELLO_CONFIG, "Agent Timeout", longMessage, {});

    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const params = new URLSearchParams(url.split("?")[1]);
    const name = params.get("name") || "";

    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toMatch(/\.\.\.$/);
  });

  it("adds a danxbot marker comment after creating the card", async () => {
    await notifyError(MOCK_TRELLO_CONFIG, "Agent Timeout", "timed out", {});

    // Third call is the comment POST
    const commentCall = mockFetch.mock.calls[2];
    const url = commentCall[0] as string;
    const opts = commentCall[1] as RequestInit;

    expect(url).toContain("/cards/new-card-id/actions/comments");
    expect(opts.method).toBe("POST");

    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("text")).toContain("<!-- danxbot -->");
  });

  it("still succeeds when marker comment POST fails", async () => {
    // Reset mocks to control the comment response
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "new-card-id" }) });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" });

    // Should not throw even though the comment POST failed
    await expect(notifyError(MOCK_TRELLO_CONFIG, "Agent Timeout", "timed out", {})).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ============================================================
// List/label overrides
// ============================================================

describe("list and label overrides", () => {
  beforeEach(() => {
    // First fetch: list cards — returns empty (no duplicates)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Second fetch: create card — returns success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "new-card-id" }),
    });
    // Third fetch: add marker comment — returns success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "comment-id" }),
    });
  });

  it("creates card in custom list when options.listId is provided", async () => {
    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Router Error",
      "credit balance is too low",
      {},
      {
        listId: "6990129be21ee37b649281a5",
      },
    );

    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const params = new URLSearchParams(url.split("?")[1]);

    expect(params.get("idList")).toBe("6990129be21ee37b649281a5");
    // Label should still be default bugLabelId
    expect(params.get("idLabels")).toBe("bug-label");
  });

  it("creates card with custom label when options.labelId is provided", async () => {
    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Router Error",
      "credit balance is too low",
      {},
      {
        labelId: "698fc5b8847b787a3818adaa",
      },
    );

    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const params = new URLSearchParams(url.split("?")[1]);

    expect(params.get("idLabels")).toBe("698fc5b8847b787a3818adaa");
    // List should still be default todoListId
    expect(params.get("idList")).toBe("todo-list");
  });

  it("creates card with both custom list and label when both provided", async () => {
    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Router Error",
      "credit balance is too low",
      {},
      {
        listId: "6990129be21ee37b649281a5",
        labelId: "698fc5b8847b787a3818adaa",
      },
    );

    const createCall = mockFetch.mock.calls[1];
    const url = createCall[0] as string;
    const params = new URLSearchParams(url.split("?")[1]);

    expect(params.get("idList")).toBe("6990129be21ee37b649281a5");
    expect(params.get("idLabels")).toBe("698fc5b8847b787a3818adaa");
  });

  it("checks for duplicates in the target list (not always todoListId)", async () => {
    // Reset mocks to control the list cards fetch
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "new-card-id" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "comment-id" }),
    });

    await notifyError(
      MOCK_TRELLO_CONFIG,
      "Router Error",
      "credit error",
      {},
      {
        listId: "6990129be21ee37b649281a5",
      },
    );

    // First fetch should query the custom list for duplicates
    const listCall = mockFetch.mock.calls[0][0] as string;
    expect(listCall).toContain("/lists/6990129be21ee37b649281a5/cards");
  });
});

// ============================================================
// Error swallowing
// ============================================================

describe("error handling", () => {
  it("never throws when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(notifyError(MOCK_TRELLO_CONFIG, "Agent Crash", "crashed", {})).resolves.toBeUndefined();
  });

  it("never throws when card creation POST returns non-ok", async () => {
    // List cards succeeds with empty array
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    // Card creation returns error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(notifyError(MOCK_TRELLO_CONFIG, "Agent Crash", "crashed", {})).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("never throws when list cards returns non-ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(notifyError(MOCK_TRELLO_CONFIG, "Agent Crash", "crashed", {})).resolves.toBeUndefined();
  });
});
