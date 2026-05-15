/**
 * writeIssue ↔ DB mirror contract.
 *
 * DX-547 Phase 2 reshaped the contract: the writer OWNS the DB write
 * via a synchronous `upsertIssueRowNow` call BEFORE `writeFileSync`,
 * so the DB row is consistent the moment `writeIssue` resolves. The
 * mirror's `awaitMirror` chokidar-side ack is no longer on the
 * writer's hot path; the watcher's later event finds the hash already
 * matches and runs the existing skip-match branch (which fires
 * `onWatcherUpsert` so reconcile fanout still happens exactly once).
 *
 * Behaviors pinned here:
 *   1. With a registered mirror: `writeIssue` upserts the DB row
 *      synchronously (before the file write) and resolves. No watcher
 *      event needed for the writer's promise to settle.
 *   2. With no mirror registered: `writeIssue` returns after the file
 *      write (legacy path — no DB activity).
 *
 * The `awaitMirror` timeout case from the pre-DX-547 contract is
 * scheduled for phase 4 cleanup (kept skipped here to preserve the
 * scope contract — phase 2 wires the writer, phase 4 deletes the
 * awaitMirror plumbing that backed the old test). Until phase 4 ships
 * the deletion, the test stays as a `.skip` so the file documents the
 * boundary.
 *
 * The mirror layer is mocked via `IssuesMirrorDb`; chokidar is disabled.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  startIssuesMirror,
  type IssuesMirror,
  type IssuesMirrorDb,
  type UpsertArgs,
} from "../db/issues-mirror.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { writeIssue } from "./yaml-lifecycle.js";
import type { Issue } from "../issue-tracker/interface.js";

function makeRepo(): { localPath: string; tmpdir: string } {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-write-mirror-"));
  mkdirSync(resolve(root, ".danxbot", "issues", "open"), { recursive: true });
  mkdirSync(resolve(root, ".danxbot", "issues", "closed"), { recursive: true });
  return { localPath: root, tmpdir: root };
}

function makeIssue(id: string): Issue {
  return {
    schema_version: 9,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: `Test ${id}`,
    description: `desc ${id}`,
    priority: 3,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    history: [],
    retro: {
      good: "",
      bad: "",
      action_item_ids: [],
      commits: [],
    },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    db_updated_at: "",
  };
}

interface FakeDb extends IssuesMirrorDb {
  rows: Map<string, { data: Record<string, unknown>; content_hash: string }>;
  upserts: UpsertArgs[];
  /** Inject behavior into upsert: 'normal', 'never-resolve' (test 19). */
  mode: "normal" | "stuck";
}

