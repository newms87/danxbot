import { describe, expect, it } from "vitest";
import { MemoryTracker } from "../../issue-tracker/__test__-memory.js";
import {
  LOCK_TTL_MS,
  parseLockComment,
  releaseLock,
  renderLockComment,
  renderReleasedLockComment,
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
  hostPid: 9001,
  dispatchId: "11111111-1111-1111-1111-111111111111",
  repoPath: "/danxbot/app/repos/gpt-manager",
  jsonlDir:
    "/home/danxbot/.claude/projects/-danxbot-app-repos-gpt-manager--danxbot-workspaces-issue-worker",
  workspace: "issue-worker",
};

const HOLDER_B = {
  holder: "newms-laptop",
  host: "newms-wsl",
  hostPid: 9002,
  dispatchId: "22222222-2222-2222-2222-222222222222",
  repoPath: "/home/newms/web/gpt-manager",
  jsonlDir:
    "/home/newms/.claude/projects/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker",
  workspace: "issue-worker",
};

const ALL_PIDS_ALIVE = (): boolean => true;
const ALL_PIDS_DEAD = (): boolean => false;

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
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    waiting_on: null,
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
    expect(parsed!.hostPid).toBe(HOLDER_A.hostPid);
    expect(parsed!.dispatchId).toBe(HOLDER_A.dispatchId);
    expect(parsed!.repoPath).toBe(HOLDER_A.repoPath);
    expect(parsed!.jsonlDir).toBe(HOLDER_A.jsonlDir);
    expect(parsed!.workspace).toBe(HOLDER_A.workspace);
    expect(parsed!.startedAt).toBe(startedAt);
    expect(parsed!.commentId).toBe("comment-id-xyz");
    expect(parsed!.releasedAt).toBe("");
  });

  it("renders host_pid as an integer row", () => {
    const text = renderLockComment(HOLDER_A, "2026-05-04T07:00:00.000Z");
    expect(text).toMatch(/\| host_pid \| `9001` \|/);
  });

  it("parses legacy lock comments that pre-date host_pid (host_pid defaults to 0)", () => {
    // Hand-rolled body without the host_pid row — represents a comment
    // written by a pre-DX-241 worker. The new parser must NOT reject it
    // (worker swap during the rollout would leave both shapes on the
    // tracker for a transition window).
    const legacyBody = `${DANXBOT_COMMENT_MARKER}
${LOCK_COMMENT_MARKER}

| Field | Value |
|---|---|
| holder | \`gpt\` |
| host | \`ip-172-31-93-196\` |
| dispatch_id | \`legacy-uuid\` |
| repo_path | \`/danxbot/app/repos/gpt-manager\` |
| jsonl_dir | \`/some/dir\` |
| workspace | \`issue-worker\` |
| started_at | \`2026-05-04T07:00:00.000Z\` |
| ttl | \`120m\` |
| stale_after | \`2026-05-04T09:00:00.000Z\` |`;
    const parsed = parseLockComment(legacyBody, "id-legacy");
    expect(parsed).not.toBeNull();
    expect(parsed!.hostPid).toBe(0);
    expect(parsed!.dispatchId).toBe("legacy-uuid");
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

describe("tryAcquireLock — host_pid + isPidAlive", () => {
  it("reclaims a same-host lock whose host_pid is dead, even within TTL", async () => {
    // Failure mode #1 from the card description: worker stops mid-dispatch,
    // leaves a fresh-looking lock with a now-dead PID. Without the liveness
    // check the next dispatch on the same host has to wait ~2h for TTL.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // 30 minutes later, ANOTHER holder on the SAME host tries (e.g. the
    // operator restarted the docker worker and the new container reads
    // the same hostname when running `--net=host`). The prior PID is now
    // dead → liveness check declares the lock stale → reclaim.
    const sameHostDifferentHolder = {
      ...HOLDER_B,
      host: HOLDER_A.host,
      hostPid: 9999,
    };
    const result = await tryAcquireLock(
      tracker,
      external_id,
      sameHostDifferentHolder,
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_DEAD,
    );

    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);
  });

  it("does NOT reclaim a same-host lock whose host_pid is alive within TTL", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    const sameHostDifferentHolder = {
      ...HOLDER_B,
      host: HOLDER_A.host,
      hostPid: 9999,
    };
    const result = await tryAcquireLock(
      tracker,
      external_id,
      sameHostDifferentHolder,
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_ALIVE,
    );

    expect(result.acquired).toBe(false);
    expect(result.existing!.holder).toBe(HOLDER_A.holder);
  });

  it("does NOT cross-host liveness-check (different host always falls through to TTL)", async () => {
    // Different physical host can't safely peek into another host's PID
    // table. Cross-host stale detection MUST stay TTL-based; the
    // releaseLock path is what handles cross-host stop.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    let isPidAliveCalls = 0;
    const trackingIsPidAlive = (): boolean => {
      isPidAliveCalls++;
      return false;
    };

    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B, // different host than HOLDER_A
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      trackingIsPidAlive,
    );

    expect(result.acquired).toBe(false);
    expect(isPidAliveCalls).toBe(0); // never invoked across hosts
  });

  it("self-refresh path is unaffected by isPidAlive (own pid is always considered alive enough)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, startedAt);

    // Same holder/host, fresh PID — even if the prior PID is "dead",
    // the self path edits the comment and refreshes.
    const result = await tryAcquireLock(
      tracker,
      external_id,
      { ...HOLDER_A, hostPid: 12345, dispatchId: "self-refresh-uuid" },
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_DEAD,
    );

    expect(result.acquired).toBe(true);
    expect(result.refreshed).toBe(true);
  });

  it("ignores host_pid liveness when stored host_pid is 0 (legacy comment)", async () => {
    // A lock written by a pre-DX-241 worker has host_pid: 0. The
    // liveness check must treat 0 as "unknown, fall back to TTL"
    // rather than "dead, reclaim". Otherwise legacy locks would all
    // appear stale on the rollout tick.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const legacyBody = `${DANXBOT_COMMENT_MARKER}
${LOCK_COMMENT_MARKER}

| Field | Value |
|---|---|
| holder | \`gpt\` |
| host | \`${HOLDER_A.host}\` |
| dispatch_id | \`legacy\` |
| repo_path | \`/x\` |
| jsonl_dir | \`/y\` |
| workspace | \`issue-worker\` |
| started_at | \`2026-05-04T07:00:00.000Z\` |
| ttl | \`120m\` |
| stale_after | \`2026-05-04T09:00:00.000Z\` |`;
    await tracker.addComment(external_id, legacyBody);

    const sameHostDifferentHolder = {
      ...HOLDER_B,
      host: HOLDER_A.host,
      hostPid: 9999,
    };
    const result = await tryAcquireLock(
      tracker,
      external_id,
      sameHostDifferentHolder,
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_DEAD, // would say "dead", but stored host_pid is 0 → skip
    );

    expect(result.acquired).toBe(false);
    expect(result.existing!.holder).toBe("gpt");
  });
});

