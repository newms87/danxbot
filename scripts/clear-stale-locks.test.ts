/**
 * Unit tests for the per-card cleanup helper used by `make
 * clear-stale-locks`. The CLI shell (env-var parsing, yaml dir walk,
 * console output) is exercised at the boundary by humans running the
 * make target; the per-card decision is the part with edge-case logic
 * worth pinning. DX-241.
 */
import { describe, expect, it } from "vitest";
import { MemoryTracker } from "../src/issue-tracker/__test__-memory.js";
import {
  LOCK_TTL_MS,
  parseLockComment,
  releaseLock,
  renderLockComment,
  tryAcquireLock,
  type LockHolderInfo,
} from "../src/issue-tracker/lock.js";
import {
  DANXBOT_COMMENT_MARKER,
  LOCK_COMMENT_MARKER,
} from "../src/issue-tracker/markers.js";
import type { CreateCardInput } from "../src/issue-tracker/interface.js";
import { processCardForClear } from "./clear-stale-locks.js";

const HOLDER: LockHolderInfo = {
  holder: "gpt",
  host: "ec2-prod",
  hostPid: 1234,
  dispatchId: "stale-uuid",
  repoPath: "/x",
  jsonlDir: "/y",
  workspace: "issue-worker",
};

function defaultCreate(): CreateCardInput {
  return {
    schema_version: 6,
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

describe("processCardForClear", () => {
  it("releases an active lock and returns 'released' with a descriptive detail", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date("2026-05-04T08:00:00.000Z"),
      minAgeMs: 0,
      dryRun: false,
    });

    expect(outcome.status).toBe("released");
    expect(outcome.detail).toContain(HOLDER.holder);
    expect(outcome.detail).toContain(HOLDER.dispatchId);

    // Lock comment is now in released form on the tracker.
    const comments = await tracker.getComments(external_id);
    const lock = comments.find((c) => c.text.includes(LOCK_COMMENT_MARKER));
    const parsed = parseLockComment(lock!.text, lock!.id);
    expect(parsed!.releasedAt).not.toBe("");
  });

  it("dryRun=true logs a 'released' outcome but does NOT call editComment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER,
      new Date("2026-05-04T07:00:00.000Z"),
    );

    const baselineEditCount = tracker
      .getRequestLog()
      .filter((l) => l.method === "editComment").length;

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date("2026-05-04T08:00:00.000Z"),
      minAgeMs: 0,
      dryRun: true,
    });

    expect(outcome.status).toBe("released");
    const finalEditCount = tracker
      .getRequestLog()
      .filter((l) => l.method === "editComment").length;
    expect(finalEditCount).toBe(baselineEditCount);

    // Underlying lock comment is untouched.
    const comments = await tracker.getComments(external_id);
    const lock = comments.find((c) => c.text.includes(LOCK_COMMENT_MARKER));
    const parsed = parseLockComment(lock!.text, lock!.id);
    expect(parsed!.releasedAt).toBe("");
  });

  it("returns 'skipped-no-lock' when the card has no lock comment", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date(),
      minAgeMs: 0,
      dryRun: false,
    });
    expect(outcome.status).toBe("skipped-no-lock");
  });

  it("returns 'skipped-already-released' when the comment is already in released form", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tryAcquireLock(
      tracker,
      external_id,
      HOLDER,
      new Date("2026-05-04T07:00:00.000Z"),
    );
    await releaseLock(
      tracker,
      external_id,
      HOLDER.dispatchId,
      new Date("2026-05-04T07:30:00.000Z"),
    );

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date(),
      minAgeMs: 0,
      dryRun: false,
    });
    expect(outcome.status).toBe("skipped-already-released");
  });

  it("respects minAgeMs — a young lock is skipped, an old lock is released", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const startedAt = new Date("2026-05-04T07:00:00.000Z");
    await tryAcquireLock(tracker, external_id, HOLDER, startedAt);

    // 30 minutes old, min = 1h → skipped
    const tooYoung = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date("2026-05-04T07:30:00.000Z"),
      minAgeMs: 60 * 60 * 1000,
      dryRun: false,
    });
    expect(tooYoung.status).toBe("skipped-younger-than-min");

    // 2.5h old, min = 1h → released
    const oldEnough = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date("2026-05-04T09:30:00.000Z"),
      minAgeMs: 60 * 60 * 1000,
      dryRun: false,
    });
    expect(oldEnough.status).toBe("released");
  });

  it("returns 'error' on an unparseable lock body (caller leaves it for the next acquire's overwrite path)", async () => {
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    await tracker.addComment(
      external_id,
      `${DANXBOT_COMMENT_MARKER}\n${LOCK_COMMENT_MARKER}\n\ngarbage`,
    );

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date(),
      minAgeMs: 0,
      dryRun: false,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toContain("unparseable");
  });

  it("renderLockComment-shaped legacy comments without host_pid are still cleared by the script", async () => {
    // Reproduces the DX-230 verification finding: 7 stale locks (some
    // 33h old) from prior dev sessions, predating the host_pid field.
    // The script must release them so the next acquire reclaims
    // without a 2h wait.
    const tracker = new MemoryTracker();
    const { external_id } = await tracker.createCard(defaultCreate());
    const legacyHolder: LockHolderInfo = {
      ...HOLDER,
      hostPid: 0, // legacy / unknown pid
    };
    const text = renderLockComment(
      legacyHolder,
      new Date("2026-05-03T00:00:00.000Z").toISOString(),
      LOCK_TTL_MS,
    );
    await tracker.addComment(external_id, text);

    const outcome = await processCardForClear({
      tracker,
      externalId: external_id,
      cardId: "ISS-1",
      cardTitle: "Test",
      now: new Date("2026-05-04T07:00:00.000Z"),
      minAgeMs: 0,
      dryRun: false,
    });
    expect(outcome.status).toBe("released");
  });
});