function createFakeDb(): FakeDb {
  const rows = new Map<
    string,
    { data: Record<string, unknown>; content_hash: string }
  >();
  const upserts: UpsertArgs[] = [];
  const db: FakeDb = {
    rows,
    upserts,
    mode: "normal",
    async selectExisting(repoName, id) {
      return rows.get(`${repoName}|${id}`) ?? null;
    },
    async upsertWithHistory(args) {
      if (db.mode === "stuck") {
        // Don't write — simulates the watcher firing but the upsert never
        // landing. awaitMirror will timeout.
        return;
      }
      rows.set(`${args.repoName}|${args.id}`, {
        data: args.data,
        content_hash: args.contentHash,
      });
      upserts.push(args);
    },
    async tombstone(args) {
      rows.delete(`${args.repoName}|${args.id}`);
    },
    async listIds(repoName) {
      const out: Array<{ id: string; content_hash: string }> = [];
      for (const [key, row] of rows) {
        const [r, id] = key.split("|");
        if (r === repoName) out.push({ id, content_hash: row.content_hash });
      }
      return out;
    },
  };
  return db;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("writeIssue ↔ mirror — read-your-writes", () => {
  it("upserts the DB row synchronously (writer owns the DB write)", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    const mirror = await startIssuesMirror(
      { name: "rw-repo", localPath: repo.localPath },
      { db, disableWatcher: true, reconcileIntervalMs: 0 },
    );
    try {
      const issue = makeIssue("DX-1");
      // DX-547 Phase 2: writer upserts BEFORE writeFileSync. After
      // `writeIssue` resolves, the DB row is in place and the file is
      // on disk. No watcher event needed — `startIssuesMirror` registered
      // the writer DB, and `upsertIssueRowNow` ran the same transaction
      // shape as the watcher's `mirrorOne`.
      await writeIssue(repo.localPath, issue);

      const open = resolve(
        repo.localPath,
        ".danxbot",
        "issues",
        "open",
        "DX-1.yml",
      );
      expect(readFileSync(open, "utf-8")).toContain("DX-1");

      // DB row carries the writer's content + the history row was
      // tagged `source: "writer"`.
      const stored = db.rows.get("rw-repo|DX-1");
      expect(stored).not.toBeUndefined();
      expect(db.upserts).toHaveLength(1);
      expect(db.upserts[0]!.source).toBe("writer");
    } finally {
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  it("returns immediately when no mirror is active (legacy path)", async () => {
    const repo = makeRepo();
    try {
      // No mirror registered for this repoLocalPath.
      const issue = makeIssue("DX-2");
      const start = Date.now();
      await writeIssue(repo.localPath, issue);
      const elapsed = Date.now() - start;
      // Legacy path is just writeFileSync — well under 100ms even on a
      // slow machine. No 5s mirror timeout.
      expect(elapsed).toBeLessThan(500);

      const open = resolve(
        repo.localPath,
        ".danxbot",
        "issues",
        "open",
        "DX-2.yml",
      );
      expect(readFileSync(open, "utf-8")).toContain("DX-2");
    } finally {
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });

  // Scheduled for phase 4 cleanup (DX-545). The pre-DX-547 "stuck DB
  // surfaces as awaitMirror timeout warning" behavior is no longer how
  // the writer responds — post-DX-547 the writer's `upsertIssueRowNow`
  // either succeeds or rethrows (CRITICAL_FAILURE), there is no
  // best-effort warn-and-resolve path. Phase 4 deletes this skipped
  // test alongside the `awaitMirror` plumbing in
  // `src/db/issues-mirror.ts` it pinned.
  it.skip("returns successfully + warns when DB stuck (mirror timeout) [DX-547: pre-Phase-2 contract; delete in phase 4]", async () => {
    const repo = makeRepo();
    const db = createFakeDb();
    db.mode = "stuck";
    // Install fake timers BEFORE startIssuesMirror so any setTimeout
    // registered inside the mirror (awaitMirror's per-call timer) is
    // controllable. Tests that install timers AFTER the timer was
    // armed cannot advance it.
    vi.useFakeTimers();
    const mirror = await startIssuesMirror(
      { name: "rw-repo", localPath: repo.localPath },
      { db, disableWatcher: true, reconcileIntervalMs: 0 },
    );
    try {
      const issue = makeIssue("DX-3");
      const writePromise = writeIssue(repo.localPath, issue);
      // Advance past the 8s writeIssue → awaitMirror timeout. The
      // writer's catch-and-warn branch fires and the function resolves
      // successfully (best-effort by design — file IS on disk). Budget
      // was bumped 5s → 8s to give chokidar's 5s `stabilityThreshold`
      // a 3s margin for the post-debounce emit→upsert→resolvePending
      // chain (false-timeout race observed 2026-05-11 during boot
      // reattach burst).
      await vi.advanceTimersByTimeAsync(8_001);
      await writePromise;

      // File IS on disk regardless of the DB outage.
      const open = resolve(
        repo.localPath,
        ".danxbot",
        "issues",
        "open",
        "DX-3.yml",
      );
      expect(readFileSync(open, "utf-8")).toContain("DX-3");

      // No upsert landed (db.mode = "stuck" — simulating PG outage).
      expect(db.upserts).toHaveLength(0);

      // The warning is emitted via `createLogger("write-issue").warn`,
      // which routes to console.error per the logger contract. Assert
      // the timeout warning surfaced.
      const calls = (logSpy.mock.calls as unknown[][])
        .concat(warnSpy.mock.calls as unknown[][])
        .map((c) => c.map(String).join(" "))
        .join("\n");
      expect(calls).toMatch(/awaitMirror timed out/);
    } finally {
      vi.useRealTimers();
      await mirror.stop();
      rmSync(repo.tmpdir, { recursive: true, force: true });
    }
  });
});
