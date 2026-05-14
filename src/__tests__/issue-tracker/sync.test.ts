import { describe, it, expect } from "vitest";
import { MemoryTracker } from "../../issue-tracker/__test__-memory.js";
import {
  isRetroNonEmpty,
  renderRetroComment,
  syncIssue,
} from "../../issue-tracker/sync.js";
import {
  DANXBOT_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
} from "../../issue-tracker/markers.js";
import type {
  CreateCardInput,
  Issue,
  IssueRetro,
} from "../../issue-tracker/interface.js";

function defaultCreate(): CreateCardInput {
  return {
    schema_version: 7,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "T",
    description: "D",
    priority: 3.0,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    waiting_on: null,
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
    expect(result.updatedLocal.comments.map((c) => c.text)).toEqual([
      "from a human",
    ]);
    expect(result.remoteWriteCount).toBe(0); // comment merge is a read
  });

  // ---- ISS-87 (inbound channel discipline) ----

  it("inbound merge SKIPS bot-marked comments even when the local YAML has no matching id (no echo loop)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // Tracker has a danxbot-marked comment but local hasn't been
    // stamped with its id (simulates a different deployment, a worker
    // crash before id-stamping, or a manual API post that mimicked the
    // bot prefix). Pure id-dedup would re-import this and trigger an
    // echo loop on the next outbound. Marker check must catch it.
    await tracker.addComment(
      external_id,
      `${DANXBOT_COMMENT_MARKER}\n\nbot-mirrored body`,
    );
    const local = await tracker.getCard(external_id);
    const stripped: Issue = { ...local, comments: [] };
    const result = await syncIssue(tracker, stripped);
    expect(result.updatedLocal.comments).toHaveLength(0);
  });

  it("inbound merge ANCHORS the marker check — a human comment that QUOTES the marker mid-body is still pulled", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // A human reply that quotes the bot's prior comment (marker
    // appears mid-body, not at position 0). `includes` would suppress
    // this; anchored `startsWith` lets it through.
    await tracker.addComment(
      external_id,
      `Re: bot's note "${DANXBOT_COMMENT_MARKER}" — disagree.`,
    );
    const local = await tracker.getCard(external_id);
    const stripped: Issue = { ...local, comments: [] };
    const result = await syncIssue(tracker, stripped);
    expect(result.updatedLocal.comments).toHaveLength(1);
    expect(result.updatedLocal.comments[0].text).toContain("disagree");
  });

  it("inbound merge appends a human comment but skips a bot comment in the SAME pull", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tracker.addComment(external_id, "human one");
    await tracker.addComment(
      external_id,
      `${DANXBOT_COMMENT_MARKER}\n\nbot mirror`,
    );
    await tracker.addComment(external_id, "human two");
    const local = await tracker.getCard(external_id);
    const stripped: Issue = { ...local, comments: [] };
    const result = await syncIssue(tracker, stripped);
    expect(result.updatedLocal.comments.map((c) => c.text)).toEqual([
      "human one",
      "human two",
    ]);
  });

  it("inbound merge dedupes by id when local already carries the human comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tracker.addComment(external_id, "from a human");
    const local = await tracker.getCard(external_id);
    expect(local.comments).toHaveLength(1);
    // Re-sync with local already carrying the comment — no append.
    const result = await syncIssue(tracker, local);
    expect(result.updatedLocal.comments).toHaveLength(1);
  });

  it("tracker-side title edit does NOT propagate to YAML — next sync re-asserts local title onto the tracker", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    expect(local.title).toBe("T");
    // Simulate a human editing the title on the tracker UI.
    await tracker.updateCard(external_id, { title: "tracker-edit" });
    const remoteAfterEdit = await tracker.getCard(external_id);
    expect(remoteAfterEdit.title).toBe("tracker-edit");

    // Sync the (unchanged) local. YAML must stay "T", and the tracker
    // must be reverted to "T".
    const result = await syncIssue(tracker, local);
    expect(result.updatedLocal.title).toBe("T");
    const remoteAfterSync = await tracker.getCard(external_id);
    expect(remoteAfterSync.title).toBe("T");
  });

  it("tracker-side description / status / AC edits do NOT propagate to YAML", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    const originalDesc = local.description;
    const originalStatus = local.status;
    const originalAcChecked = local.ac[0].checked;

    // Mutate every inbound-forbidden field on the tracker.
    await tracker.updateCard(external_id, { description: "tracker desc" });
    await tracker.moveToStatus(external_id, "Done");
    await tracker.updateAcItem(external_id, local.ac[0].check_item_id, {
      checked: true,
    });

    const result = await syncIssue(tracker, local);
    expect(result.updatedLocal.description).toBe(originalDesc);
    expect(result.updatedLocal.status).toBe(originalStatus);
    expect(result.updatedLocal.ac[0].checked).toBe(originalAcChecked);
  });

  describe("orphan recovery (empty external_id → createCard)", () => {
    function orphan(): Issue {
      return {
        schema_version: 7,
        tracker: "memory",
        id: "ISS-1",
        external_id: "",
        parent_id: null,
        children: [],
        dispatch: null,
        status: "ToDo",
        type: "Bug",
        title: "Orphan",
        description: "body",
        priority: 3.0,
        position: null,
        triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
        ac: [{ check_item_id: "", title: "AC1", checked: false }],
        comments: [],
        retro: { good: "", bad: "", action_item_ids: [], commits: [] },
        blocked: null,
        assigned_agent: null,
        waiting_on: null,
        requires_human: null,
        conflict_on: [],
        history: [],
      };
    }

    it("calls tracker.createCard exactly once and never calls getCard/getComments with empty id", async () => {
      const tracker = new MemoryTracker();
      const result = await syncIssue(tracker, orphan());
      const log = tracker.getRequestLog();
      const methods = log.map((l) => l.method);
      expect(methods).toContain("createCard");
      const reads = log.filter(
        (l) =>
          (l.method === "getCard" || l.method === "getComments") &&
          l.externalId === "",
      );
      expect(reads).toEqual([]);
      expect(result.remoteWriteCount).toBe(1);
    });

    it("stamps external_id and check_item_ids onto updatedLocal", async () => {
      const tracker = new MemoryTracker();
      const result = await syncIssue(tracker, orphan());
      expect(result.updatedLocal.external_id).toMatch(/^mem-/);
      expect(result.updatedLocal.ac[0].check_item_id).toMatch(/^chk-/);
    });

    it("propagates createCard failure as a thrown error", async () => {
      const tracker = new MemoryTracker();
      tracker.failNextWrite(new Error("boom"));
      await expect(syncIssue(tracker, orphan())).rejects.toThrow("boom");
    });

    it("idempotent: re-syncing the stamped result issues zero writes", async () => {
      const tracker = new MemoryTracker();
      const first = await syncIssue(tracker, orphan());
      tracker.clearRequestLog();
      const second = await syncIssue(tracker, first.updatedLocal);
      expect(second.remoteWriteCount).toBe(0);
    });
  });

  it("title change → updateCard", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      title: "New",
    };
    tracker.clearRequestLog();
    const result = await syncIssue(tracker, local);
    expect(result.remoteWriteCount).toBe(1);
    expect(tracker.getRequestLog().some((l) => l.method === "updateCard")).toBe(
      true,
    );
  });

  it("status change → moveToStatus", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "In Progress",
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    expect(
      tracker.getRequestLog().some((l) => l.method === "moveToStatus"),
    ).toBe(true);
  });

  it("type change → setLabels", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      type: "Bug",
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    expect(tracker.getRequestLog().some((l) => l.method === "setLabels")).toBe(
      true,
    );
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


  it("local comment without id → addComment, marker prepended, id stamped", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local = await tracker.getCard(external_id);
    local.comments.push({ author: "", timestamp: "", text: "hello" });

    const result = await syncIssue(tracker, local);

    const newComment = result.updatedLocal.comments.find((c) =>
      c.text.includes("hello"),
    );
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
    const stamped = result.updatedLocal.comments.find(
      (c) => c.text === original,
    );
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

  it("derives blocked:true from status='Blocked' (gap C)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Blocked",
      blocked: {
        reason: "self-blocked",
        timestamp: "2026-05-04T18:00:00.000Z",
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect(
      (setLabels!.details as { labels: { blocked: boolean } }).labels
        .blocked,
    ).toBe(true);
  });

  it("derives blocked:false for non-Blocked statuses (gap C)", async () => {
    const tracker = new MemoryTracker();
    // Seed in Blocked so the diff fires when we move out of it.
    const { external_id } = await tracker.createCard(defaultCreate());
    // Move remote to Blocked so its labels reflect that.
    await tracker.moveToStatus(external_id, "Blocked");
    await tracker.setLabels(external_id, {
      type: "Feature",
      blocked: true,
      requires_human: false,
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
    expect(
      (setLabels!.details as { labels: { blocked: boolean } }).labels
        .blocked,
    ).toBe(false);
  });

  it("Phase 3 (DX-234): requires_human-only diff DOES fire setLabels — the Phase 1 suppression is reinstated", async () => {
    // DX-231 Phase 3 (DX-234) wired `TrelloConfig.requiresHumanLabelId`
    // through `projectLabels` / `resolveLabelIds` and reinstated the
    // diff predicate clause: when the local YAML carries a non-null
    // `requires_human` record but the remote label set has it `false`,
    // sync now fires exactly one `setLabels` mutation to apply the
    // label. The Phase 1 churn-prevention rationale (the projection
    // always read `false`) no longer holds — projection now reads from
    // the actual label state.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      requires_human: {
        reason: "Need Stripe API key rotated",
        steps: ["Roll the Stripe secret", "Update DANX_STRIPE_KEY"],
        set_by: "agent",
        set_at: "2026-05-10T12:00:00.000Z",
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    const labels = (
      setLabels!.details as { labels: { requires_human: boolean } }
    ).labels;
    expect(labels.requires_human).toBe(true);
  });

  it("Phase 3 (DX-234): clearing requires_human (non-null → null) fires setLabels to strip the label", async () => {
    // The reverse of the apply path: when the local YAML clears the
    // requires_human record, the remote (which previously had the
    // label) must have it stripped. Sync's diff predicate sees the
    // local `false` vs remote `true` mismatch and fires one mutation.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // Seed: stamp a requires_human label on the remote first.
    await tracker.setLabels(external_id, {
      type: "Feature",
      blocked: false,
      requires_human: true,
      triaged: false,
    });
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      requires_human: null,
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    const labels = (
      setLabels!.details as { labels: { requires_human: boolean } }
    ).labels;
    expect(labels.requires_human).toBe(false);
  });

  it("setLabels payload carries requires_human boolean when other labels do diff", async () => {
    // Pin: when status flips Blocked (which fires the diff via the
    // blocked predicate), the setLabels payload still carries
    // `requires_human: true` derived from the orthogonal field — so a
    // tracker that has provisioned the matching label applies it in
    // the same single mutation.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Blocked",
      blocked: { reason: "self-block", timestamp: "2026-05-10T00:00:00.000Z" },
      requires_human: {
        reason: "Need Stripe API key rotated",
        steps: ["Roll the Stripe secret"],
        set_by: "agent",
        set_at: "2026-05-10T12:00:00.000Z",
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    const labels = (
      setLabels!.details as {
        labels: { requires_human: boolean; blocked: boolean };
      }
    ).labels;
    expect(labels.requires_human).toBe(true);
    expect(labels.blocked).toBe(true);
  });

  it("derives blocked:true from local.blocked != null and pushes the Blocked label", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Blocked",
      blocked: {
        reason: "self-blocked",
        timestamp: "2026-05-04T18:00:00.000Z",
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
      history: [],
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeUndefined();
  });

  it("derives triaged:true when triage.history[] has at least one entry (gap C)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      triage: { expires_at: "", reassess_hint: "", last_status: "ok", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [{ timestamp: "2026-05-01T00:00:00Z", status: "ok", explain: "", expires_at: "", ice: { total: 0, i: 0, c: 0, e: 0 } }] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);
    const setLabels = tracker
      .getRequestLog()
      .find((l) => l.method === "setLabels");
    expect(setLabels).toBeDefined();
    expect(
      (setLabels!.details as { labels: { triaged: boolean } }).labels.triaged,
    ).toBe(true);
  });

  it("derives triaged:false when triage.history[] is empty (gap C)", async () => {
    // Build a tracker pre-seeded with a card whose triage record IS set on
    // the server (via seed Issue), then sync a local that has cleared it.
    const seed: Issue = {
      schema_version: 7,
      tracker: "memory",
      id: "ISS-2",
      external_id: "card-triaged",
      parent_id: null,
      children: [],
      dispatch: null,
      status: "ToDo",
      type: "Feature",
      title: "T",
      description: "D",
      priority: 3.0,
      position: null,
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "ok",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [
          {
            timestamp: "2026-04-30T00:00:00Z",
            status: "ok",
            explain: "",
            expires_at: "",
            ice: { total: 0, i: 0, c: 0, e: 0 },
          },
        ],
      },
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      assigned_agent: null,
      waiting_on: null,
      requires_human: null,
      conflict_on: [],
      history: [],
    };
    const tracker = new MemoryTracker({ seed: [seed] });
    const local: Issue = {
      ...(await tracker.getCard("card-triaged")),
      triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
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
    expect(
      (setLabels!.details as { labels: { triaged: boolean } }).labels.triaged,
    ).toBe(false);
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

  it("local-as-truth wins on every non-comment field", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      title: "Local Title",
      description: "Local Desc",
      status: "Blocked",
      type: "Bug",
    };
    await syncIssue(tracker, local);
    const after = await tracker.getCard(external_id);
    expect(after.title).toBe("Local Title");
    expect(after.description).toBe("Local Desc");
    expect(after.status).toBe("Blocked");
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
      retro: { good: "shipped", bad: "hard", action_item_ids: [], commits: [] },
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

  it("retro renderer is a no-op on non-terminal status (In Progress / Blocked)", async () => {
    for (const status of ["In Progress", "Blocked"] as const) {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(defaultCreate());
      const local: Issue = {
        ...(await tracker.getCard(external_id)),
        status,
        retro: { good: "g", bad: "b", action_item_ids: ["x"], commits: ["c"] },
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
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    };
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(tracker.getRequestLog().some((l) => l.method === "addComment")).toBe(
      false,
    );
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
        action_item_ids: ["fix x"],
        commits: ["abc123"],
      },
    };

    const first = await syncIssue(tracker, local);
    // First sync wrote retro + moveToStatus.
    expect(first.remoteWriteCount).toBeGreaterThan(0);
    expect(
      first.updatedLocal.comments.some((c) =>
        c.text.includes(RETRO_COMMENT_MARKER),
      ),
    ).toBe(true);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);

    expect(second.remoteWriteCount).toBe(0);
    expect(
      tracker
        .getRequestLog()
        .some((l) => l.method === "addComment" || l.method === "editComment"),
    ).toBe(false);
  });

  it("editing retro.good triggers editComment on the existing retro comment, NOT a new addComment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "v1", bad: "b", action_item_ids: [], commits: [] },
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
      retro: {
        good: "actual new retro",
        bad: "",
        action_item_ids: [],
        commits: [],
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const allComments = await tracker.getComments(external_id);
    const workerRendered = allComments.filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(workerRendered).toHaveLength(1);
    expect(workerRendered[0].text).toContain(
      "**What went well:** actual new retro",
    );
  });

  // DX-503 — duplicate retro regression.
  //
  // Symptom in prod: a Done card lands with two `## Retro` comments on
  // the tracker.
  //
  // Root cause: the inbound `newRemote` filter at the top of `syncIssue`
  // strips every comment whose body starts with `DANXBOT_COMMENT_MARKER`
  // (echo-loop guard — see `isBotMirroredComment`). The worker's own
  // prior retro POST carries that marker as its FIRST line, so the
  // inbound view never re-includes it. The retro renderer's three-branch
  // lookup (`findCommentByMarker` → `hasLegacyRetroComment` → fresh
  // `addComment`) ONLY consults `knownCommentsForRetro` (= local +
  // `newRemote`); if `local.comments[]` doesn't carry the retro id —
  // because the agent re-Wrote the YAML and clobbered persistIfDifferent's
  // stamp, or a fresh dispatch picked up the card mid-flight before the
  // mirror loop closed — neither branch fires the "already posted, skip
  // / edit" path. Renderer falls through to `addComment` and the tracker
  // accrues a second retro.
  //
  // Fix surface: the retro detection lookup MUST consult the unfiltered
  // `remoteComments` view as a fallback so the worker recognizes its own
  // prior POST regardless of local YAML state.
  it("DX-503: retro renderer detects worker-rendered retro on the remote even when local.comments[] does not carry the retro id (no duplicate)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    // Tick 1: agent saves Done with retro → syncIssue posts retro.
    const tick1Local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "g", bad: "b", action_item_ids: [], commits: [] },
    };
    await syncIssue(tracker, tick1Local);

    const afterTick1 = await tracker.getComments(external_id);
    const retroAfterTick1 = afterTick1.filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retroAfterTick1).toHaveLength(1);

    // Tick 2: simulate the prod failure mode — local.comments[] is empty
    // (agent re-Wrote the YAML, persistIfDifferent never landed, or a
    // fresh dispatch reloaded from a stale source). Status + retro
    // unchanged from tick 1, so renderer's `desiredText` is byte-identical
    // to what's already on the tracker.
    const tick2Local: Issue = {
      ...(await tracker.getCard(external_id)),
      comments: [],
      status: "Done",
      retro: { good: "g", bad: "b", action_item_ids: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, tick2Local);

    const log = tracker.getRequestLog();
    expect(
      log.filter((l) => l.method === "addComment"),
      "renderer must consult the unfiltered remote view; bot-mirror filter blinds it to its own prior retro POST",
    ).toEqual([]);

    const afterTick2 = await tracker.getComments(external_id);
    const retros = afterTick2.filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retros).toHaveLength(1);
  });

  // Same mechanism, edit path: stale local + retro body change must
  // resolve to editComment on the remote retro, not addComment.
  it("DX-503: stale local.comments[] + retro body change resolves to editComment on the remote retro, never a fresh addComment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    // Tick 1.
    const tick1Local: Issue = {
      ...(await tracker.getCard(external_id)),
      status: "Done",
      retro: { good: "v1", bad: "b", action_item_ids: [], commits: [] },
    };
    await syncIssue(tracker, tick1Local);

    // Tick 2 — stale local view but the agent updated `retro.good`.
    const tick2Local: Issue = {
      ...(await tracker.getCard(external_id)),
      comments: [],
      status: "Done",
      retro: { good: "v2", bad: "b", action_item_ids: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, tick2Local);

    const log = tracker.getRequestLog();
    expect(log.some((l) => l.method === "editComment")).toBe(true);
    expect(log.some((l) => l.method === "addComment")).toBe(false);

    const retros = (await tracker.getComments(external_id)).filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retros).toHaveLength(1);
    expect(retros[0].text).toContain("**What went well:** v2");
  });

  // DX-503 — legacy-shape variant of the same blind spot. A Phase-4 retro
  // (DANXBOT_COMMENT_MARKER + ## Retro, NO RETRO_COMMENT_MARKER) is also
  // bot-mirrored, so the inbound filter also strips it. Stale local +
  // legacy retro on remote must still resolve to the no-op `legacy` branch,
  // not a fresh addComment.
  it("DX-503: legacy retro on remote is NOT duplicated when local.comments[] is stale", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    const legacyText = `${DANXBOT_COMMENT_MARKER}\n\n## Retro\n\n**What went well:** old\n`;
    await tracker.addComment(external_id, legacyText);

    // Local view does NOT carry the legacy retro id (stale or fresh agent).
    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      comments: [],
      status: "Done",
      retro: { good: "new", bad: "", action_item_ids: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const log = tracker.getRequestLog();
    expect(
      log.filter((l) => l.method === "addComment"),
      "legacy retro on the remote must suppress fresh post even when local view is stale",
    ).toEqual([]);

    const allComments = await tracker.getComments(external_id);
    const retroish = allComments.filter((c) => c.text.includes("## Retro"));
    expect(retroish).toHaveLength(1);
  });

  // DX-503 — locks the spec invariant that legacy retros are NEVER
  // edited (no RETRO_COMMENT_MARKER to re-locate); the renderer no-ops
  // on the legacy branch regardless of body delta. Without this pin a
  // future contributor could "helpfully" wire legacy editing through
  // `hasLegacyRetroComment` and accidentally migrate Phase-4 retros.
  it("DX-503: stale local + legacy retro on remote + retro body change resolves to no-op (legacy is NEVER edited)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    const legacyText = `${DANXBOT_COMMENT_MARKER}\n\n## Retro\n\n**What went well:** legacy v1\n`;
    await tracker.addComment(external_id, legacyText);

    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      comments: [],
      status: "Done",
      retro: {
        good: "fresh body that differs from legacy",
        bad: "",
        action_item_ids: [],
        commits: [],
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const log = tracker.getRequestLog();
    expect(log.some((l) => l.method === "addComment")).toBe(false);
    expect(log.some((l) => l.method === "editComment")).toBe(false);

    const allComments = await tracker.getComments(external_id);
    const retroish = allComments.filter((c) => c.text.includes("## Retro"));
    expect(retroish).toHaveLength(1);
    expect(retroish[0].text).toBe(legacyText);
  });

  // DX-503 — marker-poisoning robustness. `isBotMirroredComment` is
  // anchored `startsWith(DANXBOT_COMMENT_MARKER)`. A retro that lost
  // its leading DANXBOT marker (tracker normalization, hand-edited
  // body, etc.) but still carries RETRO_COMMENT_MARKER somewhere in
  // the body does NOT trip the bot-mirror filter → flows through the
  // normal inbound merge → lands in local.comments[] via newRemote
  // → `findCommentByMarker(knownCommentsForRetro, ...)` hits it. Pins
  // that the OR-fallback's first arm still does work in that path.
  it("DX-503: retro carrying RETRO_COMMENT_MARKER but missing leading DANXBOT_COMMENT_MARKER is visible via the normal inbound merge", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    // Hand-craft a retro that lost the leading marker but kept the
    // retro marker mid-body.
    const poisonedText = `${RETRO_COMMENT_MARKER}\n\n## Retro\n\n**What went well:** prior body\n`;
    await tracker.addComment(external_id, poisonedText);

    const local: Issue = {
      ...(await tracker.getCard(external_id)),
      comments: [],
      status: "Done",
      retro: {
        good: "prior body",
        bad: "",
        action_item_ids: [],
        commits: [],
      },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    // `isBotMirroredComment` did NOT strip the comment (no leading
    // DANXBOT marker), so the inbound merge added it to local via
    // `newRemote` → `findCommentByMarker(knownCommentsForRetro, ...)`
    // found it via the FIRST arm of the OR-fallback. Body differs from
    // desiredText (which carries both markers as the canonical shape),
    // so editComment fires once. The key guarantee: NO addComment.
    const log = tracker.getRequestLog();
    expect(
      log.filter((l) => l.method === "addComment"),
      "marker-poisoned retro must not produce a duplicate",
    ).toEqual([]);
    const retros = (await tracker.getComments(external_id)).filter((c) =>
      c.text.includes(RETRO_COMMENT_MARKER),
    );
    expect(retros).toHaveLength(1);
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
      retro: { good: "new", bad: "", action_item_ids: [], commits: [] },
    };
    tracker.clearRequestLog();
    await syncIssue(tracker, local);

    const allComments = await tracker.getComments(external_id);
    const retroish = allComments.filter((c) => c.text.includes("## Retro"));
    // Exactly the legacy one — no duplicate worker-rendered comment.
    expect(retroish).toHaveLength(1);
    expect(retroish[0].text).toBe(legacyText);
    expect(tracker.getRequestLog().some((l) => l.method === "addComment")).toBe(
      false,
    );
  });

  it("isRetroNonEmpty is true if any single field is populated", () => {
    expect(
      isRetroNonEmpty({ good: "g", bad: "", action_item_ids: [], commits: [] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "b", action_item_ids: [], commits: [] }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({
        good: "",
        bad: "",
        action_item_ids: ["x"],
        commits: [],
      }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({
        good: "",
        bad: "",
        action_item_ids: [],
        commits: ["c"],
      }),
    ).toBe(true);
    expect(
      isRetroNonEmpty({ good: "", bad: "", action_item_ids: [], commits: [] }),
    ).toBe(false);
  });

  it("renderRetroComment resolves action_item_ids to titles via supplied resolver, 'Nothing' inline when empty", () => {
    const resolved = renderRetroComment(
      {
        good: "g",
        bad: "b",
        action_item_ids: ["ISS-101", "ISS-102"],
        commits: ["c1"],
      },
      new Map([
        ["ISS-101", "Refactor IodDirectiveResolutionTrait"],
        ["ISS-102", "Add tests for X"],
      ]),
    );
    expect(resolved).toContain(
      "**Action items:**\n- Refactor IodDirectiveResolutionTrait (ISS-101)\n- Add tests for X (ISS-102)",
    );
    expect(resolved).toContain("**Commits:** c1");

    const empty = renderRetroComment({
      good: "g",
      bad: "b",
      action_item_ids: [],
      commits: [],
    });
    expect(empty).toContain("**Action items:** Nothing");
    expect(empty).toContain("**Commits:** —");
  });

  it("renderRetroComment surfaces unknown ids as <ISS-N: unknown> when resolver missing or incomplete", () => {
    const noResolver = renderRetroComment({
      good: "",
      bad: "",
      action_item_ids: ["ISS-999"],
      commits: [],
    });
    expect(noResolver).toContain("- <ISS-999: unknown>");

    const partialResolver = renderRetroComment(
      {
        good: "",
        bad: "",
        action_item_ids: ["ISS-1", "ISS-2"],
        commits: [],
      },
      new Map([["ISS-1", "Known"]]),
    );
    expect(partialResolver).toContain("- Known (ISS-1)");
    expect(partialResolver).toContain("- <ISS-2: unknown>");
  });

  it("renderRetroComment is byte-stable for the same (retro, resolver) input", () => {
    const retro: IssueRetro = {
      good: "g",
      bad: "b",
      action_item_ids: ["ISS-1", "ISS-2"],
      commits: ["sha1"],
    };
    const resolver = new Map([
      ["ISS-1", "Title One"],
      ["ISS-2", "Title Two"],
    ]);
    const a = renderRetroComment(retro, resolver);
    const b = renderRetroComment(retro, resolver);
    expect(a).toBe(b);
  });

  it("renderRetroComment unknown-id literal is exactly '<ISS-N: unknown>'", () => {
    const out = renderRetroComment({
      good: "",
      bad: "",
      action_item_ids: ["ISS-7"],
      commits: [],
    });
    // Verbatim literal so callers can grep for the marker if they need to
    // surface stale references in tooling.
    expect(out).toContain("- <ISS-7: unknown>");
  });

  // ---- ISS-88 (Slice C: outbound full-fidelity mirror audit) ----
  //
  // These tests codify which Issue fields are intentionally NOT mirrored
  // outbound. Sync's diff loop only writes title / description / status /
  // labels / ac / comments / retro. `parent_id`, `children`, and
  // `dispatch_id` are local-only metadata — mutating them MUST NOT trigger
  // any tracker write, ever. Without these tests a future contributor
  // could silently wire one through and the only signal would be doubled
  // tracker traffic in production.

  it("children[] is local-only — mutating local.children issues zero tracker writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);
    const local: Issue = {
      ...fresh,
      children: ["ISS-42", "ISS-43"],
    };
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(result.remoteWriteCount).toBe(0);
    const methods = tracker.getRequestLog().map((l) => l.method);
    expect(methods.sort()).toEqual(["getCard", "getComments"]);
  });

  it("parent_id is local-only — mutating local.parent_id issues zero tracker writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);
    const local: Issue = { ...fresh, parent_id: "ISS-99" };
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(result.remoteWriteCount).toBe(0);
  });

  it("dispatch_id is local-only — mutating local.dispatch?.id issues zero tracker writes", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);
    const local: Issue = {
      ...fresh,
      dispatch: { id: "61ef8878-c2be-4920-8294-678619ef5ea2", pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
    };
    tracker.clearRequestLog();

    const result = await syncIssue(tracker, local);

    expect(result.remoteWriteCount).toBe(0);
  });

  it("comprehensive idempotency: full-populated YAML re-syncs with zero writes across every diffable field", async () => {
    // Sets every mirrored field to a non-default value, syncs once to push,
    // then re-syncs and asserts zero writes — covers title / description /
    // status / labels (type + needsHelp + requires_human + triaged + blocked)
    // / AC items / bot comments / retro in one round-trip.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);
    const local: Issue = {
      ...fresh,
      title: "Full populated",
      description: "With body",
      status: "Done",
      type: "Bug",
      triage: {
        expires_at: "",
        reassess_hint: "",
        last_status: "ok",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [
          {
            timestamp: "2026-05-05T00:00:00Z",
            status: "ok",
            explain: "",
            expires_at: "",
            ice: { total: 0, i: 0, c: 0, e: 0 },
          },
        ],
      },
      ac: [
        { check_item_id: fresh.ac[0].check_item_id, title: "AC1", checked: true },
        { check_item_id: "", title: "AC2", checked: false },
      ],
      comments: [
        { author: "danxbot", timestamp: "2026-05-05T00:00:01Z", text: "fresh note" },
      ],
      retro: {
        good: "shipped",
        bad: "rough",
        action_item_ids: [],
        commits: ["abc1234"],
      },
      blocked: null,
      assigned_agent: null,
      waiting_on: null,
      history: [],
    };

    const first = await syncIssue(tracker, local);
    expect(first.remoteWriteCount).toBeGreaterThan(0);

    tracker.clearRequestLog();
    const second = await syncIssue(tracker, first.updatedLocal);

    expect(second.remoteWriteCount).toBe(0);
    const methods = tracker.getRequestLog().map((l) => l.method);
    expect(methods.sort()).toEqual(["getCard", "getComments"]);
  });

  it("blocked label idempotency: waiting_on.reason / by[] mutations alone produce zero writes (only the blocked status is mirrored)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const fresh = await tracker.getCard(external_id);

    // First sync flips status to Blocked → setLabels write.
    const blocked: Issue = {
      ...fresh,
      status: "Blocked",
      blocked: {
        reason: "Self-blocked",
        timestamp: "2026-05-05T00:00:00Z",
      },
    };
    const first = await syncIssue(tracker, blocked);
    expect(first.remoteWriteCount).toBeGreaterThan(0);

    // Re-sync with DIFFERENT reason but same status → zero writes.
    tracker.clearRequestLog();
    const reworded: Issue = {
      ...first.updatedLocal,
      blocked: {
        reason: "Different reason — same blocked semantics",
        timestamp: "2026-05-06T00:00:00Z",
      },
    };
    const second = await syncIssue(tracker, reworded);

    expect(second.remoteWriteCount).toBe(0);
  });
});
