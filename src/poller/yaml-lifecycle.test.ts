import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeTracker } from "../__tests__/helpers/FakeTracker.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import {
  clearDispatchAndWrite,
  ensureGitignoreEntry,
  ensureIssuesDirs,
  hydrateFromRemote,
  issuePath,
  moveToClosedIfTerminal,
  stampAssignedAgentAndWrite,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import {
  registerWriterDb,
  unregisterWriterDb,
  type IssuesMirrorDb,
  type UpsertArgs,
} from "../db/issues-mirror.js";

/**
 * Install a `FakeDb` against the writer registry for the duration of
 * one test. Returns the upsert call log + an unregister handle the test
 * MUST call in a `finally` block. Matches the FakeDb shape used in
 * `src/db/issues-mirror.test.ts` so writer-side coverage shares the
 * mental model.
 */
function installWriterDb(repoLocalPath: string): {
  upsertWithHistoryCalls: UpsertArgs[];
  unregister: () => void;
} {
  const rows = new Map<
    string,
    { data: Record<string, unknown>; content_hash: string }
  >();
  const upsertWithHistoryCalls: UpsertArgs[] = [];
  const db: IssuesMirrorDb = {
    async selectExisting(repoName, id) {
      return rows.get(`${repoName}|${id}`) ?? null;
    },
    async upsertWithHistory(args) {
      rows.set(`${args.repoName}|${args.id}`, {
        data: args.data,
        content_hash: args.contentHash,
      });
      upsertWithHistoryCalls.push(args);
    },
    async tombstone() {
      // No tombstones in the writer path — left unimplemented.
    },
    async listIds() {
      const out: Array<{ id: string; content_hash: string }> = [];
      for (const [key, row] of rows) {
        const id = key.split("|")[1]!;
        out.push({ id, content_hash: row.content_hash });
      }
      return out;
    },
  };
  registerWriterDb(repoLocalPath, db);
  return {
    upsertWithHistoryCalls,
    unregister: () => unregisterWriterDb(repoLocalPath),
  };
}

/**
 * Round-trip helper. The yaml-lifecycle test suite previously called
 * `loadLocal` after `writeIssue` to verify YAML → parse round-trips.
 * Phase 4 (DX-155) moved `loadLocal` + `findByExternalId` to a SQL
 * query against the `issues` table, so a unit test without a running
 * mirror can no longer use them. Direct file read + parseIssue is what
 * those round-trip checks actually need; the DB-backed helpers are
 * exercised separately in
 * `src/__tests__/integration/yaml-lifecycle-readers.test.ts`.
 */
function readYamlFile(
  repoRoot: string,
  id: string,
  state: "open" | "closed" = "open",
): Issue {
  return parseIssue(readFileSync(issuePath(repoRoot, id, state), "utf-8"), {
    expectedPrefix: id.split("-")[0]!,
  });
}
import type { CreateCardInput, Issue, IssueStatus } from "../issue-tracker/interface.js";

