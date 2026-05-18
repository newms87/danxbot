import { describe, it, expect } from "vitest";
import { FakeTracker } from "./FakeTracker.js";
import type { CreateCardInput } from "../../issue-tracker/interface.js";

function defaultInput(
  overrides: Partial<CreateCardInput> = {},
): CreateCardInput {
  return {
    schema_version: 12,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "Make widget",
    description: "",
    priority: 3.0,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ title: "Returns 200", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    waiting_on: null,
    ...overrides,
  };
}

describe("FakeTracker", () => {
  it("creates a card and assigns external_id + check_item_ids", async () => {
    const tracker = new FakeTracker();
    const created = await tracker.createCard(defaultInput());
    expect(created.external_id).toMatch(/^mem-/);
    expect(created.ac).toHaveLength(1);
    expect(created.ac[0].check_item_id).toMatch(/^chk-/);
  });

  it("getCard returns the full Issue with assigned ids", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const card = await tracker.getCard(external_id);
    expect(card.external_id).toBe(external_id);
    expect(card.title).toBe("Make widget");
    expect(card.ac).toHaveLength(1);
  });

  it("fetchOpenCards returns cards on the supplied trello list ids (DX-621)", async () => {
    const tracker = new FakeTracker();
    const a = await tracker.createCard(
      defaultInput({ status: "ToDo", title: "open" }),
    );
    const b = await tracker.createCard(
      defaultInput({ status: "Done", title: "closed" }),
    );
    const refs = await tracker.fetchOpenCards(["list-ToDo"]);
    const ids = refs.map((r) => r.external_id);
    expect(ids).toContain(a.external_id);
    expect(ids).not.toContain(b.external_id);
  });

  it("updateCard patches title and description independently", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.updateCard(external_id, { title: "New title" });
    let card = await tracker.getCard(external_id);
    expect(card.title).toBe("New title");
    expect(card.description).toBe("");
    await tracker.updateCard(external_id, { description: "body" });
    card = await tracker.getCard(external_id);
    expect(card.description).toBe("body");
    expect(card.title).toBe("New title");
  });

  it("moveToList updates the tracker_list_id (DX-621)", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.moveToList(external_id, "list-In Progress");
    expect((await tracker.getCard(external_id)).tracker_list_id).toBe(
      "list-In Progress",
    );
  });

  it("setLabels overwrites the label state", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.setLabels(external_id, {
      type: "Bug",
      blocked: false,
      requires_human: false,
      triaged: false,
    });
    const card = await tracker.getCard(external_id);
    expect(card.type).toBe("Bug");
  });

  it("getCard surfaces the current managed-label projection on Issue.labels (ISS-88)", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());

    // Right after createCard the card's labels mirror the createCard
    // input — type matches, the rest are derived defaults.
    const initial = await tracker.getCard(external_id);
    expect(initial.labels).toEqual({
      type: "Feature",
      blocked: false,
      requires_human: false,
      triaged: false,
    });

    // After setLabels, the same getCard call reflects the new label state.
    await tracker.setLabels(external_id, {
      type: "Bug",
      blocked: true,
      requires_human: false,
      triaged: true,
    });
    const updated = await tracker.getCard(external_id);
    expect(updated.labels).toEqual({
      type: "Bug",
      blocked: true,
      requires_human: false,
      triaged: true,
    });
  });

  it("addComment returns id and timestamp; getComments returns oldest-first", async () => {
    let now = 1700000000000;
    const tracker = new FakeTracker({
      clock: () => new Date(now).toISOString(),
    });
    const { external_id } = await tracker.createCard(defaultInput());
    const c1 = await tracker.addComment(external_id, "first");
    now += 1000;
    const c2 = await tracker.addComment(external_id, "second");
    expect(c1.id).not.toBe(c2.id);
    const comments = await tracker.getComments(external_id);
    expect(comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("editComment replaces text in-place; preserves id, author, timestamp", async () => {
    let now = 1700000000000;
    const tracker = new FakeTracker({
      clock: () => new Date(now).toISOString(),
    });
    const { external_id } = await tracker.createCard(defaultInput());
    const { id, timestamp } = await tracker.addComment(external_id, "v1");
    now += 60_000;
    await tracker.editComment(external_id, id, "v2");
    const comments = await tracker.getComments(external_id);
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(id);
    expect(comments[0].text).toBe("v2");
    expect(comments[0].author).toBe("danxbot");
    expect(comments[0].timestamp).toBe(timestamp);
  });

  it("editComment throws when the comment id is unknown on the given card", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await expect(
      tracker.editComment(external_id, "cmt-nope", "ignored"),
    ).rejects.toThrow(/Comment .* not found/);
  });

  it("editComment is a write — failNextWrite rejects it by identity", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const { id } = await tracker.addComment(external_id, "v1");
    const err = new Error("boom");
    tracker.failNextWrite(err);
    await expect(tracker.editComment(external_id, id, "v2")).rejects.toBe(err);
    // Subsequent write succeeds; original text untouched after the failed call.
    const c = (await tracker.getComments(external_id))[0];
    expect(c.text).toBe("v1");
  });

  it("AC item lifecycle: add, update, delete", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput({ ac: [] }));
    const { check_item_id } = await tracker.addAcItem(external_id, {
      title: "x",
      checked: false,
    });
    await tracker.updateAcItem(external_id, check_item_id, { checked: true });
    let card = await tracker.getCard(external_id);
    expect(card.ac[0].checked).toBe(true);
    await tracker.deleteAcItem(external_id, check_item_id);
    card = await tracker.getCard(external_id);
    expect(card.ac).toHaveLength(0);
  });


  it("logs every interface call", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.getCard(external_id);
    await tracker.updateCard(external_id, { title: "T2" });
    await tracker.moveToList(external_id, "list-Done");
    const log = tracker.getRequestLog();
    expect(log.map((l) => l.method)).toEqual([
      "createCard",
      "getCard",
      "updateCard",
      "moveToList",
    ]);
  });

  it("request log has one entry per interface method, with the right method+externalId+details (Test gap B)", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    tracker.clearRequestLog();

    // Read methods
    await tracker.fetchOpenCards(["list-ToDo"]);
    await tracker.getCard(external_id);
    await tracker.getComments(external_id);

    // Mutating methods
    await tracker.updateCard(external_id, { title: "T2" });
    await tracker.moveToList(external_id, "list-In Progress");
    await tracker.setLabels(external_id, {
      type: "Bug",
      blocked: false,
      requires_human: false,
      triaged: true,
    });
    const addedCommentResult = await tracker.addComment(external_id, "hi");
    await tracker.editComment(external_id, addedCommentResult.id, "hi-edited");
    const ac = await tracker.addAcItem(external_id, {
      title: "AC2",
      checked: false,
    });
    await tracker.updateAcItem(external_id, ac.check_item_id, {
      checked: true,
    });
    await tracker.deleteAcItem(external_id, ac.check_item_id);

    const log = tracker.getRequestLog();
    const methods = log.map((l) => l.method);
    expect(methods).toEqual([
      "fetchOpenCards",
      "getCard",
      "getComments",
      "updateCard",
      "moveToList",
      "setLabels",
      "addComment",
      "editComment",
      "addAcItem",
      "updateAcItem",
      "deleteAcItem",
    ]);

    // externalId is recorded everywhere it applies (fetchOpenCards has none).
    const byMethod = (m: string) => log.find((l) => l.method === m);
    expect(byMethod("fetchOpenCards")?.externalId).toBeUndefined();
    expect(byMethod("getCard")?.externalId).toBe(external_id);
    expect(byMethod("getComments")?.externalId).toBe(external_id);
    expect(byMethod("updateCard")?.externalId).toBe(external_id);
    expect(byMethod("moveToList")?.externalId).toBe(external_id);
    expect(byMethod("setLabels")?.externalId).toBe(external_id);
    expect(byMethod("addComment")?.externalId).toBe(external_id);
    expect(byMethod("editComment")?.externalId).toBe(external_id);
    expect(byMethod("addAcItem")?.externalId).toBe(external_id);
    expect(byMethod("updateAcItem")?.externalId).toBe(external_id);
    expect(byMethod("deleteAcItem")?.externalId).toBe(external_id);

    // details payload shape: setLabels carries the labels triple.
    expect(byMethod("setLabels")?.details).toEqual({
      labels: { type: "Bug", blocked: false, requires_human: false, triaged: true },
    });
    // moveToList carries the target list id (DX-621).
    expect(byMethod("moveToList")?.details).toEqual({
      trelloListId: "list-In Progress",
    });
    // addComment carries the comment text.
    expect(byMethod("addComment")?.details).toEqual({ text: "hi" });
    // editComment carries the comment id + new text.
    expect(byMethod("editComment")?.details).toEqual({
      commentId: addedCommentResult.id,
      text: "hi-edited",
    });
    // updateCard carries the patch.
    expect(byMethod("updateCard")?.details).toEqual({ patch: { title: "T2" } });
    // addAcItem carries the item.
    expect(byMethod("addAcItem")?.details).toEqual({
      item: { title: "AC2", checked: false },
    });
  });

  it("failNextWrite rejects the next mutating call with the EXACT queued Error instance", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const err = new Error("boom");
    tracker.failNextWrite(err);
    // Use rejects.toBe(err) — checks identity, not just message text — so
    // a regression that swallows the queued Error and throws a fresh one
    // gets caught here.
    await expect(tracker.updateCard(external_id, { title: "x" })).rejects.toBe(
      err,
    );
    // Subsequent write should now succeed.
    await tracker.updateCard(external_id, { title: "y" });
    expect((await tracker.getCard(external_id)).title).toBe("y");
  });

  it("failNextWrite does NOT reject reads, then rejects the next write with the EXACT queued Error instance", async () => {
    const tracker = new FakeTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const err = new Error("should-not-fire");
    tracker.failNextWrite(err);
    // Reads should pass through; the rejection is still queued.
    await tracker.getCard(external_id);
    await tracker.getComments(external_id);
    await tracker.fetchOpenCards([]);
    // Now the next write fires the queued error — by identity.
    await expect(tracker.updateCard(external_id, {})).rejects.toBe(err);
  });

  it("seeds initial cards", async () => {
    const tracker = new FakeTracker({
      seed: [
        {
          schema_version: 12,
          tracker: "memory",
          id: "ISS-1",
          external_id: "seed-1",
          parent_id: null,
          children: [],
          dispatch: null,
          status: "ToDo",
          type: "Feature",
          title: "Seeded",
          description: "",
          priority: 3.0,
          triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
          ac: [],
          comments: [],
          retro: { good: "", bad: "", action_item_ids: [], commits: [] },
          blocked: null,
          assigned_agent: null,
          waiting_on: null,
          requires_human: null,
          conflict_on: [],
          effort_level: null,
          history: [],
          db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
        },

      ],
    });
    const card = await tracker.getCard("seed-1");
    expect(card.title).toBe("Seeded");
  });

  it("preserves the seed Issue's `tracker` field on read (round-trip)", async () => {
    // A seeded Issue carrying tracker: "trello" should round-trip with
    // tracker: "trello" on getCard — the FakeTracker is a faithful
    // in-memory store, not a tracker-name rewriter. Useful for tests that
    // want to feed Trello-shaped fixtures through the in-memory backend.
    const tracker = new FakeTracker({
      seed: [
        {
          schema_version: 12,
          tracker: "trello",
          id: "ISS-2",
          external_id: "seed-trello",
          parent_id: null,
          children: [],
          dispatch: null,
          status: "ToDo",
          type: "Feature",
          title: "Trello-shaped",
          description: "",
          priority: 3.0,
          triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
          ac: [],
          comments: [],
          retro: { good: "", bad: "", action_item_ids: [], commits: [] },
          blocked: null,
          assigned_agent: null,
          waiting_on: null,
          requires_human: null,
          conflict_on: [],
          effort_level: null,
          history: [],
          db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
        },

      ],
    });
    const card = await tracker.getCard("seed-trello");
    expect(card.tracker).toBe("trello");
  });

});
