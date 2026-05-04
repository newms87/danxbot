import { describe, expect, it } from "vitest";
import { MemoryTracker } from "../../issue-tracker/memory.js";
import {
  LOCK_TTL_MS,
  parseLockComment,
  renderLockComment,
  tryAcquireLock,
} from "../../issue-tracker/lock.js";
import {
  DANXBOT_COMMENT_MARKER,
  LOCK_COMMENT_MARKER,
} from "../../issue-tracker/markers.js";
import type { CreateCardInput } from "../../issue-tracker/interface.js";

const HOLDER_A = {
  holder: "gpt",
  host: "ip-172-31-93-196",
  dispatchId: "11111111-1111-1111-1111-111111111111",
  repoPath: "/danxbot/app/repos/gpt-manager",
  jsonlDir:
    "/home/danxbot/.claude/projects/-danxbot-app-repos-gpt-manager--danxbot-workspaces-issue-worker",
  workspace: "issue-worker",
};

const HOLDER_B = {
  holder: "newms-laptop",
  host: "newms-wsl",
  dispatchId: "22222222-2222-2222-2222-222222222222",
  repoPath: "/home/newms/web/gpt-manager",
  jsonlDir:
    "/home/newms/.claude/projects/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker",
  workspace: "issue-worker",
};

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
    ac: [],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_items: [], commits: [] },
  };
}

describe("renderLockComment + parseLockComment round-trip", () => {
  it("preserves all fields", () => {
    const startedAt = "2026-05-04T07:00:00.000Z";
    const text = renderLockComment(HOLDER_A, startedAt);
    expect(text).toContain(DANXBOT_COMMENT_MARKER);
    expect(text).toContain(LOCK_COMMENT_MARKER);
    const parsed = parseLockComment(text, "comment-id-xyz");
    expect(parsed).not.toBeNull();
    expect(parsed!.holder).toBe(HOLDER_A.holder);
    expect(parsed!.host).toBe(HOLDER_A.host);
    expect(parsed!.dispatchId).toBe(HOLDER_A.dispatchId);
    expect(parsed!.repoPath).toBe(HOLDER_A.repoPath);
    expect(parsed!.jsonlDir).toBe(HOLDER_A.jsonlDir);
    expect(parsed!.workspace).toBe(HOLDER_A.workspace);
    expect(parsed!.startedAt).toBe(startedAt);
    expect(parsed!.commentId).toBe("comment-id-xyz");
  });

  it("renders stale_after as startedAt + ttl", () => {
    const startedAt = "2026-05-04T07:00:00.000Z";
    const text = renderLockComment(HOLDER_A, startedAt);
    expect(text).toContain("stale_after");
    expect(text).toContain("2026-05-04T09:00:00.000Z");
  });

  it("returns null when text lacks lock marker", () => {
    expect(parseLockComment("just a regular comment", "id")).toBeNull();
  });

  it("returns null when required fields missing", () => {
    const broken = `${DANXBOT_COMMENT_MARKER}\n${LOCK_COMMENT_MARKER}\n\nno table here`;
    expect(parseLockComment(broken, "id")).toBeNull();
  });
});

