import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TrelloTracker,
  formatCardTitle,
  parseCardTitle,
} from "../../issue-tracker/trello.js";
import {
  TrelloCircuitOpen,
  _resetForTesting as resetCircuit,
  _setNowForTesting as setCircuitNow,
  getState as getCircuitState,
  setCircuitLogger,
} from "../../issue-tracker/circuit-breaker.js";
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
  blockedLabelId: "lbl-blocked",
  requiresHumanLabelId: "lbl-rh",
  triagedLabelId: "lbl-triaged",
};

describe("TrelloTracker", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    // Isolate from any other test that left the circuit-breaker open.
    resetCircuit();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCircuit();
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
      if (url.includes("list-ai/cards"))
        return jsonResponse([{ id: "a1", name: "#ISS-4: A1" }]);
      throw new Error(`unexpected url: ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const refs = await tracker.fetchOpenCards();
    // Phase 5 of ISS-90 (ISS-95): the legacy `list_kind` field was
    // removed from `IssueRef` entirely — refs now carry only
    // {id, external_id, title, status}. Action Items list cards
    // surface as `status: "Review"` so the per-card triage agent
    // picks them up alongside the Review list. DX-231 retired the
    // `Needs Approval` list — only five open lists remain.
    expect(refs).toEqual([
      { id: "ISS-1", external_id: "r1", title: "R1", status: "Review" },
      { id: "", external_id: "t1", title: "T1", status: "ToDo" },
      { id: "ISS-3", external_id: "n1", title: "N1", status: "Blocked" },
      { id: "ISS-4", external_id: "a1", title: "A1", status: "Review" },
    ]);
    // Pin the call count so a future regression that drops one of the
    // five open-list statuses (Review, ToDo, In Progress, Needs Help,
    // Action Items) gets caught here, even when the dropped list
    // happened to be empty.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Belt-and-suspenders: no ref carries any `list_kind` field at all
    // (the field is gone from the schema in Phase 5).
    expect(refs.every((r) => !("list_kind" in r))).toBe(true);
    // Positive contract pin — every ref carries EXACTLY these four
    // keys. Catches any future stowaway field (e.g. `list_kind_v2`,
    // `triage_due`, `kind`) that a `not-in` assertion would miss.
    for (const ref of refs) {
      expect(Object.keys(ref).sort()).toEqual([
        "external_id",
        "id",
        "status",
        "title",
      ]);
    }
  });

  it("fetchOpenCards skips the actionItemsListId when empty", async () => {
    // The `if (!entry.listId) continue` guard inside fetchOpenCards
    // tolerates a missing optional list id (today: only Action Items).
    // Pin that a regression that hard-required `actionItemsListId` would
    // surface as a fetch attempt against an empty URL.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("list-review/cards")) return jsonResponse([]);
      if (url.includes("list-todo/cards")) return jsonResponse([]);
      if (url.includes("list-ip/cards")) return jsonResponse([]);
      if (url.includes("list-nh/cards")) return jsonResponse([]);
      throw new Error(`unexpected url: ${url}`);
    });
    const tracker = new TrelloTracker({ ...TRELLO, actionItemsListId: "" });
    const refs = await tracker.fetchOpenCards();
    expect(refs).toEqual([]);
    // Four lists fetched (Review, ToDo, In Progress, Needs Help) —
    // Action Items skipped because its id is empty. The legacy Needs
    // Approval list was retired in DX-231.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain("list-ai");
    }
  });

  it("getCard maps a card on the Action Items list to status: Review (Phase 4 of ISS-90)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/cards/ai-card?")) {
        return jsonResponse({
          id: "ai-card",
          name: "#ISS-7: An action item",
          desc: "Do this later",
          idList: "list-ai",
          idLabels: [],
          checklists: [],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const tracker = new TrelloTracker(TRELLO);
    const issue = await tracker.getCard("ai-card");
    expect(issue.status).toBe("Review");
    expect(issue.id).toBe("ISS-7");
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

  it("getCard projects idLabels onto Issue.labels for the outbound diff (ISS-88)", async () => {
    // Card carries Bug + Triaged + Blocked. The projection inverts
    // setLabels so syncIssue can compare local-derived labels against
    // the actual remote label state without re-deriving from data
    // fields that don't round-trip on Trello.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/cards/c-projection?")) {
        return jsonResponse({
          id: "c-projection",
          name: "T",
          desc: "",
          idList: "list-todo",
          idLabels: ["lbl-bug", "lbl-triaged", "lbl-blocked"],
          checklists: [],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const issue = await tracker.getCard("c-projection");
    expect(issue.labels).toEqual({
      type: "Bug",
      blocked: true,
      // DX-231 Phase 3 (DX-234): `requires_human` is now read from
      // actual label-id membership. The fixture card has no `lbl-rh`
      // applied, so the projection is `false`.
      requires_human: false,
      triaged: true,
    });
    // No second round-trip: getCard reuses card.idLabels in-process.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getCard.labels projects requires_human:true when the requiresHumanLabelId is on the card (DX-234)", async () => {
    // Phase 3 wired the projection to consult
    // `TrelloConfig.requiresHumanLabelId`. When the operator has
    // provisioned the label and applied it to a card, the projection
    // surfaces `true` — the diff in `syncIssue` then matches the local
    // `requires_human != null` boolean and skips the redundant write.
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        id: "c-requires-human",
        name: "T",
        desc: "",
        idList: "list-todo",
        idLabels: ["lbl-feature", "lbl-rh"],
        checklists: [],
      }),
    );
    const tracker = new TrelloTracker(TRELLO);
    const issue = await tracker.getCard("c-requires-human");
    expect(issue.labels?.requires_human).toBe(true);
  });

  it("getCard.labels projects requires_human:false when requiresHumanLabelId is empty (legacy boards)", async () => {
    // Empty-string fallback — the operator has not provisioned the
    // Requires Human label yet. The projection short-circuits to
    // `false` so the outbound diff stays a no-op even when the local
    // YAML carries a non-null `requires_human` record.
    const cfg: TrelloConfig = { ...TRELLO, requiresHumanLabelId: "" };
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        id: "c-requires-human",
        name: "T",
        desc: "",
        idList: "list-todo",
        // Even if the card carried some unrelated label that happened
        // to have an empty id (impossible in practice but a defensive
        // pin), the empty-string short-circuit guards against the
        // collapse.
        idLabels: ["lbl-feature"],
        checklists: [],
      }),
    );
    const tracker = new TrelloTracker(cfg);
    const issue = await tracker.getCard("c-requires-human");
    expect(issue.labels?.requires_human).toBe(false);
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
      schema_version: 7,
      tracker: "trello",
      id: "ISS-1",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [{ title: "AC1", checked: false }],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
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
      blocked: false,
      requires_human: false,
      triaged: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",");
    expect(ids).toContain("lbl-priority"); // preserved
    expect(ids).toContain("lbl-feature"); // new type
    expect(ids).not.toContain("lbl-nh"); // needs help label removed in v4
    expect(ids).not.toContain("lbl-bug"); // old type removed
  });

  it("setLabels({requires_human:true}) applies the requiresHumanLabelId (DX-234)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return jsonResponse({ idLabels: ["lbl-feature"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.setLabels("c1", {
      type: "Feature",
      blocked: false,
      requires_human: true,
      triaged: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",");
    expect(ids).toContain("lbl-rh"); // requires_human label applied
    expect(ids).toContain("lbl-feature"); // type preserved/applied
  });

  it("setLabels({requires_human:false}) strips a stale requiresHumanLabelId (DX-234)", async () => {
    // The card already carries `lbl-rh` from a previous flag — the
    // managed-set filter must drop it from `preserved`, and
    // resolveLabelIds must NOT re-add it (the boolean is false).
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return jsonResponse({ idLabels: ["lbl-feature", "lbl-rh"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(TRELLO);
    await tracker.setLabels("c1", {
      type: "Feature",
      blocked: false,
      requires_human: false,
      triaged: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",").filter(Boolean);
    expect(ids).not.toContain("lbl-rh"); // stripped
    expect(ids).toContain("lbl-feature"); // type preserved
  });

  it("setLabels does NOT issue a PUT when the resolved idLabels are content-identical to the current ones (DX-234 — legacy-board churn guard)", async () => {
    // The dominant case this guards: sync's diff predicate fires
    // `setLabels` because local `requires_human` is non-null and the
    // legacy-board projection returned `false`. The tracker's
    // resolveLabelIds + managed-set filter collapse the resolved
    // `next` set back to the existing `idLabels` (empty id short-
    // circuits at every layer), so the PUT body would be content-
    // identical. Without the early-return this fires once per poll
    // tick (~1440 PUTs/day per flagged-on-legacy-board card),
    // reintroducing the exact churn Phase 1 of DX-231 was built to
    // prevent. With the early-return: zero mutating writes.
    const cfg: TrelloConfig = { ...TRELLO, requiresHumanLabelId: "" };
    const calls: Array<{ method: string }> = [];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "GET") {
        // Card already has Feature + a non-managed priority label;
        // managed set is {bug,feature,epic,nh,blocked,triaged}; the
        // requires_human label id is "" (excluded). resolveLabelIds
        // for {requires_human: true, type: Feature} returns just
        // [feature]. preserved = [priority]. next = [priority,
        // feature]. Identical to current idLabels — no PUT.
        return jsonResponse({ idLabels: ["lbl-feature", "lbl-priority"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(cfg);
    await tracker.setLabels("c1", {
      type: "Feature",
      blocked: false,
      requires_human: true,
      triaged: false,
    });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(0);
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(1); // GET still fires
  });

  it("setLabels({requires_human:true}) is a no-op on the requires_human label when requiresHumanLabelId is empty (legacy boards)", async () => {
    // Legacy boards where the operator has not provisioned the
    // Requires Human label leave `requiresHumanLabelId: ""`. setLabels
    // must NOT push the empty string (would corrupt idLabels) AND must
    // NOT include "" in the managed-set filter (would collapse against
    // any other unrelated label whose comparison happens to be empty).
    // We use a fixture where the type label DOES diff (Bug → Feature)
    // so the PUT actually fires; this lets us inspect the body and
    // confirm the empty id is not pushed and unrelated labels are
    // preserved. (When the diff is purely synthetic — local
    // requires_human:true vs remote false but no other change — the
    // content-identity guard above zero-PUTs the call; that path is
    // pinned by the previous test.)
    const cfg: TrelloConfig = { ...TRELLO, requiresHumanLabelId: "" };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return jsonResponse({ idLabels: ["lbl-bug", "lbl-priority"] });
      }
      return jsonResponse({});
    });
    const tracker = new TrelloTracker(cfg);
    await tracker.setLabels("c1", {
      type: "Feature",
      blocked: false,
      requires_human: true,
      triaged: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",").filter(Boolean);
    expect(ids).not.toContain(""); // never push empty string
    expect(ids).toContain("lbl-priority"); // non-managed preserved
    expect(ids).toContain("lbl-feature"); // new type applied
    expect(ids).not.toContain("lbl-bug"); // old type stripped
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
      blocked: false,
      requires_human: false,
      triaged: true,
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
        blocked: false,
        requires_human: false,
        triaged: true,
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
        blocked: false,
        requires_human: false,
        triaged: false,
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
      blocked: false,
      requires_human: false,
      triaged: false,
    });
    const putCall = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT");
    if (!putCall) throw new Error("expected PUT");
    const body = JSON.parse(putCall[1].body as string);
    const ids = (body.idLabels as string).split(",").filter(Boolean);
    expect(ids).not.toContain("discovered-triaged");
    expect(ids).toContain("lbl-bug");
  });

  // ---- Needs Approval status was retired in DX-231 ----
  //
  // The orthogonal `requires_human` field replaced the legacy parking
  // status. The Trello label provisioning + sync wiring for the new
  // field lands in Phase 3 of the epic; Phase 1 (this phase) only lands
  // the schema. The legacy `Needs Approval` describe block (status
  // routing + label-rollout edge cases) was removed wholesale because
  // every assertion in it tested behaviour that no longer exists.

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
      schema_version: 7,
      tracker: "trello",
      id: "ISS-9",
      parent_id: null,
      children: [],
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      waiting_on: null,
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


// ---------- Card-title encode/decode prefix roundtrip (Phase 2 of ISS-99) ----------
//
// `parseCardTitle` MUST accept any `^#([A-Z]{2,4}-\d+):\s*(.*)$` so cards
// from connected repos with prefixes DX / SG / FD parse identically to
// the legacy `ISS-` shape. `formatCardTitle` is already prefix-agnostic
// (uses the supplied `id` verbatim); these tests pin that contract so a
// future refactor can't reintroduce a hardcoded `ISS-` literal.

describe("parseCardTitle / formatCardTitle prefix roundtrip", () => {
  describe("parseCardTitle accepts any [A-Z]{2,4}-N prefix", () => {
    it("parses legacy ISS-N", () => {
      expect(parseCardTitle("#ISS-138: foo")).toEqual({ id: "ISS-138", title: "foo" });
    });

    it("parses DX-N (danxbot prefix)", () => {
      expect(parseCardTitle("#DX-12: bar")).toEqual({ id: "DX-12", title: "bar" });
    });

    it("parses SG-N (gpt-manager prefix)", () => {
      expect(parseCardTitle("#SG-3: baz")).toEqual({ id: "SG-3", title: "baz" });
    });

    it("parses FD-N (platform prefix)", () => {
      expect(parseCardTitle("#FD-99: qux")).toEqual({ id: "FD-99", title: "qux" });
    });

    it("parses 2-letter prefix at boundary", () => {
      expect(parseCardTitle("#XX-1: a")).toEqual({ id: "XX-1", title: "a" });
    });

    it("parses 4-letter prefix at boundary", () => {
      expect(parseCardTitle("#ABCD-1: a")).toEqual({ id: "ABCD-1", title: "a" });
    });

    it("preserves the rest of the title verbatim including colons", () => {
      expect(parseCardTitle("#DX-7: feat: do the thing")).toEqual({
        id: "DX-7",
        title: "feat: do the thing",
      });
    });

    it("returns id: '' for prefixes outside [A-Z]{2,4}-N shape", () => {
      // 1-letter prefix: too short
      expect(parseCardTitle("#X-1: a")).toEqual({ id: "", title: "#X-1: a" });
      // 5-letter prefix: too long
      expect(parseCardTitle("#ABCDE-1: a")).toEqual({ id: "", title: "#ABCDE-1: a" });
      // lowercase: shape requires uppercase
      expect(parseCardTitle("#dx-1: a")).toEqual({ id: "", title: "#dx-1: a" });
      // mixed case: shape requires uppercase only
      expect(parseCardTitle("#Dx-1: a")).toEqual({ id: "", title: "#Dx-1: a" });
      // numeric prefix: shape requires letters
      expect(parseCardTitle("#A1-1: a")).toEqual({ id: "", title: "#A1-1: a" });
    });

    it("returns id: '' for cards without the #<prefix>-N: shape", () => {
      expect(parseCardTitle("plain title")).toEqual({ id: "", title: "plain title" });
      expect(parseCardTitle("# missing colon")).toEqual({ id: "", title: "# missing colon" });
    });

    it("returns id: '' when the title has leading whitespace before the # marker", () => {
      // The regex is `^#…` — a paste with a leading space falls through
      // to the no-prefix branch. Pin the behavior so a future tightening
      // (or accidental loosening to `^\s*#…`) is loud.
      expect(parseCardTitle(" #DX-1: a")).toEqual({ id: "", title: " #DX-1: a" });
    });

    it("accepts an empty title body after the colon", () => {
      // `\s*(.*)$` matches zero characters, so `#DX-1:` and `#DX-1: ` both
      // parse with `title: ""`. Pin the behavior — the inbound parser is
      // intentionally permissive, and downstream sync.ts handles empty
      // titles by leaving the local YAML's title untouched.
      expect(parseCardTitle("#DX-1:")).toEqual({ id: "DX-1", title: "" });
      expect(parseCardTitle("#DX-1: ")).toEqual({ id: "DX-1", title: "" });
    });

    it("accepts a missing space after the colon", () => {
      // `\s*(.*)$` allows zero whitespace. `#DX-1:foo` parses to title
      // `"foo"` — operator-error case, not a hard reject.
      expect(parseCardTitle("#DX-1:foo")).toEqual({ id: "DX-1", title: "foo" });
    });
  });

  describe("formatCardTitle is prefix-agnostic via the id arg", () => {
    it.each([
      ["ISS-138", "[Danxbot] Do stuff"],
      ["DX-12", "Phase 2"],
      ["SG-3", "Backfill"],
      ["FD-99", "Migration"],
    ])("formats id=%s into the standard #<id>: <title> shape", (id, title) => {
      expect(formatCardTitle(id, title)).toBe(`#${id}: ${title}`);
    });

    it("throws on empty id", () => {
      expect(() => formatCardTitle("", "x")).toThrow(
        /formatCardTitle requires a non-empty id/,
      );
    });

    it("does NOT throw on empty title (asymmetry with empty-id behavior)", () => {
      // Pin the asymmetry — only `id` is required. An empty title round-
      // trips through `parseCardTitle` with `id: "DX-1", title: ""`. Sync
      // layers handle empty titles by preserving the local YAML title
      // (the tracker is the mirror, not the source of truth).
      expect(formatCardTitle("DX-1", "")).toBe("#DX-1: ");
      expect(parseCardTitle("#DX-1: ")).toEqual({ id: "DX-1", title: "" });
    });
  });

  describe("circuit breaker integration (DX-300)", () => {
    // The wrapper short-circuits with `TrelloCircuitOpen` while the
    // breaker is open AND records 429s back to the breaker. The state-
    // machine semantics are exhaustively pinned in
    // `circuit-breaker.test.ts`; here we pin only the WIRING.
    //
    // This block is a top-level sibling of the main `describe("TrelloTracker")`
    // block (above), so its `fetchMock` doesn't reach here — re-set up
    // the global fetch stub locally.

    const originalFetch = globalThis.fetch;
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      resetCircuit();
      setCircuitLogger({ info: () => undefined, warn: () => undefined });
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
      resetCircuit();
    });

    function jsonOk(body: unknown): Response {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    function rateLimited(): Response {
      return new Response("Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
      });
    }

    it("trips the breaker on a 429 and short-circuits subsequent calls", async () => {
      const t = 1_700_000_000_000;
      setCircuitNow(() => t);
      const tracker = new TrelloTracker(TRELLO);

      fetchMock.mockResolvedValueOnce(rateLimited());
      await expect(tracker.findLabelByName("Triaged")).rejects.toThrow(
        /Trello API error: 429/,
      );
      expect(getCircuitState()).toBe("open");

      // Second call must NOT hit fetch — short-circuit.
      fetchMock.mockClear();
      await expect(tracker.findLabelByName("Triaged")).rejects.toBeInstanceOf(
        TrelloCircuitOpen,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does NOT trip the breaker on non-429 errors", async () => {
      const t = 1_700_000_000_000;
      setCircuitNow(() => t);
      const tracker = new TrelloTracker(TRELLO);

      fetchMock.mockResolvedValueOnce(
        new Response("Server Error", {
          status: 500,
          statusText: "Server Error",
        }),
      );
      await expect(tracker.findLabelByName("Triaged")).rejects.toThrow(
        /Trello API error: 500/,
      );
      expect(getCircuitState()).toBe("closed");

      // Next call still issues fetch.
      fetchMock.mockResolvedValueOnce(jsonOk([{ id: "lbl-x", name: "Other" }]));
      await tracker.findLabelByName("Other");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("requestVoid path (e.g. moveToStatus) also respects the breaker (independent wiring from requestJson)", async () => {
      // `requestJson` and `requestVoid` are thin shape-adapters over a
      // shared `requestRaw`, but pin BOTH so a future refactor that
      // splits them again can't accidentally drop the gate on one side.
      let t = 1_700_000_000_000;
      setCircuitNow(() => t);
      const tracker = new TrelloTracker(TRELLO);

      // Trip via a requestVoid call (moveToStatus uses PUT → requestVoid).
      fetchMock.mockResolvedValueOnce(rateLimited());
      await expect(tracker.moveToStatus("card-x", "Done")).rejects.toThrow(/429/);
      expect(getCircuitState()).toBe("open");

      // Next requestVoid call must short-circuit (not hit fetch).
      fetchMock.mockClear();
      await expect(tracker.moveToStatus("card-y", "Done")).rejects.toBeInstanceOf(
        TrelloCircuitOpen,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("records success and resets to closed after half-open recovery", async () => {
      let nowMs = 1_700_000_000_000;
      setCircuitNow(() => nowMs);
      const tracker = new TrelloTracker(TRELLO);

      // Trip → 60s cooldown.
      fetchMock.mockResolvedValueOnce(rateLimited());
      await expect(tracker.findLabelByName("Triaged")).rejects.toThrow(/429/);
      expect(getCircuitState()).toBe("open");

      // Advance past cooldown → state becomes half-open on observation.
      nowMs += 60_000;
      expect(getCircuitState()).toBe("half-open");

      // Probe success → closed.
      fetchMock.mockResolvedValueOnce(jsonOk([{ id: "lbl-x", name: "Triaged" }]));
      await tracker.findLabelByName("Triaged");
      expect(getCircuitState()).toBe("closed");
    });
  });

  describe("encode -> decode roundtrip across every supported prefix", () => {
    it.each([
      ["ISS-138", "[Danxbot] Do stuff"],
      ["DX-12", "Phase 2"],
      ["SG-3", "Backfill"],
      ["FD-99", "Migration"],
      ["XX-1", "boundary 2-letter"],
      ["ABCD-1", "boundary 4-letter"],
    ])("formatCardTitle then parseCardTitle restores id=%s", (id, title) => {
      const encoded = formatCardTitle(id, title);
      expect(parseCardTitle(encoded)).toEqual({ id, title });
    });
  });
});

function authQs(): string {
  return "key=k&token=t";
}
