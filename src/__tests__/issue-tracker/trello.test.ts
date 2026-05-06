import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrelloTracker } from "../../issue-tracker/trello.js";
import type { TrelloConfig } from "../../types.js";

const TRELLO: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "board",
  reviewListId: "list-review",
  todoListId: "list-todo",
  inProgressListId: "list-ip",
  needsHelpListId: "list-nh",
  needsApprovalListId: "list-na",
  doneListId: "list-done",
  cancelledListId: "list-cancelled",
  actionItemsListId: "list-ai",
  bugLabelId: "lbl-bug",
  featureLabelId: "lbl-feature",
  epicLabelId: "lbl-epic",
  needsHelpLabelId: "lbl-nh",
  needsApprovalLabelId: "lbl-na",
  blockedLabelId: "lbl-blocked",
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
    // Title prefix `#ISS-N: <title>` is the v2 contract — fetchOpenCards
    // parses the prefix and surfaces `id` separately. Cards without the
    // prefix surface with `id: ""` (legacy / human-created).
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("list-review/cards"))
        return jsonResponse([{ id: "r1", name: "#ISS-1: R1" }]);
      if (url.includes("list-todo/cards"))
        return jsonResponse([{ id: "t1", name: "T1" }]);
      if (url.includes("list-ip/cards")) return jsonResponse([]);
      if (url.includes("list-nh/cards"))
        return jsonResponse([{ id: "n1", name: "#ISS-3: N1" }]);
      if (url.includes("list-na/cards"))
        return jsonResponse([{ id: "p1", name: "#ISS-9: P1" }]);
      if (url.includes("list-ai/cards"))
        return jsonResponse([{ id: "a1", name: "#ISS-4: A1" }]);
      throw new Error(`unexpected url: ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const refs = await tracker.fetchOpenCards();
    expect(refs).toEqual([
      { id: "ISS-1", external_id: "r1", title: "R1", status: "Review" },
      {
        id: "",
        external_id: "t1",
        title: "T1",
        status: "ToDo",
        list_kind: "todo",
      },
      { id: "ISS-3", external_id: "n1", title: "N1", status: "Needs Help" },
      {
        id: "ISS-9",
        external_id: "p1",
        title: "P1",
        status: "Needs Approval",
      },
      // Action Items list cards surface as ToDo + list_kind: "action_items"
      // so blocker discovery sees them but the poller dispatch path skips.
      {
        id: "ISS-4",
        external_id: "a1",
        title: "A1",
        status: "ToDo",
        list_kind: "action_items",
      },
    ]);
    // Pin the call count so a future regression that drops one of the
    // six open-list statuses (Review, ToDo, In Progress, Needs Help,
    // Needs Approval, Action Items) gets caught here, even when the
    // dropped list happened to be empty.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("getCard hydrates description, status, type, ac (NOT comments — call getComments separately)", async () => {
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
    // Comments are intentionally empty — getCard no longer hits /actions.
    expect(issue.comments).toEqual([]);
    // `parent_id` and `children` are local-only metadata — Trello has
    // no native parent concept, so the tracker emits null/[] always.
    // Higher layers populate them on the local YAML side.
    expect(issue.parent_id).toBeNull();
    expect(issue.children).toEqual([]);
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
      if (
        url.startsWith(
          "https://api.trello.com/1/checklists/chk-new/checkItems?",
        )
      ) {
        return jsonResponse({ id: "ci-new" });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.createCard({
      schema_version: 3,
      tracker: "trello",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [{ title: "AC1", checked: false }],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
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
    await tracker.setLabels("c1", {
      type: "Feature",
      needsHelp: true,
      needsApproval: false,
      triaged: false,
      blocked: false,
    });
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
      jsonResponse({
        id: "act-x",
        date: "2026-05-01T00:00:00.000Z",
        data: { text: "hi" },
      }),
    );
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addComment("c1", "hi");
    expect(result).toEqual({
      id: "act-x",
      timestamp: "2026-05-01T00:00:00.000Z",
    });
  });

  it("non-2xx response throws Trello API error message", async () => {
    fetchMock.mockResolvedValue(
      new Response("nope", { status: 500, statusText: "Server Error" }),
    );
    const tracker = new TrelloTracker(TRELLO);
    await expect(tracker.updateCard("c1", { title: "x" })).rejects.toThrow(
      /Trello API error: 500 Server Error/,
    );
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
    await tracker.setLabels("c1", {
      type: "Bug",
      needsHelp: false,
      needsApproval: false,
      triaged: true,
      blocked: false,
    });
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
      tracker.setLabels("c1", {
        type: "Bug",
        needsHelp: false,
      needsApproval: false,
        triaged: true,
        blocked: false,
      }),
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
      tracker.setLabels("c1", {
        type: "Bug",
        needsHelp: false,
      needsApproval: false,
        triaged: false,
        blocked: false,
      }),
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
    await tracker.setLabels("c1", {
      type: "Bug",
      needsHelp: false,
      needsApproval: false,
      triaged: false,
      blocked: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",").filter(Boolean);
    expect(ids).not.toContain("discovered-triaged");
    expect(ids).toContain("lbl-bug");
  });

  // ---- Needs Approval (Phase 1 of auto-triage epic, ISS-75) ----

  describe("Needs Approval status", () => {
    it("moveToStatus('Needs Approval') routes to needsApprovalListId", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const tracker = new TrelloTracker(TRELLO);
      await tracker.moveToStatus("c1", "Needs Approval");
      const call = fetchMock.mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({
        idList: "list-na",
        pos: "top",
      });
    });

    it("moveToStatus('Needs Approval') throws when the list id is empty (operator has not provisioned the list)", async () => {
      const cfg: TrelloConfig = { ...TRELLO, needsApprovalListId: "" };
      const tracker = new TrelloTracker(cfg);
      await expect(
        tracker.moveToStatus("c1", "Needs Approval"),
      ).rejects.toThrow(
        /Trello board has no Needs Approval list configured/,
      );
    });

    it("setLabels({needsApproval:true}) applies the Needs Approval label when provisioned", async () => {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "GET") {
          return jsonResponse({ idLabels: ["lbl-feature"] });
        }
        return jsonResponse({});
      });
      const tracker = new TrelloTracker(TRELLO);
      await tracker.setLabels("c1", {
        type: "Feature",
        needsHelp: false,
        needsApproval: true,
        triaged: false,
        blocked: false,
      });
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      if (!putCall) throw new Error("expected PUT");
      const body = JSON.parse(putCall[1].body as string);
      const ids = (body.idLabels as string).split(",");
      expect(ids).toContain("lbl-na");
    });

    it("setLabels({needsApproval:true}) silently skips applying the label when needsApprovalLabelId is empty (rollout)", async () => {
      // Rollout state: list provisioned, label not yet. The Needs Approval
      // status push must succeed; the missing label is a no-op rather
      // than an error so the rest of the card's labels still sync.
      const cfg: TrelloConfig = { ...TRELLO, needsApprovalLabelId: "" };
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "GET") {
          return jsonResponse({ idLabels: ["lbl-feature"] });
        }
        return jsonResponse({});
      });
      const tracker = new TrelloTracker(cfg);
      await tracker.setLabels("c1", {
        type: "Feature",
        needsHelp: false,
        needsApproval: true,
        triaged: false,
        blocked: false,
      });
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      if (!putCall) throw new Error("expected PUT");
      const body = JSON.parse(putCall[1].body as string);
      const ids = (body.idLabels as string).split(",").filter(Boolean);
      // Empty needsApprovalLabelId → no `""` in idLabels (which would
      // otherwise become a malformed comma-separated entry).
      expect(ids).toEqual(["lbl-feature"]);
    });

    it("setLabels with empty needsApprovalLabelId does not strip non-managed labels (managed-set excludes empty id)", async () => {
      // If `""` were in the managed set, the preserved-labels filter would
      // strip every card label whose id matches `""` — which is no real
      // card, but the bug surface is the filter's contract: only stamp
      // configured ids, never blanks. Pin the contract.
      const cfg: TrelloConfig = { ...TRELLO, needsApprovalLabelId: "" };
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "GET") {
          return jsonResponse({
            idLabels: ["lbl-bug", "lbl-priority-p0"],
          });
        }
        return jsonResponse({});
      });
      const tracker = new TrelloTracker(cfg);
      await tracker.setLabels("c1", {
        type: "Bug",
        needsHelp: false,
        needsApproval: false,
        triaged: false,
        blocked: false,
      });
      const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
      if (!putCall) throw new Error("expected PUT");
      const body = JSON.parse(putCall[1].body as string);
      const ids = (body.idLabels as string).split(",").filter(Boolean);
      expect(ids).toContain("lbl-priority-p0");
      expect(ids).toContain("lbl-bug");
    });

    it("getCard maps a card on the Needs Approval list to status: 'Needs Approval'", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/cards/c1?")) {
          return jsonResponse({
            id: "c1",
            name: "#ISS-9: P1",
            desc: "",
            idList: "list-na",
            idLabels: [],
            checklists: [],
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });
      const tracker = new TrelloTracker(TRELLO);
      const issue = await tracker.getCard("c1");
      expect(issue.status).toBe("Needs Approval");
    });

    it("listIdToStatus does NOT match an empty needsApprovalListId on a card with a blank idList (regression guard for the && empty check)", async () => {
      const cfg: TrelloConfig = { ...TRELLO, needsApprovalListId: "" };
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/cards/c1?")) {
          return jsonResponse({
            id: "c1",
            name: "#ISS-9: P1",
            desc: "",
            // Hypothetical: a card whose idList came back empty would
            // erroneously match an empty needsApprovalListId without the
            // truthiness guard. Pin that the guard exists.
            idList: "",
            idLabels: [],
            checklists: [],
          });
        }
        throw new Error(`unexpected url: ${url}`);
      });
      const tracker = new TrelloTracker(cfg);
      await expect(tracker.getCard("c1")).rejects.toThrow(
        / is not mapped to a status/,
      );
    });
  });

  // ---- Test gap A: HTTP method/URL/auth/body assertions per method ----

  it("addAcItem POSTs with correct URL + body + auth", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      // ensureChecklistId: GET /cards/<id>/checklists
      if (init?.method === "GET" && url.includes("/cards/c1/checklists")) {
        return jsonResponse([{ id: "ck-ac", name: "Acceptance Criteria" }]);
      }
      if (
        init?.method === "POST" &&
        url.includes("/checklists/ck-ac/checkItems")
      ) {
        return jsonResponse({ id: "ci-new" });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const result = await tracker.addAcItem("c1", {
      title: "AC1",
      checked: true,
    });
    expect(result.check_item_id).toBe("ci-new");
    const post = fetchMock.mock.calls.find(
      (c) =>
        c[1]?.method === "POST" &&
        (c[0] as string).startsWith(
          "https://api.trello.com/1/checklists/ck-ac/checkItems",
        ),
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
      jsonResponse({
        id: "act-x",
        date: "2026-05-01T00:00:00.000Z",
        data: { text: "hi" },
      }),
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
      schema_version: 3,
      tracker: "trello",
      id: "ISS-9",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      triaged: { timestamp: "", status: "", explain: "" },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    });
    const post = fetchMock.mock.calls[0];
    expect(post[0]).toContain(authQs());
    const body = JSON.parse(post[1].body as string);
    expect(body.idList).toBe("list-todo");
    // createCard prefixes the title with `#<id>: ` so humans on the
    // Trello UI can correlate cards back to local YAMLs.
    expect(body.name).toBe("#ISS-9: T");
    expect(body.desc).toBe("D");
    expect(body.pos).toBe("top");
    expect(typeof body.idLabels).toBe("string"); // comma-joined ids
    expect(body.idLabels).toContain("lbl-feature");
  });
});


function authQs(): string {
  return "key=k&token=t";
}
