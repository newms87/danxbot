import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrelloTracker, encodePhaseItemName, decodePhaseItemName } from "../../issue-tracker/trello.js";
import type { TrelloConfig } from "../../types.js";

const TRELLO: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "board",
  reviewListId: "list-review",
  todoListId: "list-todo",
  inProgressListId: "list-ip",
  needsHelpListId: "list-nh",
  doneListId: "list-done",
  cancelledListId: "list-cancelled",
  actionItemsListId: "list-ai",
  bugLabelId: "lbl-bug",
  featureLabelId: "lbl-feature",
  epicLabelId: "lbl-epic",
  needsHelpLabelId: "lbl-nh",
  triagedLabelId: "lbl-triaged",
};

describe("TrelloTracker", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("fetchOpenCards calls each open list and tags status correctly", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("list-review/cards")) return jsonResponse([{ id: "r1", name: "R1" }]);
      if (url.includes("list-todo/cards")) return jsonResponse([{ id: "t1", name: "T1" }]);
      if (url.includes("list-ip/cards")) return jsonResponse([]);
      if (url.includes("list-nh/cards")) return jsonResponse([{ id: "n1", name: "N1" }]);
      throw new Error(`unexpected url: ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const refs = await tracker.fetchOpenCards();
    expect(refs).toEqual([
      { external_id: "r1", title: "R1", status: "Review" },
      { external_id: "t1", title: "T1", status: "ToDo" },
      { external_id: "n1", title: "N1", status: "Needs Help" },
    ]);
    // Pin the call count so a future regression that drops one of the
    // four open-list statuses (Review, ToDo, In Progress, Needs Help)
    // gets caught here, even when the dropped list happened to be empty.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("getCard hydrates description, status, type, ac, phases (NOT comments — call getComments separately)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/cards/c1?")) {
        return jsonResponse({
          id: "c1",
          name: "Title",
          desc: "Body",
          idList: "list-todo",
          idLabels: ["lbl-bug"],
          checklists: [
            {
              id: "ck-ac",
              name: "Acceptance Criteria",
              checkItems: [
                { id: "ci-1", name: "Returns 200", state: "complete" },
              ],
            },
            {
              id: "ck-ph",
              name: "Implementation Phases",
              checkItems: [
                { id: "ci-2", name: "Pending: Phase 1\nNote line", state: "incomplete" },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const issue = await tracker.getCard("c1");
    expect(issue.title).toBe("Title");
    expect(issue.description).toBe("Body");
    expect(issue.status).toBe("ToDo");
    expect(issue.type).toBe("Bug");
    expect(issue.ac).toEqual([
      { check_item_id: "ci-1", title: "Returns 200", checked: true },
    ]);
    expect(issue.phases).toEqual([
      {
        check_item_id: "ci-2",
        title: "Phase 1",
        status: "Pending",
        notes: "Note line",
      },
    ]);
    // Comments are intentionally empty — getCard no longer hits /actions.
    expect(issue.comments).toEqual([]);
    // Verify exactly one round-trip: GET /cards/c1?... and nothing else.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("createCard issues POST /cards then creates checklists+items", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      if (url.includes("/cards?") && init?.method === "POST") {
        return jsonResponse({
          id: "new-card",
          name: "T",
          desc: "",
          idList: "list-todo",
          idLabels: [],
        });
      }
      if (url.endsWith(`/cards/new-card/checklists?${authQs()}`)) {
        return jsonResponse({ id: "chk-new" });
      }
      if (url.startsWith("https://api.trello.com/1/checklists/chk-new/checkItems?")) {
        return jsonResponse({ id: "ci-new" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.createCard({
      schema_version: 1,
      tracker: "trello",
      parent_id: null,
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [{ title: "AC1", checked: false }],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    });

    expect(result.external_id).toBe("new-card");
    expect(result.ac).toEqual([{ check_item_id: "ci-new" }]);
    // First call is the card POST
    expect(calls[0]).toBe("POST https://api.trello.com/1/cards");
  });

  it("updateCard PUTs name and desc", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.updateCard("c1", { title: "newT", description: "newD" });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain("/cards/c1");
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body as string)).toEqual({
      name: "newT",
      desc: "newD",
    });
  });

  it("moveToStatus PUTs the right idList and pos top", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.moveToStatus("c1", "In Progress");
    const call = fetchMock.mock.calls[0];
    expect(JSON.parse(call[1].body as string)).toEqual({
      idList: "list-ip",
      pos: "top",
    });
  });

  it("setLabels preserves non-managed labels and writes the desired set", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        // Card has Bug + a non-managed label "lbl-priority".
        return jsonResponse({ idLabels: ["lbl-bug", "lbl-priority"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.setLabels("c1", { type: "Feature", needsHelp: true, triaged: false });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",");
    expect(ids).toContain("lbl-priority"); // preserved
    expect(ids).toContain("lbl-feature"); // new type
    expect(ids).toContain("lbl-nh"); // needs help
    expect(ids).not.toContain("lbl-bug"); // old type removed
  });

  it("addComment POSTs and returns id+timestamp", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "act-x", date: "2026-05-01T00:00:00.000Z", data: { text: "hi" } }),
    );
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addComment("c1", "hi");
    expect(result).toEqual({ id: "act-x", timestamp: "2026-05-01T00:00:00.000Z" });
  });

  it("non-2xx response throws Trello API error message", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
    const tracker = new TrelloTracker(TRELLO);
    await expect(tracker.updateCard("c1", { title: "x" })).rejects.toThrow(
      /Trello API error: 500 Server Error/,
    );
  });

  it("addLinkedActionItemCard creates on the action items list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "ai-card" }));
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addLinkedActionItemCard("Follow up");
    expect(result).toEqual({ external_id: "ai-card" });
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.idList).toBe("list-ai");
    expect(body.name).toBe("Follow up");
  });

  it("looks up Triaged label from the board when triagedLabelId not configured", async () => {
    const cfg: TrelloConfig = { ...TRELLO };
    delete cfg.triagedLabelId;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/labels")) {
        return jsonResponse([
          { id: "found-triaged", name: "Triaged", color: "sky" },
        ]);
      }
      if (init?.method === "GET" && url.includes("/cards/c1?")) {
        return jsonResponse({ idLabels: [] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(cfg);
    await tracker.setLabels("c1", { type: "Bug", needsHelp: false, triaged: true });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",");
    expect(ids).toContain("found-triaged");
  });

  it("throws when triaged is requested but no Triaged label exists on the board", async () => {
    const cfg: TrelloConfig = { ...TRELLO };
    delete cfg.triagedLabelId;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/labels")) return jsonResponse([]);
      if (init?.method === "GET" && url.includes("/cards/c1?")) {
        return jsonResponse({ idLabels: [] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(cfg);
    await expect(
      tracker.setLabels("c1", { type: "Bug", needsHelp: false, triaged: true }),
    ).rejects.toThrow(/Trello board has no Triaged label configured/);
  });

  it("throws when no Triaged label exists on board, even when triaged: false (Fix 2)", async () => {
    // Without resolving the Triaged label up-front, setLabels has no way to
    // know which id to strip — silent degradation would let stale Triaged
    // labels persist forever. Even a triaged:false call must throw.
    const cfg: TrelloConfig = { ...TRELLO };
    delete cfg.triagedLabelId;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/boards/board/labels")) return jsonResponse([]);
      return jsonResponse({ idLabels: [] });
    });
    const tracker = new TrelloTracker(cfg);
    await expect(
      tracker.setLabels("c1", { type: "Bug", needsHelp: false, triaged: false }),
    ).rejects.toThrow(/Trello board has no Triaged label configured/);
  });

  it("strips a stale Triaged label on setLabels({triaged:false}) when cache is cold (Fix 2)", async () => {
    // Discovery path: triagedLabelId not configured on the cfg, label cache
    // is cold. setLabels MUST eagerly resolve the Triaged label id even
    // when triaged:false so it can be filtered out of the preserved set.
    const cfg: TrelloConfig = { ...TRELLO };
    delete cfg.triagedLabelId;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/labels")) {
        return jsonResponse([
          { id: "discovered-triaged", name: "Triaged", color: "sky" },
        ]);
      }
      if (init?.method === "GET" && url.includes("/cards/c1?")) {
        return jsonResponse({ idLabels: ["lbl-bug", "discovered-triaged"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(cfg);
    await tracker.setLabels("c1", { type: "Bug", needsHelp: false, triaged: false });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",").filter(Boolean);
    expect(ids).not.toContain("discovered-triaged");
    expect(ids).toContain("lbl-bug");
  });

  // ---- Test gap A: HTTP method/URL/auth/body assertions per method ----

  it("addAcItem POSTs with correct URL + body + auth", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      // ensureChecklistId: GET /cards/<id>/checklists
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ac", name: "Acceptance Criteria" }]);
      }
      if (init?.method === "POST" && url.includes("/checklists/ck-ac/checkItems")) {
        return jsonResponse({ id: "ci-new" });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addAcItem("c1", { title: "AC1", checked: true });
    expect(result.check_item_id).toBe("ci-new");
    const post = fetchMock.mock.calls.find(
      (c) =>
        c[1]?.method === "POST" &&
        (c[0] as string).startsWith("https://api.trello.com/1/checklists/ck-ac/checkItems"),
    );
    if (!post) throw new Error("expected POST /checkItems");
    expect(post[0]).toContain(authQs());
    expect(JSON.parse(post[1].body as string)).toEqual({
      name: "AC1",
      checked: "true",
    });
  });

  it("updateAcItem PUTs the right URL with name+state body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.updateAcItem("c1", "ci-9", { title: "newT", checked: true });
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("PUT");
    expect(call[0]).toContain("/cards/c1/checkItem/ci-9");
    expect(call[0]).toContain(authQs());
    expect(JSON.parse(call[1].body as string)).toEqual({
      name: "newT",
      state: "complete",
    });
  });

  it("updateAcItem with no patch fields is a no-op (no fetch)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.updateAcItem("c1", "ci-9", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deleteAcItem DELETEs the right URL with auth", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ac", name: "Acceptance Criteria" }]);
      }
      if (init?.method === "DELETE") return jsonResponse({});
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.deleteAcItem("c1", "ci-9");
    const del = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
    if (!del) throw new Error("expected DELETE");
    expect(del[0]).toContain("/checklists/ck-ac/checkItems/ci-9");
    expect(del[0]).toContain(authQs());
  });

  it("addPhaseItem POSTs encoded name (status: title) + auth", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ph", name: "Implementation Phases" }]);
      }
      if (init?.method === "POST") return jsonResponse({ id: "ci-ph" });
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addPhaseItem("c1", {
      title: "Wire up",
      status: "Pending",
      notes: "be careful",
    });
    expect(result.check_item_id).toBe("ci-ph");
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    if (!post) throw new Error("expected POST");
    expect(post[0]).toContain("/checklists/ck-ph/checkItems");
    expect(post[0]).toContain(authQs());
    const body = JSON.parse(post[1].body as string);
    expect(body.name).toBe("Pending: Wire up\nbe careful");
    expect(body.checked).toBe("false");
  });

  it("updatePhaseItem fetches existing then PUTs encoded name+state", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ph", name: "Implementation Phases" }]);
      }
      if (init?.method === "GET" && url.includes("/checklists/ck-ph/checkItems/ci-ph")) {
        return jsonResponse({
          id: "ci-ph",
          name: "Pending: Old\nold notes",
          state: "incomplete",
        });
      }
      if (init?.method === "PUT") return jsonResponse({});
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.updatePhaseItem("c1", "ci-ph", { status: "Complete" });
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!put) throw new Error("expected PUT");
    expect(put[0]).toContain("/cards/c1/checkItem/ci-ph");
    expect(put[0]).toContain(authQs());
    const body = JSON.parse(put[1].body as string);
    // notes + title preserved from the existing item
    expect(body.name).toBe("Complete: Old\nold notes");
    expect(body.state).toBe("complete");
  });

  it("deletePhaseItem DELETEs via the resolved checklist id", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ph", name: "Implementation Phases" }]);
      }
      if (init?.method === "DELETE") return jsonResponse({});
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.deletePhaseItem("c1", "ci-ph");
    const del = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
    if (!del) throw new Error("expected DELETE");
    expect(del[0]).toContain("/checklists/ck-ph/checkItems/ci-ph");
    expect(del[0]).toContain(authQs());
  });

  it("getComments uses filter=commentCard&limit=1000 + sorts oldest-first", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      expect(url).toContain("/cards/c1/actions");
      expect(url).toContain("filter=commentCard");
      expect(url).toContain("limit=1000");
      expect(url).toContain(authQs());
      return jsonResponse([
        {
          id: "a2",
          date: "2026-05-02T00:00:00.000Z",
          memberCreator: { username: "bob" },
          data: { text: "second" },
        },
        {
          id: "a1",
          date: "2026-05-01T00:00:00.000Z",
          memberCreator: { username: "alice" },
          data: { text: "first" },
        },
      ]);
    });
    const tracker = new TrelloTracker(TRELLO);
    const comments = await tracker.getComments("c1");
    expect(comments.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("getComments returns [] when remote has none", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const tracker = new TrelloTracker(TRELLO);
    expect(await tracker.getComments("c1")).toEqual([]);
  });

  it("addComment POSTs to /actions/comments with auth + body {text}", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "act-x", date: "2026-05-01T00:00:00.000Z", data: { text: "hi" } }),
    );
    const tracker = new TrelloTracker(TRELLO);
    await tracker.addComment("c1", "hi");
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("POST");
    expect(call[0]).toContain("/cards/c1/actions/comments");
    expect(call[0]).toContain(authQs());
    expect(JSON.parse(call[1].body as string)).toEqual({ text: "hi" });
  });

  it("editComment PUTs to /cards/{cardId}/actions/{actionId}/comments with auth + body {text}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.editComment("c1", "act-1", "edited body");
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("PUT");
    expect(call[0]).toContain("/cards/c1/actions/act-1/comments");
    expect(call[0]).toContain(authQs());
    expect(JSON.parse(call[1].body as string)).toEqual({ text: "edited body" });
  });

  it("editComment throws on non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const tracker = new TrelloTracker(TRELLO);
    await expect(
      tracker.editComment("c1", "act-1", "edited body"),
    ).rejects.toThrow(/Trello API error: 404/);
  });

  it("addLinkedActionItemCard POSTs with pos: 'top' + idList=actionItems + auth", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "ai-card" }));
    const tracker = new TrelloTracker(TRELLO);
    await tracker.addLinkedActionItemCard("Follow up");
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("POST");
    expect(call[0]).toContain("/cards");
    expect(call[0]).toContain(authQs());
    const body = JSON.parse(call[1].body as string);
    expect(body.idList).toBe("list-ai");
    expect(body.name).toBe("Follow up");
    expect(body.pos).toBe("top");
  });

  it("getCard request URL carries auth + checklists=all + checklist_fields=name", async () => {
    let captured: string | undefined;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/cards/c1?")) {
        captured = url;
        return jsonResponse({
          id: "c1",
          name: "T",
          desc: "",
          idList: "list-todo",
          idLabels: [],
          checklists: [],
        });
      }
      if (url.includes("/actions")) return jsonResponse([]);
      throw new Error(`unexpected ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.getCard("c1");
    if (!captured) throw new Error("expected GET /cards/c1");
    expect(captured).toContain(authQs());
    expect(captured).toContain("checklists=all");
    expect(captured).toContain("checklist_fields=name");
  });

  it("createCard POST body has idList, name, desc, idLabels, pos: 'top'", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/cards?")) {
        return jsonResponse({
          id: "new-card",
          name: "T",
          desc: "D",
          idList: "list-todo",
          idLabels: ["lbl-feature"],
        });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.createCard({
      schema_version: 1,
      tracker: "trello",
      parent_id: null,
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    });
    const post = fetchMock.mock.calls[0];
    expect(post[0]).toContain(authQs());
    const body = JSON.parse(post[1].body as string);
    expect(body.idList).toBe("list-todo");
    expect(body.name).toBe("T");
    expect(body.desc).toBe("D");
    expect(body.pos).toBe("top");
    expect(typeof body.idLabels).toBe("string"); // comma-joined ids
    expect(body.idLabels).toContain("lbl-feature");
  });
});

describe("phase encode/decode", () => {
  it("round-trips status + title + notes", () => {
    const encoded = encodePhaseItemName({
      title: "Wire it up",
      status: "Blocked",
      notes: "missing creds",
    });
    expect(decodePhaseItemName(encoded)).toEqual({
      title: "Wire it up",
      status: "Blocked",
      notes: "missing creds",
    });
  });

  it("omits notes line when notes are empty", () => {
    const encoded = encodePhaseItemName({
      title: "T",
      status: "Pending",
      notes: "",
    });
    expect(encoded).toBe("Pending: T");
    expect(decodePhaseItemName(encoded)).toEqual({
      title: "T",
      status: "Pending",
      notes: "",
    });
  });

  it("falls back to Pending when header has no recognized prefix", () => {
    expect(decodePhaseItemName("Random title\nbody")).toEqual({
      title: "Random title",
      status: "Pending",
      notes: "body",
    });
  });
});

function authQs(): string {
  return "key=k&token=t";
}
