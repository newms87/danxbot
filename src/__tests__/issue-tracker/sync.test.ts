import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import {
  ACTION_ITEMS_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
  isRetroNonEmpty,
  parseActionItemsBookkeeping,
  renderActionItemsBookkeeping,
  renderRetroComment,
  syncIssue,
} from "../../issue-tracker/sync.js";
import { DANXBOT_COMMENT_MARKER } from "../../poller/constants.js";
import type { CreateCardInput, Issue } from "../../issue-tracker/interface.js";

function defaultCreate(): CreateCardInput {
  return {
    schema_version: 3,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
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
      blocked: false,
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

  it("derives blocked:true from local.blocked != null and pushes the Blocked label", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      blocked: {
        reason: "waiting on prerequisite",
        timestamp: "2026-05-04T18:00:00.000Z",
        by: ["ISS-99"],
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect(
      (setLabels!.details as { labels: { blocked: boolean } }).labels.blocked,
    ).toBe(true);
  });

  it("blocked:null on both sides → no setLabels (idempotent on the unblocked path)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      blocked: null,
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeUndefined();
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
      schema_version: 3,
      tracker: "memory",
      id: "ISS-2",
      external_id: "card-triaged",
      parent_id: null,
      children: [],
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
      blocked: null,
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

  // ---- Phase 5: worker-rendered retro comment ----

  it("renders ONE retro comment on terminal-status save with both danxbot markers", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);
    const local: Issue = {
      ...fresh,
      status: "Done",
      retro: { good: "shipped", bad: "hard", action_items: [], commits: [] },
    };
    tracker.clearRequestLog();

    await syncIssue(tracker, local);

    const comments = await tracker.getComments(external_id);
    const retroOnly = comments.filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retroOnly).toHaveLength(1);
    expect(retroOnly[0].text.startsWith(DANXBOT_COMMENT_MARKER + "\n")).toBe(
      true,
    );
    expect(retroOnly[0].text).toContain("## Retro");
    expect(retroOnly[0].text).toContain("**What went well:** shipped");
    expect(retroOnly[0].text).toContain("**What went wrong:** hard");
  });

  it("retro renderer is a no-op on non-terminal status (In Progress / Needs Help)", async () => {
    for (const status of ["In Progress", "Needs Help"] as const) {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const local: Issue = {
        ...(await tracker.getCard(external_id)),
        status,
        retro: { good: "g", bad: "b", action_items: ["x"], commits: ["c"] },
      };
      tracker.clearRequestLog();

      await syncIssue(tracker, local);

      const comments = await tracker.getComments(external_id);
      const retroComments = comments.filter((c) =>
        c.text.includes(RETRO_COMMENT_MARKER),
      );
      expect(
        retroComments,
        `expected zero retro comments at status=${status}`,
      ).toHaveLength(0);
    }
  });

  it("retro renderer is a no-op when retro is fully empty even on Done", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "", bad: "", action_items: [], commits: [] },
    };
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(
      tracker.getRequestLog().some((l) => l.method === "addComment"),
    ).toBe(false);
    expect(
      tracker.getRequestLog().some((l) => l.method === "editComment"),
    ).toBe(false);
    // moveToStatus is allowed (status changed), so >=0 writes is fine — only
    // retro paths must be silent.
    expect(result.updatedLocal.comments).toHaveLength(0);
  });

  it("idempotent: re-sync with same retro produces zero retro writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: {
        good: "g",
        bad: "b",
        action_items: ["fix x"],
        commits: ["abc123"],
      },
    };

    const first = await syncIssue(tracker, local);
    // First sync wrote retro + moveToStatus.
    expect(first.remoteWriteCount).toBeGreaterThan(0);
    expect(first.updatedLocal.comments.some((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    )).toBe(true);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);

    expect(second.remoteWriteCount).toBe(0);
    expect(
      tracker.getRequestLog().some(
        (l) => l.method === "addComment" || l.method === "editComment",
      ),
    ).toBe(false);
  });

  it("editing retro.good triggers editComment on the existing retro comment, NOT a new addComment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "v1", bad: "b", action_items: [], commits: [] },
    };
    const first = await syncIssue(tracker, local);

    const updated: Issue = {
      ...first.updatedLocal,
      retro: { ...first.updatedLocal.retro, good: "v2" },
    };
    tracker.clearRequestLog();
    const second = await syncIssue(tracker, updated);

    const log = tracker.getRequestLog();
    expect(log.some((l) => l.method === "editComment")).toBe(true);
    expect(log.some((l) => l.method === "addComment")).toBe(false);
    expect(second.remoteWriteCount).toBe(1);

    // Tracker now has exactly one retro comment, with the updated body.
    const retros = (await tracker.getComments(external_id)).filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retros).toHaveLength(1);
    expect(retros[0].text).toContain("**What went well:** v2");
  });

  it("a user-authored comment that QUOTES `## Retro` (no danxbot marker) does NOT trip the legacy detector — fresh retro is still posted", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // User pastes back a Phase-4 retro body in a discussion comment; no
    // `<!-- danxbot -->` marker, no `<!-- danxbot-retro -->` marker.
    // The legacy detector requires BOTH markers to suppress; this
    // comment has neither so the worker MUST still post a fresh retro.
    await tracker.addComment(
      external_id,
      "see this old card's wrap-up:\n\n## Retro\n\n**What went well:** quoted",
    );

    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "actual new retro", bad: "", action_items: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const allComments = await tracker.getComments(external_id);
    const workerRendered = allComments.filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(workerRendered).toHaveLength(1);
    expect(workerRendered[0].text).toContain("**What went well:** actual new retro");
  });

  it("legacy `## Retro` comment without our marker is NOT duplicated by the renderer", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // Simulate Phase 4 behavior: agent manually appended a retro comment with
    // the standard `<!-- danxbot -->` marker but NO `<!-- danxbot-retro -->`.
    const legacyText = `${DANXBOT_COMMENT_MARKER}\n\n## Retro\n\n**What went well:** old\n`;
    await tracker.addComment(external_id, legacyText);

    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "new", bad: "", action_items: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const allComments = await tracker.getComments(external_id);
    const retroish = allComments.filter((c) => c.text.includes("## Retro"));
    // Exactly the legacy one — no duplicate worker-rendered comment.
    expect(retroish).toHaveLength(1);
    expect(retroish[0].text).toBe(legacyText);
    expect(
      tracker.getRequestLog().some((l) => l.method === "addComment"),
    ).toBe(false);
  });

  it("isRetroNonEmpty is true if any single field is populated", () => {
    expect(
      isRetroNonEmpty({ good: "g", bad: "", action_items: [], commits: [] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "b", action_items: [], commits: [] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "", action_items: ["x"], commits: [] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "", action_items: [], commits: ["c"] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "", action_items: [], commits: [] }),
    ).toBe(false);
  });

  // ---- Phase 5: worker-spawned action_items cards ----

  it("spawns one tracker card per retro.action_items entry on Done", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: {
        good: "g",
        bad: "b",
        action_items: ["Fix X", "Document Y"],
        commits: [],
      },
    };
    tracker.clearRequestLog();

    await syncIssue(tracker, local);

    const log = tracker.getRequestLog();
    const spawnEntries = log.filter((l) => l.method === "addLinkedActionItemCard");
    expect(spawnEntries).toHaveLength(2);
    const titles = spawnEntries.map((e) => (e.details as { title: string }).title);
    expect(titles).toEqual(["Fix X", "Document Y"]);

    const bookkeepingComments = (await tracker.getComments(external_id)).filter(
      (c) => c.text.includes(ACTION_ITEMS_COMMENT_MARKER),
    );
    expect(bookkeepingComments).toHaveLength(1);
    const ids = spawnEntries.map(
      (e) => (e.details as { external_id: string }).external_id,
    );
    expect(bookkeepingComments[0].text).toContain(`Fix X\t${ids[0]}`);
    expect(bookkeepingComments[0].text).toContain(`Document Y\t${ids[1]}`);
  });

  it("idempotent: re-sync with same action_items spawns no new cards and edits no comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: {
        good: "g",
        bad: "",
        action_items: ["A", "B"],
        commits: [],
      },
    };

    const first = await syncIssue(tracker, local);
    expect(first.remoteWriteCount).toBeGreaterThan(0);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);

    expect(second.remoteWriteCount).toBe(0);
    expect(
      tracker.getRequestLog().some((l) => l.method === "addLinkedActionItemCard"),
    ).toBe(false);
    expect(
      tracker.getRequestLog().some((l) => l.method === "editComment"),
    ).toBe(false);
  });

  it("incremental: appending an action_item spawns ONLY the new title and edits the bookkeeping comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "g", bad: "", action_items: ["A"], commits: [] },
    };
    const first = await syncIssue(tracker, local);

    const updated: Issue = {
      ...first.updatedLocal,
      retro: {
        ...first.updatedLocal.retro,
        action_items: ["A", "B"],
      },
    };
    tracker.clearRequestLog();
    const second = await syncIssue(tracker, updated);

    const log = tracker.getRequestLog();
    const spawns = log.filter((l) => l.method === "addLinkedActionItemCard");
    expect(spawns).toHaveLength(1);
    expect((spawns[0].details as { title: string }).title).toBe("B");
    // Two editComment calls land here: one for the bookkeeping comment
    // (new B\t<external_id> row) and one for the retro comment itself
    // (its **Action items:** bullet list now includes B).
    const editCount = log.filter((l) => l.method === "editComment").length;
    expect(editCount).toBe(2);
    expect(second.remoteWriteCount).toBe(3); // 1 spawn + 2 edits
  });

  it("non-terminal status: action_items are NOT spawned even if populated", async () => {
    for (const status of ["In Progress", "Needs Help", "ToDo"] as const) {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const local: Issue = {
        ...(await tracker.getCard(external_id)),
        status,
        retro: {
          good: "",
          bad: "",
          action_items: ["A"],
          commits: [],
        },
      };
      tracker.clearRequestLog();
      await syncIssue(tracker, local);
      expect(
        tracker
          .getRequestLog()
          .some((l) => l.method === "addLinkedActionItemCard"),
        `expected zero spawns at status=${status}`,
      ).toBe(false);
    }
  });

  it("re-syncing after a combined first sync (retro + action_items + bookkeeping) yields zero remote writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: {
        good: "g",
        bad: "b",
        action_items: ["A", "B"],
        commits: ["abc123"],
      },
    };

    const first = await syncIssue(tracker, local);
    expect(first.remoteWriteCount).toBeGreaterThan(0);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);
    expect(second.remoteWriteCount).toBe(0);
    expect(
      tracker.getRequestLog().some(
        (l) =>
          l.method === "addComment" ||
          l.method === "editComment" ||
          l.method === "addLinkedActionItemCard",
      ),
    ).toBe(false);
  });

  it("renderActionItemsBookkeeping skips titles missing from the spawned map (silently — incomplete batch)", () => {
    const titles = ["A", "B", "C"];
    const partialSpawn = new Map([
      ["A", "mem-1"],
      // "B" missing — was scheduled but spawn failed mid-loop.
      ["C", "mem-3"],
    ]);
    const text = renderActionItemsBookkeeping(titles, partialSpawn);
    expect(text).toContain("- A\tmem-1");
    expect(text).toContain("- C\tmem-3");
    expect(text).not.toMatch(/- B\b/);
  });

  it("parseActionItemsBookkeeping throws on a bullet line missing the tab separator", () => {
    const text = `<!-- danxbot -->
<!-- danxbot-action-items -->

## Action Items spawned by retro

- A\tmem-1
- malformed line without a tab
- C\tmem-3`;
    expect(() => parseActionItemsBookkeeping(text)).toThrow(
      /Malformed action-items bookkeeping line/,
    );
  });

  it("parseActionItemsBookkeeping throws on a bullet line with empty title or empty external_id", () => {
    expect(() =>
      parseActionItemsBookkeeping(
        "<!-- danxbot-action-items -->\n\n-  \tmem-1",
      ),
    ).toThrow(/Malformed/);
    expect(() =>
      parseActionItemsBookkeeping(
        "<!-- danxbot-action-items -->\n\n- A\t",
      ),
    ).toThrow(/Malformed/);
  });

  it("attributes external_id correctly when titles contain arrow lookalikes", () => {
    // Regression test for card 69f771d6cbd1ada690743c73. Pre-hardening, the
    // separator was U+2192 '→' and a title carrying '->' or '⟶' or any other
    // arrow lookalike risked silent misattribution. Post-hardening the
    // separator is a tab — arrows in titles are inert.
    const titles = [
      "Fix: A -> B already-spawned",
      "Migrate ⟶ new shape",
      "Document → flow",
    ];
    const spawned = new Map([
      ["Fix: A -> B already-spawned", "mem-1"],
      ["Migrate ⟶ new shape", "mem-2"],
      ["Document → flow", "mem-3"],
    ]);
    const text = renderActionItemsBookkeeping(titles, spawned);
    const parsed = parseActionItemsBookkeeping(text);
    expect(parsed.get("Fix: A -> B already-spawned")).toBe("mem-1");
    expect(parsed.get("Migrate ⟶ new shape")).toBe("mem-2");
    expect(parsed.get("Document → flow")).toBe("mem-3");
  });

  it("parseActionItemsBookkeeping throws on a bullet line carrying multiple tabs", () => {
    // The validator forbids tab in titles and tracker external_ids never
    // contain tab, so a multi-tab bullet is corrupt input. Loud throw
    // beats silent misattribution.
    expect(() =>
      parseActionItemsBookkeeping(
        "<!-- danxbot-action-items -->\n\n- title\textra\tmem-1",
      ),
    ).toThrow(/multiple tab separators/);
  });

  it("renderActionItemsBookkeeping is byte-stable for the same inputs", () => {
    const titles = ["A", "B"];
    const map1 = new Map([
      ["A", "mem-1"],
      ["B", "mem-2"],
    ]);
    const map2 = new Map([
      ["A", "mem-1"],
      ["B", "mem-2"],
    ]);
    expect(renderActionItemsBookkeeping(titles, map1)).toBe(
      renderActionItemsBookkeeping(titles, map2),
    );
  });

  it("parseActionItemsBookkeeping round-trips its own output", () => {
    const titles = ["Fix X", "Document Y"];
    const spawned = new Map([
      ["Fix X", "mem-1"],
      ["Document Y", "mem-2"],
    ]);
    const text = renderActionItemsBookkeeping(titles, spawned);
    const parsed = parseActionItemsBookkeeping(text);
    expect(Array.from(parsed.entries())).toEqual([
      ["Fix X", "mem-1"],
      ["Document Y", "mem-2"],
    ]);
  });

  it("renderRetroComment formats action_items as a bullet list when populated, 'Nothing' inline when empty", () => {
    const populated = renderRetroComment({
      good: "g",
      bad: "b",
      action_items: ["a1", "a2"],
      commits: ["c1"],
    });
    expect(populated).toContain("**Action items:**\n- a1\n- a2");
    expect(populated).toContain("**Commits:** c1");

    const empty = renderRetroComment({
      good: "g",
      bad: "b",
      action_items: [],
      commits: [],
    });
    expect(empty).toContain("**Action items:** Nothing");
    expect(empty).toContain("**Commits:** —");
  });
});
