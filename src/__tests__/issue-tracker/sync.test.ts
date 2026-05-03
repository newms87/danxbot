import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import { syncIssue } from "../../issue-tracker/sync.js";
import { DANXBOT_COMMENT_MARKER } from "../../poller/constants.js";
import type { CreateCardInput, Issue } from "../../issue-tracker/interface.js";

function defaultCreate(): CreateCardInput {
  return {
    schema_version: 1,
    tracker: "memory",
    parent_id: null,
    status: "ToDo",
    type: "Feature",
    title: "T",
    description: "D",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [{ title: "AC1", checked: false }],
    phases: [{ title: "P1", status: "Pending", notes: "n" }],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
  };
}

describe("syncIssue", () => {
  it("round-trip identity: getCard → sync → only getComments+getCard, zero writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(result.remoteWriteCount).toBe(0);
    const methods = tracker.getRequestLog().map((l) => l.method);
    expect(methods.sort()).toEqual(["getCard", "getComments"]);
  });

  it("idempotency: calling sync twice in a row issues zero writes the second time", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = await tracker.getCard(external_id);
    // Mutate locally so the first sync writes.
    local.title = "Changed";
    const first = await syncIssue(tracker, local);
    expect(first.remoteWriteCount).toBeGreaterThan(0);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);
    expect(second.remoteWriteCount).toBe(0);
  });

  it("merges new remote comments into local", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // Remote-only comment posted directly via tracker API.
    await tracker.addComment(external_id, "from a human");
    const local = await tracker.getCard(external_id);
    expect(local.comments).toHaveLength(1);

    // Drop it from local to simulate "haven't pulled yet".
    const stripped: Issue = { ...local, comments: [] };
    const result = await syncIssue(tracker, stripped);
    expect(result.updatedLocal.comments.map((c) => c.text)).toEqual(["from a human"]);
    expect(result.remoteWriteCount).toBe(0); // comment merge is a read
  });

  it("title change → updateCard", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = { ...(await tracker.getCard(external_id)), title: "New" };
    tracker.clearRequestLog();
    const result = await syncIssue(tracker, local);
    expect(result.remoteWriteCount).toBe(1);
    expect(tracker.getRequestLog().some((l) => l.method === "updateCard")).toBe(true);
  });

  it("status change → moveToStatus", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = { ...(await tracker.getCard(external_id)), status: "In Progress" };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    expect(tracker.getRequestLog().some((l) => l.method === "moveToStatus")).toBe(true);
  });

  it("type change → setLabels", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = { ...(await tracker.getCard(external_id)), type: "Bug" };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    expect(tracker.getRequestLog().some((l) => l.method === "setLabels")).toBe(true);
  });

  it("AC item add → addAcItem; new check_item_id stamped back into local", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.ac.push({ check_item_id: "", title: "AC2", checked: false });
    const result = await syncIssue(tracker, local);
    expect(result.updatedLocal.ac).toHaveLength(2);
    expect(result.updatedLocal.ac[1].check_item_id).toMatch(/^chk-/);
  });

  it("AC item update propagates title and checked", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.ac[0].checked = true;
    local.ac[0].title = "AC1 renamed";
    tracker.clearRequestLog();
    const result = await syncIssue(tracker, local);
    expect(result.remoteWriteCount).toBeGreaterThan(0);
    const after = await tracker.getCard(external_id);
    expect(after.ac[0]).toMatchObject({ checked: true, title: "AC1 renamed" });
  });

  it("AC item missing locally → deleteAcItem", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.ac = [];
    await syncIssue(tracker, local);
    const after = await tracker.getCard(external_id);
    expect(after.ac).toHaveLength(0);
  });

  it("phase item add → addPhaseItem with status & notes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.phases.push({
      check_item_id: "",
      title: "P2",
      status: "Blocked",
      notes: "stuck",
    });
    const result = await syncIssue(tracker, local);
    expect(result.updatedLocal.phases).toHaveLength(2);
    expect(result.updatedLocal.phases[1].check_item_id).toMatch(/^chk-/);
    const after = await tracker.getCard(external_id);
    expect(after.phases[1]).toMatchObject({
      title: "P2",
      status: "Blocked",
      notes: "stuck",
    });
  });

  it("local comment without id → addComment, marker prepended, id stamped", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.comments.push({ author: "", timestamp: "", text: "hello" });

    const result = await syncIssue(tracker, local);

    const newComment = result.updatedLocal.comments.find((c) => c.text.includes("hello"));
    expect(newComment).toBeDefined();
    expect(newComment!.id).toBeDefined();
    expect(newComment!.text.startsWith(DANXBOT_COMMENT_MARKER)).toBe(true);
  });

  it("local comment whose text already contains the marker is NOT double-stamped", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    const original = `${DANXBOT_COMMENT_MARKER}\n\nalready stamped`;
    local.comments.push({ author: "", timestamp: "", text: original });
    const result = await syncIssue(tracker, local);
    const stamped = result.updatedLocal.comments.find((c) => c.text === original);
    expect(stamped).toBeDefined();
  });

  it("propagates errors from tracker writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.comments.push({ author: "", timestamp: "", text: "x" });
    tracker.failNextWrite(new Error("network down"));
    await expect(syncIssue(tracker, local)).rejects.toThrow("network down");
  });

  // ---- Test gap C: setLabels derived-args shape ----

  it("derives needsHelp:true from status='Needs Help' (gap C)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Needs Help",
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect((setLabels!.details as { labels: { needsHelp: boolean } }).labels.needsHelp).toBe(
      true,
    );
  });

  it("derives needsHelp:false for non-Needs-Help statuses (gap C)", async () => {
    const tracker = new MemoryTracker();
    // Seed in Needs Help so the diff fires when we move out of it.
    const { external_id } = await tracker.createCard(
      defaultCreate(),
    );
    // Move remote to Needs Help so its labels reflect that.
    await tracker.moveToStatus(external_id, "Needs Help");
    await tracker.setLabels(external_id, {
      type: "Feature",
      needsHelp: true,
      triaged: false,
    });
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "In Progress",
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect((setLabels!.details as { labels: { needsHelp: boolean } }).labels.needsHelp).toBe(
      false,
    );
  });

  it("derives triaged:true when triaged.timestamp is non-empty (gap C)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      triaged: { timestamp: "2026-05-01T00:00:00Z", status: "ok", explain: "" },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect((setLabels!.details as { labels: { triaged: boolean } }).labels.triaged).toBe(
      true,
    );
  });

  it("derives triaged:false when triaged.timestamp is empty (gap C)", async () => {
    // Build a tracker pre-seeded with a card whose triaged record IS set on
    // the server (via seed Issue), then sync a local that has cleared it.
    const seed: Issue = {
      schema_version: 1,
      tracker: "memory",
      external_id: "card-triaged",
      parent_id: null,
      dispatch_id: null,
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      triaged: {
        timestamp: "2026-04-30T00:00:00Z",
        status: "ok",
        explain: "",
      },
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
    const tracker = new MemoryTracker({ seed: [seed] });
    const local: Issue = {
      ...(await tracker.getCard("card-triaged")),
      triaged: { timestamp: "", status: "", explain: "" },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    // Remote derives triaged:true from seeded timestamp; local cleared it
    // → setLabels MUST be called with triaged:false so the stale label is
    // stripped (Fix 2 + the sync diff combined).
    expect(setLabels).toBeDefined();
    expect((setLabels!.details as { labels: { triaged: boolean } }).labels.triaged).toBe(
      false,
    );
  });

  it("propagates type Bug/Feature/Epic into setLabels args (gap C)", async () => {
    for (const type of ["Bug", "Epic"] as const) {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const local: Issue = { ...(await tracker.getCard(external_id)), type };
      tracker.clearRequestLog();
      await syncIssue(tracker, local);
      const setLabels = tracker
        .getRequestLog()
        .find((l) => l.method === "setLabels");
      expect(setLabels, `expected setLabels for type=${type}`).toBeDefined();
      expect(
        (setLabels!.details as { labels: { type: string } }).labels.type,
        `expected propagated type=${type}`,
      ).toBe(type);
    }
  });

  // ---- Test gap D: phases full update + delete paths ----

  it("phase item update mutates title/status/notes via updatePhaseItem (gap D)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.phases[0].title = "Renamed";
    local.phases[0].status = "Complete";
    local.phases[0].notes = "done";
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const update = tracker
      .getRequestLog()
      .find((l) => l.method === "updatePhaseItem");
    expect(update).toBeDefined();
    const after = await tracker.getCard(external_id);
    expect(after.phases[0]).toMatchObject({
      title: "Renamed",
      status: "Complete",
      notes: "done",
    });
  });

  it("phase item missing locally → deletePhaseItem (gap D)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.phases = [];
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const del = tracker
      .getRequestLog()
      .find((l) => l.method === "deletePhaseItem");
    expect(del).toBeDefined();
    const after = await tracker.getCard(external_id);
    expect(after.phases).toHaveLength(0);
  });

  it("local-as-truth wins on every non-comment field", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      title: "Local Title",
      description: "Local Desc",
      status: "Needs Help",
      type: "Bug",
    };
    await syncIssue(tracker, local);
    const after = await tracker.getCard(external_id);
    expect(after.title).toBe("Local Title");
    expect(after.description).toBe("Local Desc");
    expect(after.status).toBe("Needs Help");
    expect(after.type).toBe("Bug");
  });
});