describe("renderReleasedLockComment + parseLockComment", () => {
  it("renders a parseable lock comment with backdated started_at and a released_at field", () => {
    const startedAt = "2026-05-04T07:00:00.000Z";
    const original = renderLockComment(HOLDER_A, startedAt);
    const parsed = parseLockComment(original, "id-1")!;
    const releasedAt = "2026-05-04T07:30:00.000Z";
    const released = renderReleasedLockComment(parsed, releasedAt);

    const reparsed = parseLockComment(released, "id-1");
    expect(reparsed).not.toBeNull();
    expect(reparsed!.holder).toBe(parsed.holder);
    expect(reparsed!.host).toBe(parsed.host);
    expect(reparsed!.dispatchId).toBe(parsed.dispatchId);
    expect(reparsed!.releasedAt).toBe(releasedAt);
    // started_at is reset to epoch so the lock is instantly stale to TTL.
    expect(new Date(reparsed!.startedAt).getTime()).toBe(0);
  });
});

describe("releaseLock", () => {
  it("returns {released: false, reason: 'no-lock'} when the card has no lock comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    const result = await releaseLock(
      tracker,
      external_id,
      HOLDER_A.dispatchId,
    );

    expect(result.released).toBe(false);
    expect(result.reason).toBe("no-lock");
  });

  it("returns {released: false, reason: 'unparseable'} when the lock body is corrupt", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tracker.addComment(
      external_id,
      `${DANXBOT_COMMENT_MARKER}\n${LOCK_COMMENT_MARKER}\n\ngarbage`,
    );

    const result = await releaseLock(
      tracker,
      external_id,
      HOLDER_A.dispatchId,
    );

    expect(result.released).toBe(false);
    expect(result.reason).toBe("unparseable");
  });

  it("returns {released: false, reason: 'not-mine'} when the dispatchId does not match", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    const result = await releaseLock(
      tracker,
      external_id,
      HOLDER_B.dispatchId,
    );

    expect(result.released).toBe(false);
    expect(result.reason).toBe("not-mine");
  });

  it("releases the lock so a fresh acquire by another holder reclaims immediately within TTL", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const t0 = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER_A, t0);

    const release = await releaseLock(
      tracker,
      external_id,
      HOLDER_A.dispatchId,
      new Date("2026-05-04T07:15:00.000Z"),
    );
    expect(release.released).toBe(true);

    // 30 minutes later (well within the original 2h TTL), HOLDER_B
    // tries — and reclaims, because the released lock's started_at
    // was rewritten to epoch.
    const result = await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_B,
      new Date("2026-05-04T07:30:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_ALIVE,
    );
    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);

    // Still exactly one lock comment on the card (release EDITs in
    // place; reclaim EDITs in place; never POSTs a duplicate).
    const comments = await tracker.getComments(external_id);
    const lockComments = comments.filter((c) =>
      c.text.includes(LOCK_COMMENT_MARKER),
    );
    expect(lockComments).toHaveLength(1);
  });

  it("solves failure mode #2 — host rename: prior holder releases, new runtime reclaims without TTL wait", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    // Operator runs the docker worker first.
    const dockerHolder = {
      ...HOLDER_A,
      holder: "gpt",
      host: "8a3f2c1bdef0", // 12-hex container id
      hostPid: 1, // PID 1 inside the container
      dispatchId: "docker-uuid",
    };
    await tryAcquireLock(
      tracker,
      external_id,
      dockerHolder,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    // Worker shutdown fires the release path (this is what
    // shutdown.ts will do once wired).
    const release = await releaseLock(
      tracker,
      external_id,
      dockerHolder.dispatchId,
      new Date("2026-05-04T07:05:00.000Z"),
    );
    expect(release.released).toBe(true);

    // Operator restarts in host mode — different os.hostname() and
    // different runtime. No 2h wait; the host worker's first poll
    // tick reclaims the lock cleanly.
    const hostHolder = {
      ...HOLDER_A,
      holder: "gpt",
      host: "ec2-instance-prod", // host's hostname
      hostPid: 4321,
      dispatchId: "host-uuid",
    };
    const result = await tryAcquireLock(
      tracker,
      external_id,
      hostHolder,
      new Date("2026-05-04T07:10:00.000Z"),
      LOCK_TTL_MS,
      ALL_PIDS_ALIVE,
    );
    expect(result.acquired).toBe(true);
    expect(result.reclaimed).toBe(true);
  });

  it("releaseLock is idempotent — second call on the same dispatchId returns 'not-mine' (no-op)", async () => {
    // After release, the comment's content survives but with started_at
    // backdated. The original dispatchId is still in the comment, so a
    // re-release call sees "still mine" and would try to edit again.
    // We treat the post-release state as "not-mine" so the second call
    // is a no-op. Simplest: a release is recognized by `releasedAt !==
    // ""`, and we refuse to re-release such a comment.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER_A,
      new Date("2026-05-04T07:00:00.000Z"),
    );
    await releaseLock(
      tracker,
      external_id,
      HOLDER_A.dispatchId,
      new Date("2026-05-04T07:01:00.000Z"),
    );

    const result = await releaseLock(
      tracker,
      external_id,
      HOLDER_A.dispatchId,
      new Date("2026-05-04T07:02:00.000Z"),
    );
    expect(result.released).toBe(false);
    expect(result.reason).toBe("already-released");
  });
});