describe("tryAcquireLock", () => {
  it("acquires on a card with no existing lock comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBeUndefined();
    expect(result.refreshed).toBeUndefined();
    expect(result.comment.text).toContain(LOCK_COMMENT_MARKER);
    expect(result.comment.id).toBeTruthy();

    // Comment was actually written to the tracker.
    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);
  });

  it("refuses to acquire when held by another holder within TTL", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // 30 minutes later, holder B tries.
    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      new Date("2026-05-04T07:30:00.000Z"),
    );

    expect(result.acquired).toBe(false);
    expect(result.existing).toBeDefined();
    expect(result.existing!.holder).toBe(HOLDER_A.holder);
    expect(result.existing!.dispatchId).toBe(HOLDER_A.dispatchId);
  });

  it("reclaims a stale lock (>= TTL) and edits the existing comment in-place", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    const first = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      startedAt,
    );
    expect(first.acquired).toBe(true);
    const lockCommentId = first.comment.id;

    // 2h+1ms later, holder B tries.
    const reclaimAt = new Date(startedAt.getTime() + LOCK_TTL_MS + 1);
    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      reclaimAt,
    );

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);
    expect(result.comment.id).toBe(lockCommentId);

    // Still exactly one lock comment, now owned by B.
    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);
    const parsed = parseLockComment(lockComments[0].text, lockComments[0].id);
    expect(parsed!.holder).toBe(HOLDER_B.holder);
    expect(parsed!.dispatchId).toBe(HOLDER_B.dispatchId);
  });

  it("refreshes the lock when the same holder re-acquires within TTL", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    const first = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      startedAt,
    );
    const lockCommentId = first.comment.id;

    // Same holder, new dispatch, within TTL.
    const refreshHolder = {
      ...HOLDER_A,
      dispatchId: "33333333-3333-3333-3333-333333333333",
    };
    const refreshAt = new Date("2026-05-04T07:30:00.000Z");
    const result = await tryAcquireLock(
      tracker,
      external_id,
      refreshHolder,
      refreshAt,
    );

    expect(result.acquired).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.comment.id).toBe(lockCommentId);

    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);
    const parsed = parseLockComment(lockComments[0].text, lockComments[0].id);
    expect(parsed!.dispatchId).toBe(refreshHolder.dispatchId);
    expect(parsed!.startedAt).toBe(refreshAt.toISOString());
  });

  it("treats age == LOCK_TTL_MS as stale (>= boundary)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // Exactly at TTL → stale → other holder reclaims.
    const exactlyAtTtl = new Date(startedAt.getTime() + LOCK_TTL_MS);
    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      exactlyAtTtl,
    );

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);
  });

  it("treats age == LOCK_TTL_MS - 1 as fresh (rejects other holder)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // 1ms before TTL → still fresh → other holder refused.
    const justBeforeTtl = new Date(startedAt.getTime() + LOCK_TTL_MS - 1);
    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      justBeforeTtl,
    );

    expect(result.acquired).toBe(false);
    expect(result.existing!.holder).toBe(HOLDER_A.holder);
  });

  it("treats same holder name on different host as another instance and refuses within TTL", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // Same holder name, different host (e.g. two prod boxes sharing a
    // deploy target). Self-discrimination must check both fields.
    const sameNameDifferentHost = {
      ...HOLDER_A,
      host: "ip-10-0-0-99",
      dispatchId: "44444444-4444-4444-4444-444444444444",
    };
    const result = await tryAcquireLock(
      tracker,
      external_id,
      sameNameDifferentHost,
      new Date("2026-05-04T07:30:00.000Z"),
    );

    expect(result.acquired).toBe(false);
    expect(result.existing!.host).toBe(HOLDER_A.host);
  });

  it("invariant: one comment per card lifetime across acquire→reclaim→refresh", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const t0 = new Date("2026-05-04T07:00:00.000Z");

    // Acquire (POST), then stale-reclaim by other (EDIT), then
    // self-refresh by reclaimer (EDIT). Three operations total — must
    // produce exactly one tracker comment in the end.
    await tryAcquireLock(tracker, external_id, HOLDER_A, t0);
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      new Date(t0.getTime() + LOCK_TTL_MS + 1),
    );
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      new Date(t0.getTime() + LOCK_TTL_MS + 60_000),
    );

    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);

    // And the request log shows one addComment + two editComment.
    const log = tracker.getRequestLog();
    const addCalls = log.filter((l) => l.method === "addComment");
    const editCalls = log.filter((l) => l.method === "editComment");
    expect(addCalls).toHaveLength(1);
    expect(editCalls).toHaveLength(2);
  });

  it("overwrites an unparseable lock comment (legacy/corrupted)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    // Seed a malformed lock comment.
    await tracker.addComment(
      external_id,
      `${DANXBOT_COMMENT_MARKER}\n${LOCK_COMMENT_MARKER}\n\nno-fields-here`,
    );

    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);
    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);
    expect(
      parseLockComment(lockComments[0].text, lockComments[0].id),
    ).not.toBeNull();
  });
});
