import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import type { CreateCardInput } from "../../issue-tracker/interface.js";

function defaultInput(overrides: Partial<CreateCardInput> = {}): CreateCardInput {
  return {
    schema_version: 1,
    tracker: "memory",
    parent_id: null,
    status: "ToDo",
    type: "Feature",
    title: "Make widget",
    description: "",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [{ title: "Returns 200", checked: false }],
    phases: [{ title: "Wire", status: "Pending", notes: "" }],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
    ...overrides,
  };
}

describe("MemoryTracker", () => {
  it("creates a card and assigns external_id + check_item_ids", async () => {
    const tracker = new MemoryTracker();
    const created = await tracker.createCard(defaultInput());
    expect(created.external_id).toMatch(/^mem-/);
    expect(created.ac).toHaveLength(1);
    expect(created.ac[0].check_item_id).toMatch(/^chk-/);
    expect(created.phases[0].check_item_id).toMatch(/^chk-/);
  });

  it("getCard returns the full Issue with assigned ids", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const card = await tracker.getCard(external_id);
    expect(card.external_id).toBe(external_id);
    expect(card.title).toBe("Make widget");
    expect(card.ac).toHaveLength(1);
    expect(card.phases).toHaveLength(1);
  });

  it("fetchOpenCards returns only open statuses", async () => {
    const tracker = new MemoryTracker();
    const a = await tracker.createCard(defaultInput({ status: "ToDo", title: "open" }));
    const b = await tracker.createCard(defaultInput({ status: "Done", title: "closed" }));
    const refs = await tracker.fetchOpenCards();
    const ids = refs.map((r) => r.external_id);
    expect(ids).toContain(a.external_id);
    expect(ids).not.toContain(b.external_id);
  });

  it("updateCard patches title and description independently", async () => {
    const tracker = new MemoryTracker();
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

  it("moveToStatus changes the status", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.moveToStatus(external_id, "In Progress");
    expect((await tracker.getCard(external_id)).status).toBe("In Progress");
  });

  it("setLabels overwrites the label state", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.setLabels(external_id, { type: "Bug", needsHelp: true, triaged: false });
    const card = await tracker.getCard(external_id);
    expect(card.type).toBe("Bug");
  });

  it("addComment returns id and timestamp; getComments returns oldest-first", async () => {
    let now = 1700000000000;
    const tracker = new MemoryTracker({ clock: () => new Date(now).toISOString() });
    const { external_id } = await tracker.createCard(defaultInput());
    const c1 = await tracker.addComment(external_id, "first");
    now += 1000;
    const c2 = await tracker.addComment(external_id, "second");
    expect(c1.id).not.toBe(c2.id);
    const comments = await tracker.getComments(external_id);
    expect(comments.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("AC item lifecycle: add, update, delete", async () => {
    const tracker = new MemoryTracker();
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

  it("phase item lifecycle: add, update, delete", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput({ phases: [] }));
    const { check_item_id } = await tracker.addPhaseItem(external_id, {
      title: "P1",
      status: "Pending",
      notes: "n",
    });
    await tracker.updatePhaseItem(external_id, check_item_id, { status: "Complete" });
    let card = await tracker.getCard(external_id);
    expect(card.phases[0].status).toBe("Complete");
    await tracker.deletePhaseItem(external_id, check_item_id);
    card = await tracker.getCard(external_id);
    expect(card.phases).toHaveLength(0);
  });

  it("addLinkedActionItemCard creates a new unlinked action-items card; caller wires parent_id locally", async () => {
    const tracker = new MemoryTracker();
    const parent = await tracker.createCard(defaultInput());
    const child = await tracker.addLinkedActionItemCard("Follow-up");
    expect(child.external_id).not.toBe(parent.external_id);
    const card = await tracker.getCard(child.external_id);
    // parent_id is local-only metadata — the tracker abstraction doesn't
    // store it. The new card starts with parent_id: null until a caller
    // sets it on the local Issue YAML.
    expect(card.parent_id).toBeNull();
    expect(card.title).toBe("Follow-up");
  });

  it("logs every interface call", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    await tracker.getCard(external_id);
    await tracker.updateCard(external_id, { title: "T2" });
    await tracker.moveToStatus(external_id, "Done");
    const log = tracker.getRequestLog();
    expect(log.map((l) => l.method)).toEqual([
      "createCard",
      "getCard",
      "updateCard",
      "moveToStatus",
    ]);
  });

  it("request log has one entry per interface method, with the right method+externalId+details (Test gap B)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    tracker.clearRequestLog();

    // Read methods
    await tracker.fetchOpenCards();
    await tracker.getCard(external_id);
    await tracker.getComments(external_id);

    // Mutating methods
    await tracker.updateCard(external_id, { title: "T2" });
    await tracker.moveToStatus(external_id, "In Progress");
    await tracker.setLabels(external_id, {
      type: "Bug",
      needsHelp: true,
      triaged: true,
    });
    await tracker.addComment(external_id, "hi");
    const ac = await tracker.addAcItem(external_id, { title: "AC2", checked: false });
    await tracker.updateAcItem(external_id, ac.check_item_id, { checked: true });
    await tracker.deleteAcItem(external_id, ac.check_item_id);
    const ph = await tracker.addPhaseItem(external_id, {
      title: "P2",
      status: "Pending",
      notes: "",
    });
    await tracker.updatePhaseItem(external_id, ph.check_item_id, { status: "Complete" });
    await tracker.deletePhaseItem(external_id, ph.check_item_id);
    await tracker.addLinkedActionItemCard("Follow-up");

    const log = tracker.getRequestLog();
    const methods = log.map((l) => l.method);
    expect(methods).toEqual([
      "fetchOpenCards",
      "getCard",
      "getComments",
      "updateCard",
      "moveToStatus",
      "setLabels",
      "addComment",
      "addAcItem",
      "updateAcItem",
      "deleteAcItem",
      "addPhaseItem",
      "updatePhaseItem",
      "deletePhaseItem",
      "addLinkedActionItemCard",
    ]);

    // externalId is recorded everywhere it applies (fetchOpenCards has none).
    const byMethod = (m: string) => log.find((l) => l.method === m);
    expect(byMethod("fetchOpenCards")?.externalId).toBeUndefined();
    expect(byMethod("getCard")?.externalId).toBe(external_id);
    expect(byMethod("getComments")?.externalId).toBe(external_id);
    expect(byMethod("updateCard")?.externalId).toBe(external_id);
    expect(byMethod("moveToStatus")?.externalId).toBe(external_id);
    expect(byMethod("setLabels")?.externalId).toBe(external_id);
    expect(byMethod("addComment")?.externalId).toBe(external_id);
    expect(byMethod("addAcItem")?.externalId).toBe(external_id);
    expect(byMethod("updateAcItem")?.externalId).toBe(external_id);
    expect(byMethod("deleteAcItem")?.externalId).toBe(external_id);
    expect(byMethod("addPhaseItem")?.externalId).toBe(external_id);
    expect(byMethod("updatePhaseItem")?.externalId).toBe(external_id);
    expect(byMethod("deletePhaseItem")?.externalId).toBe(external_id);
    // addLinkedActionItemCard takes no parent param; it records no externalId.
    expect(byMethod("addLinkedActionItemCard")?.externalId).toBeUndefined();

    // details payload shape: setLabels carries the labels triple.
    expect(byMethod("setLabels")?.details).toEqual({
      labels: { type: "Bug", needsHelp: true, triaged: true },
    });
    // moveToStatus carries the target status.
    expect(byMethod("moveToStatus")?.details).toEqual({ status: "In Progress" });
    // addComment carries the comment text.
    expect(byMethod("addComment")?.details).toEqual({ text: "hi" });
    // updateCard carries the patch.
    expect(byMethod("updateCard")?.details).toEqual({ patch: { title: "T2" } });
    // addAcItem carries the item.
    expect(byMethod("addAcItem")?.details).toEqual({
      item: { title: "AC2", checked: false },
    });
    // addPhaseItem carries the item.
    expect(byMethod("addPhaseItem")?.details).toEqual({
      item: { title: "P2", status: "Pending", notes: "" },
    });
    // addLinkedActionItemCard carries the title and the new external_id.
    const aiDetails = byMethod("addLinkedActionItemCard")?.details as {
      title: string;
      external_id: string;
    };
    expect(aiDetails.title).toBe("Follow-up");
    expect(aiDetails.external_id).toMatch(/^mem-/);
  });

  it("failNextWrite rejects the next mutating call with the EXACT queued Error instance", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const err = new Error("boom");
    tracker.failNextWrite(err);
    // Use rejects.toBe(err) — checks identity, not just message text — so
    // a regression that swallows the queued Error and throws a fresh one
    // gets caught here.
    await expect(
      tracker.updateCard(external_id, { title: "x" }),
    ).rejects.toBe(err);
    // Subsequent write should now succeed.
    await tracker.updateCard(external_id, { title: "y" });
    expect((await tracker.getCard(external_id)).title).toBe("y");
  });

  it("failNextWrite does NOT reject reads, then rejects the next write with the EXACT queued Error instance", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultInput());
    const err = new Error("should-not-fire");
    tracker.failNextWrite(err);
    // Reads should pass through; the rejection is still queued.
    await tracker.getCard(external_id);
    await tracker.getComments(external_id);
    await tracker.fetchOpenCards();
    // Now the next write fires the queued error — by identity.
    await expect(tracker.updateCard(external_id, {})).rejects.toBe(err);
  });

  it("seeds initial cards", async () => {
    const tracker = new MemoryTracker({
      seed: [
        {
          schema_version: 1,
          tracker: "memory",
          external_id: "seed-1",
          parent_id: null,
          dispatch_id: null,
          status: "ToDo",
          type: "Feature",
          title: "Seeded",
          description: "",
          triaged: { timestamp: "", status: "", explain: "" },
          ac: [],
          phases: [],
          comments: [],
          retro: { good: "", bad: "", action_items: [], commits: [] },
        },
      ],
    });
    const card = await tracker.getCard("seed-1");
    expect(card.title).toBe("Seeded");
  });

  it("preserves the seed Issue's `tracker` field on read (round-trip)", async () => {
    // A seeded Issue carrying tracker: "trello" should round-trip with
    // tracker: "trello" on getCard — the MemoryTracker is a faithful
    // in-memory store, not a tracker-name rewriter. Useful for tests that
    // want to feed Trello-shaped fixtures through the Memory backend.
    const tracker = new MemoryTracker({
      seed: [
        {
          schema_version: 1,
          tracker: "trello",
          external_id: "seed-trello",
          parent_id: null,
          dispatch_id: null,
          status: "ToDo",
          type: "Feature",
          title: "Trello-shaped",
          description: "",
          triaged: { timestamp: "", status: "", explain: "" },
          ac: [],
          phases: [],
          comments: [],
          retro: { good: "", bad: "", action_items: [], commits: [] },
        },
      ],
    });
    const card = await tracker.getCard("seed-trello");
    expect(card.tracker).toBe("trello");
  });
});