function buildIssueLite(id: string, status: IssueStatus): Issue {
  const merged: Issue = {
    schema_version: 11,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: `Title for ${id}`,
    description: "Body",
    priority: 3.0,
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
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      at: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function defaultCreate(
  overrides: Partial<CreateCardInput> = {},
): CreateCardInput {
  return {
    schema_version: 11,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "Card title",
    description: "Card description",
    priority: 3.0,
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    ...overrides,
  };
}

describe("yaml-lifecycle", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-yaml-lifecycle-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe("issuePath", () => {
    it("returns absolute path under .danxbot/issues/<state>/<id>.yml", () => {
      const path = issuePath(repoRoot, "ISS-7", "open");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/open/ISS-7.yml"));
    });

    it("returns closed path when state is closed", () => {
      const path = issuePath(repoRoot, "ISS-7", "closed");
      expect(path).toBe(resolve(repoRoot, ".danxbot/issues/closed/ISS-7.yml"));
    });
  });

  describe("ensureIssuesDirs", () => {
    it("creates open/ and closed/ dirs idempotently", () => {
      ensureIssuesDirs(repoRoot);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/open"))).toBe(true);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/closed"))).toBe(
        true,
      );

      // Second call must not throw.
      ensureIssuesDirs(repoRoot);
      expect(existsSync(resolve(repoRoot, ".danxbot/issues/open"))).toBe(true);
    });
  });

  describe("hydrateFromRemote", () => {
    it("calls tracker.getCard + tracker.getComments and writes valid YAML with stamped dispatch_id", async () => {
      const tracker = new FakeTracker();
      // Seed a card carrying an internal id (the FakeTracker
      // round-trips it; getCard returns it as `Issue.id` so hydrate
      // doesn't have to allocate a new ISS-N).
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-77" }),
      );
      tracker.clearRequestLog();

      const dispatchId = "dispatch-uuid-abc";
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        dispatchId,
        repoRoot, "ISS",
      );

      expect(issue.id).toBe("ISS-77");
      expect(issue.external_id).toBe(external_id);
      expect(issue.dispatch?.id).toBe(dispatchId);
      expect(issue.title).toBe("Card title");

      const methods = tracker
        .getRequestLog()
        .map((l) => l.method)
        .sort();
      expect(methods).toEqual(["getCard", "getComments"]);
    });

    it("allocates a new ISS-N when the remote card has no id (legacy / human-created)", async () => {
      const tracker = new FakeTracker();
      // FakeTracker preserves whatever id we seed — empty here means
      // the equivalent of "remote card created without a `#ISS-N: ` prefix".
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "" }),
      );

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      expect(issue.id).toMatch(/^ISS-\d+$/);
    });

    it("accepts dispatchId: null (bulk-sync write shape) and round-trips dispatch_id null through writeIssue + parseIssue", async () => {
      // Phase 1 of the epic-linkage epic added a bulk-sync block to the
      // poller that pre-hydrates every ToDo card on each tick. Sibling
      // hydrations don't carry a dispatch UUID — only the primary card
      // does. Hydrate's signature was widened from `string` to
      // `string | null` to support that. Pin the contract so a future
      // refactor that re-tightens the type can't break bulk-sync.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-99" }),
      );

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        null,
        repoRoot, "ISS",
      );
      expect(issue.dispatch).toBeNull();

      // Round-trip through writeIssue + the strict parseIssue validator
      // — null dispatch MUST survive serialization.
      await writeIssue(repoRoot, issue);
      const reloaded = readYamlFile(repoRoot, issue.id);
      expect(reloaded.dispatch).toBeNull();
    });

    it("ISS-87: hydrated Issue is complete — every required field populated, round-trips through serialize+parse", async () => {
      // Card-hydration completeness regression: a tracker-born card
      // with no matching local YAML must produce a YAML that the strict
      // parseIssue validator accepts on round-trip. Defends against a
      // future hydrateFromRemote refactor that drops a required field
      // (e.g. `children`, `blocked`) and only fails downstream when the
      // poller eventually re-reads the file.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-200" }),
      );
      const issue = await hydrateFromRemote(tracker, external_id, null, repoRoot, "ISS");

      // Every required field is populated with the expected value
      // (not just well-typed) so a hydration regression that drops a
      // remote field's content (e.g. returns `[]` for a non-empty AC
      // list) fails loudly here.
      expect(issue.schema_version).toBe(11);
      expect(issue.id).toBe("ISS-200");
      expect(issue.external_id).toBe(external_id);
      expect(issue.parent_id).toBeNull();
      expect(issue.children).toEqual([]);
      expect(issue.dispatch).toBeNull();
      expect(issue.status).toBe("ToDo");
      expect(issue.type).toBe("Feature");
      expect(issue.title).toBe("Card title");
      expect(typeof issue.description).toBe("string");
      expect(issue.triage).toEqual({
        expires_at: "",
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      });
      expect(issue.ac).toHaveLength(1);
      expect(issue.ac[0].title).toBe("AC1");
      expect(issue.ac[0].checked).toBe(false);
      expect(issue.ac[0].check_item_id).toBeTruthy();
      expect(issue.comments).toEqual([]);
      expect(issue.retro).toEqual({
        good: "",
        bad: "",
        action_item_ids: [],
        commits: [],
      });
      expect(issue.blocked).toBeNull();

      // Round-trip through writeIssue + parseIssue. Any missing required
      // field would throw here.
      await writeIssue(repoRoot, issue);
      const reloaded = readYamlFile(repoRoot, issue.id);
      expect(reloaded.external_id).toBe(external_id);
    });

    it("includes remote comments in the hydrated Issue", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-3" }),
      );
      await tracker.addComment(external_id, "first comment");
      await tracker.addComment(external_id, "second comment");

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      expect(issue.comments).toHaveLength(2);
      expect(issue.comments[0].text).toContain("first comment");
      expect(issue.comments[1].text).toContain("second comment");
      expect(issue.comments[0].id).toBeDefined();
    });

    // ----- DX-147 — tracker:<name> 'created' entry on first hydrate -----

    it("DX-147: appends exactly one tracker:<name> 'created' entry referencing external_id when history is empty", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-300" }),
      );

      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        null,
        repoRoot, "ISS",
      );

      expect(issue.history).toHaveLength(1);
      const entry = issue.history[0];
      // Actor uses the dynamic tracker name — FakeTracker's
      // `tracker` field is `"memory"`, so the actor is
      // `tracker:memory`. In production with TrelloTracker the actor
      // would be `tracker:trello` (per the canonical actor table on
      // DX-138).
      expect(entry.actor).toBe(`tracker:${issue.tracker}`);
      expect(entry.event).toBe("created");
      expect(entry.to).toBe(issue.status);
      // Note must reference the external_id so dashboard readers can
      // correlate the audit entry back to the tracker card.
      expect(entry.note).toContain(external_id);
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);

      // Round-trip survival: the freshly hydrated Issue + its `created`
      // entry MUST round-trip through the strict validator unchanged.
      await writeIssue(repoRoot, issue);
      const reloaded = readYamlFile(repoRoot, issue.id);
      expect(reloaded.history).toHaveLength(1);
      expect(reloaded.history[0].actor).toBe(entry.actor);
      expect(reloaded.history[0].event).toBe("created");
    });

    it("DX-147: 'created' entry survives writeIssue + loadLocal round-trip without growing a second entry", async () => {
      // Hydrate is the SOLE entry point for the `created` event —
      // bulk-sync's caller (`src/cron/sync-and-audit.ts#bulkSyncMissingYamls`)
      // gates on `findByExternalId`, so a card with a local YAML never
      // re-enters hydrate. Verifying exactly-once means showing the
      // entry survives the round-trip path (write → parse) used by
      // every later worker / poller code path that consumes the YAML.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-400" }),
      );

      const first = await hydrateFromRemote(tracker, external_id, null, repoRoot, "ISS");
      expect(first.history).toHaveLength(1);
      expect(first.history[0].event).toBe("created");

      await writeIssue(repoRoot, first);
      const reloaded = readYamlFile(repoRoot, first.id);
      // Round-trip is byte-stable: parsed history matches the hydrate
      // output exactly. No second entry was appended during
      // serialize/parse, and the parse path leaves `history` alone.
      expect(reloaded.history).toEqual(first.history);
    });

    it("DX-147: allocate-new-ISS-N hydrate path also stamps exactly one tracker:<name> 'created' entry", async () => {
      // The branch at `yaml-lifecycle.ts:171` (no `remote.id` — legacy
      // / human-created card) calls `nextIssueId` then `tracker.updateCard`
      // before falling through to the validate-and-append block. Pin
      // that the post-allocation path still emits the `created` entry
      // — a regression that early-returns inside the allocate branch
      // would otherwise ship without a created entry.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "" }),
      );

      const issue = await hydrateFromRemote(tracker, external_id, "did-1", repoRoot, "ISS");
      expect(issue.id).toMatch(/^ISS-\d+$/);
      expect(issue.history).toHaveLength(1);
      expect(issue.history[0].event).toBe("created");
      expect(issue.history[0].actor).toBe(`tracker:${issue.tracker}`);
      expect(issue.history[0].note).toContain(external_id);
    });
  });

  // `loadLocal` and `findByExternalId` are DB-backed since DX-155 and
  // exercised in the integration suite at
  // `src/__tests__/integration/yaml-lifecycle-readers.test.ts` (real
  // Postgres + a seeded `issues` table). Their unit tests left this
  // file because the round-trip via writeIssue → file no longer
  // observes the same medium the readers consume.

  describe("writeIssue", () => {
    it("serializes and writes to open/<id>.yml; round-trips through parseIssue", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-12" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );

      await writeIssue(repoRoot, issue);

      const path = issuePath(repoRoot, "ISS-12", "open");
      expect(existsSync(path)).toBe(true);
      const roundTripped = parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" });
      expect(roundTripped.id).toBe("ISS-12");
      expect(roundTripped.external_id).toBe(external_id);
      expect(roundTripped.dispatch?.id).toBe("did-1");
    });

    it("DX-547: stamps db_updated_at with a fresh ISO 8601 timestamp before serializing", async () => {
      // Phase 2 invariant: the writer mints db_updated_at on every save
      // so the canonical hash reflects the fresh write, and external
      // readers (dispatched agents reading via the chokidar mirror or
      // a direct file read) see a monotonic freshness signal.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-5470" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
        "ISS",
      );

      const before = Date.now();
      await writeIssue(repoRoot, issue);
      const after = Date.now();

      const reloaded = readYamlFile(repoRoot, "ISS-5470");
      expect(reloaded.db_updated_at).toBeTruthy();
      const stampedMs = Date.parse(reloaded.db_updated_at);
      expect(Number.isFinite(stampedMs)).toBe(true);
      // Allow a 1s slack on each side for clock jitter / scheduler delay
      // between the Date.now() snapshots and the writer's internal
      // `new Date().toISOString()` call.
      expect(stampedMs).toBeGreaterThanOrEqual(before - 1000);
      expect(stampedMs).toBeLessThanOrEqual(after + 1000);
    });
  });

  // ----- DX-547 — writer owns the DB write -----
  //
  // These tests register a FakeDb against the writer registry exposed by
  // `src/db/issues-mirror.ts` so the synchronous upsert path runs in
  // unit tests without a real pg pool. Unregistered repos fall back to
  // the file-only legacy path — covered by the existing `writeIssue`
  // tests above (none of them register a writer DB, none of them assert
  // a DB row).
  describe("DX-547 — writer owns the DB write (synchronous upsert)", () => {
    it("writeIssue upserts the DB row + history row with source='writer' BEFORE writing the file", async () => {
      const { upsertWithHistoryCalls, unregister } = installWriterDb(repoRoot);
      try {
        const issue = buildIssueLite("ISS-5471", "ToDo");

        await writeIssue(repoRoot, issue);

        // Exactly one history row, source=writer, with the just-computed
        // content hash. The order also matters: the file must exist on
        // disk by the time writeIssue's returned promise resolves.
        expect(upsertWithHistoryCalls).toHaveLength(1);
        const upsert = upsertWithHistoryCalls[0]!;
        expect(upsert.source).toBe("writer");
        expect(upsert.id).toBe("ISS-5471");
        expect(upsert.contentHash).toMatch(/^[0-9a-f]{64}$/);
        // The first writer save carries no prior row, so prev_hash null.
        expect(upsert.prevHash).toBeNull();
        // The upsert payload mirrors the parsed YAML (db_updated_at
        // stamped + every other field).
        expect(upsert.data.id).toBe("ISS-5471");
        expect(typeof upsert.data.db_updated_at).toBe("string");
        expect((upsert.data.db_updated_at as string).length).toBeGreaterThan(0);

        // File-on-disk reflects the same db_updated_at the DB row carries.
        const reloaded = readYamlFile(repoRoot, "ISS-5471");
        expect(reloaded.db_updated_at).toBe(upsert.data.db_updated_at);
      } finally {
        unregister();
      }
    });

    it("writeIssue twice with no content change: second call short-circuits — one history row only", async () => {
      // Same content twice — second writer save MUST NOT append a
      // duplicate history row. The canonical no-op short-circuit gates
      // on the existing row's content_hash. `db_updated_at` is
      // intentionally excluded from `canonicalize` (see
      // `src/db/canonicalize.ts` HASH_EXCLUDED_TOP_KEYS) so re-saves of
      // identical content produce the same hash even though the writer
      // bumps `db_updated_at` on every call — no clock pinning needed.
      const { upsertWithHistoryCalls, unregister } = installWriterDb(repoRoot);
      try {
        const issue = buildIssueLite("ISS-5472", "ToDo");
        await writeIssue(repoRoot, issue);
        await writeIssue(repoRoot, issue);

        // Exactly ONE history row — the second call short-circuited on
        // `existing.content_hash === contentHash` and skipped both the
        // upsert AND the history insert.
        expect(upsertWithHistoryCalls).toHaveLength(1);
      } finally {
        unregister();
      }
    });

    it("writeIssue twice with a content change: TWO history rows, prev_hash threaded", async () => {
      // Different content on the second save MUST produce a second
      // history row whose prev_hash equals the first row's next_hash —
      // the canonical chain the DB-mirror epic relies on.
      const { upsertWithHistoryCalls, unregister } = installWriterDb(repoRoot);
      try {
        const issue = buildIssueLite("ISS-5473", "ToDo");
        await writeIssue(repoRoot, issue);
        // Mutate a field so the canonical hash changes.
        const second: Issue = { ...issue, description: "Body — revised" };
        await writeIssue(repoRoot, second);

        expect(upsertWithHistoryCalls).toHaveLength(2);
        const [first, secondRow] = upsertWithHistoryCalls;
        expect(first!.prevHash).toBeNull();
        expect(secondRow!.prevHash).toBe(first!.contentHash);
        expect(secondRow!.contentHash).not.toBe(first!.contentHash);
        expect(secondRow!.source).toBe("writer");
      } finally {
        unregister();
      }
    });

    it("writeIssue with no writer DB registered: file is still written (legacy unit-test path)", async () => {
      // No registration call → upsertIssueRowNow no-ops → the file
      // write still runs. Defends the contract the existing
      // yaml-lifecycle test suite (which never registers a DB) depends
      // on.
      const issue = buildIssueLite("ISS-5474", "ToDo");
      await writeIssue(repoRoot, issue);
      const path = issuePath(repoRoot, "ISS-5474", "open");
      expect(existsSync(path)).toBe(true);
    });
  });

  describe("stampDispatchAndWrite", () => {
    it("overwrites dispatch_id and writes back, returning the updated Issue", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-13" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      await writeIssue(repoRoot, original);

      const updated = await stampDispatchAndWrite(repoRoot, original, {
        id: "did-2",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      });
      expect(updated.dispatch?.id).toBe("did-2");

      const reloaded = readYamlFile(repoRoot, "ISS-13");
      expect(reloaded.dispatch?.id).toBe("did-2");
    });

    it("IssueDispatch form stamps the full record verbatim", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-15" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      await writeIssue(repoRoot, original);

      const updated = await stampDispatchAndWrite(repoRoot, original, {
        id: "did-2",
        pid: 4321,
        host: "danxbot-host-a",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      });
      expect(updated.dispatch).toEqual({
        id: "did-2",
        pid: 4321,
        host: "danxbot-host-a",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      });

      const reloaded = readYamlFile(repoRoot, "ISS-15");
      expect(reloaded.dispatch?.pid).toBe(4321);
      expect(reloaded.dispatch?.host).toBe("danxbot-host-a");
      expect(reloaded.dispatch?.started_at).toBe("2026-05-07T12:00:00.000Z");
      expect(reloaded.dispatch?.ttl_seconds).toBe(7200);
    });
  });

  describe("clearDispatchAndWrite", () => {
    it("clears dispatch and PRESERVES assigned_agent (durable audit)", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-16" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      const stamped = await stampDispatchAndWrite(repoRoot, original, {
        id: "did-1",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      });
      const owned = await stampAssignedAgentAndWrite(repoRoot, stamped, "phil");
      expect(owned.dispatch).not.toBeNull();
      expect(owned.assigned_agent).toBe("phil");

      const cleared = await clearDispatchAndWrite(repoRoot, owned);
      expect(cleared.dispatch).toBeNull();
      // assigned_agent persists across dispatch end — durable ownership.
      expect(cleared.assigned_agent).toBe("phil");

      const reloaded = readYamlFile(repoRoot, "ISS-16");
      expect(reloaded.dispatch).toBeNull();
      expect(reloaded.assigned_agent).toBe("phil");
    });

    it("is a no-op when dispatch is already null (returns input, no write)", async () => {
      // assigned_agent state is irrelevant — the function gates on
      // `dispatch === null` only, since assigned_agent is durable audit
      // and never touched here.
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-18" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        null,
        repoRoot, "ISS",
      );
      const withAgent = await stampAssignedAgentAndWrite(
        repoRoot,
        original,
        "phil",
      );
      expect(withAgent.dispatch).toBeNull();
      expect(withAgent.assigned_agent).toBe("phil");

      const result = await clearDispatchAndWrite(repoRoot, withAgent);
      // Same reference — short-circuit, no write.
      expect(result).toBe(withAgent);

      const reloaded = readYamlFile(repoRoot, "ISS-18");
      // assigned_agent untouched.
      expect(reloaded.assigned_agent).toBe("phil");
    });

    it("is a no-op when dispatch is null (no assigned_agent either)", async () => {
      const tracker = new FakeTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-17" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        null,
        repoRoot, "ISS",
      );
      await writeIssue(repoRoot, original);
      expect(original.dispatch).toBeNull();
      expect(original.assigned_agent).toBeNull();

      const result = await clearDispatchAndWrite(repoRoot, original);
      expect(result).toBe(original);
    });
  });

  describe("moveToClosedIfTerminal (ISS-133, Phase 3 — shared open→closed mover)", () => {
    it("returns false and does not write when status is non-terminal", () => {
      const openPath = issuePath(repoRoot, "ISS-1", "open");
      const closedPath = issuePath(repoRoot, "ISS-1", "closed");
      const issue = buildIssueLite("ISS-1", "ToDo");

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(false);
      // No closed/ write — caller must handle non-terminal persistence.
      expect(existsSync(closedPath)).toBe(false);
      // No open/ write either — this helper is the close-mover, not a
      // generic writer.
      expect(existsSync(openPath)).toBe(false);
    });

    it("returns true and writes to closed/ for status=Done, removing open/", () => {
      ensureIssuesDirs(repoRoot);
      const issue = buildIssueLite("ISS-2", "Done");
      writeFileSync(issuePath(repoRoot, "ISS-2", "open"), serializeIssue(issue));

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-2", "open"))).toBe(false);
      expect(existsSync(issuePath(repoRoot, "ISS-2", "closed"))).toBe(true);
    });

    it("returns true and writes to closed/ for status=Cancelled, removing open/", () => {
      ensureIssuesDirs(repoRoot);
      const issue = buildIssueLite("ISS-3", "Cancelled");
      writeFileSync(issuePath(repoRoot, "ISS-3", "open"), serializeIssue(issue));

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-3", "open"))).toBe(false);
      expect(existsSync(issuePath(repoRoot, "ISS-3", "closed"))).toBe(true);
    });

    it("auto-creates closed/ dir on a fresh repo (no ensureIssuesDirs call needed)", () => {
      // Pin the contract: caller hands in an Issue + a repo path; the
      // helper handles `ensureIssuesDirs` internally so heal can run on
      // a fresh repo (no prior open→closed motion) without crashing.
      const freshRepo = mkdtempSync(join(tmpdir(), "danxbot-mtcit-fresh-"));
      try {
        const issue = buildIssueLite("ISS-4", "Done");
        const moved = moveToClosedIfTerminal(freshRepo, issue);
        expect(moved).toBe(true);
        expect(existsSync(issuePath(freshRepo, "ISS-4", "closed"))).toBe(true);
      } finally {
        rmSync(freshRepo, { recursive: true, force: true });
      }
    });

    it("DX-584: moves a card whose raw status is 'In Progress' but completed_at is set (derived → Done)", () => {
      ensureIssuesDirs(repoRoot);
      const issue = buildIssueLite("ISS-7", "In Progress");
      issue.completed_at = "2026-05-14T12:00:00.000Z";
      writeFileSync(issuePath(repoRoot, "ISS-7", "open"), serializeIssue(issue));

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-7", "open"))).toBe(false);
      expect(existsSync(issuePath(repoRoot, "ISS-7", "closed"))).toBe(true);
    });

    it("DX-584: moves a card whose raw status is 'In Progress' but cancelled_at is set (derived → Cancelled)", () => {
      ensureIssuesDirs(repoRoot);
      const issue = buildIssueLite("ISS-8", "In Progress");
      issue.cancelled_at = "2026-05-14T12:00:00.000Z";
      writeFileSync(issuePath(repoRoot, "ISS-8", "open"), serializeIssue(issue));

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-8", "open"))).toBe(false);
      expect(existsSync(issuePath(repoRoot, "ISS-8", "closed"))).toBe(true);
    });

    it("is idempotent when open/<id>.yml is absent (writes closed/, no unlink error)", () => {
      ensureIssuesDirs(repoRoot);
      // No open/ copy — this is the post-heal idempotency case where
      // some other path (e.g. an earlier heal tick) already removed
      // the open file. Re-running must not throw on the missing
      // unlink.
      const issue = buildIssueLite("ISS-5", "Done");

      const moved = moveToClosedIfTerminal(repoRoot, issue);

      expect(moved).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-5", "closed"))).toBe(true);
      expect(existsSync(issuePath(repoRoot, "ISS-5", "open"))).toBe(false);
    });

    it("overwrites a stale closed/<id>.yml ('open wins' contract)", () => {
      ensureIssuesDirs(repoRoot);
      const stale = buildIssueLite("ISS-6", "Done");
      stale.title = "Stale closed copy";
      writeFileSync(issuePath(repoRoot, "ISS-6", "closed"), serializeIssue(stale));

      const fresh = buildIssueLite("ISS-6", "Done");
      fresh.title = "Fresh open content";
      writeFileSync(issuePath(repoRoot, "ISS-6", "open"), serializeIssue(fresh));

      const moved = moveToClosedIfTerminal(repoRoot, fresh);

      expect(moved).toBe(true);
      const reloaded = parseIssue(
        readFileSync(issuePath(repoRoot, "ISS-6", "closed"), "utf-8"),
        { expectedPrefix: "ISS" },
      );
      expect(reloaded.title).toBe("Fresh open content");
      expect(existsSync(issuePath(repoRoot, "ISS-6", "open"))).toBe(false);
    });
  });

  describe("ensureGitignoreEntry", () => {
    it("creates the gitignore with the line when file does not exist", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "utf-8",
      );
      expect(content.split("\n")).toContain("issues/");
    });

    it("appends the line if missing, preserving existing entries", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "features.md\n.env\nsettings.json\n",
      );
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "utf-8",
      );
      const lines = content.split("\n");
      expect(lines).toContain("features.md");
      expect(lines).toContain(".env");
      expect(lines).toContain("settings.json");
      expect(lines).toContain("issues/");
    });

    it("is idempotent — calling twice does not duplicate the line", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "features.md\n");
      ensureGitignoreEntry(repoRoot, "issues/");
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "utf-8",
      );
      const occurrences = content.split("\n").filter((l) => l === "issues/");
      expect(occurrences).toHaveLength(1);
    });

    it("does not match a partial line containing the entry as a substring", () => {
      mkdirSync(resolve(repoRoot, ".danxbot"), { recursive: true });
      writeFileSync(resolve(repoRoot, ".danxbot/.gitignore"), "old-issues/\n");
      ensureGitignoreEntry(repoRoot, "issues/");
      const content = readFileSync(
        resolve(repoRoot, ".danxbot/.gitignore"),
        "utf-8",
      );
      const lines = content.split("\n");
      expect(lines).toContain("old-issues/");
      expect(lines).toContain("issues/");
    });
  });

});
