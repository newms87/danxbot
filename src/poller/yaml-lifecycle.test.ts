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
import { MemoryTracker } from "../issue-tracker/memory.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import {
  clearDispatchAndWrite,
  ensureGitignoreEntry,
  ensureIssuesDirs,
  findByExternalId,
  hydrateFromRemote,
  issuePath,
  loadLocal,
  moveToClosedIfTerminal,
  stampDispatchAndWrite,
  writeIssue,
} from "./yaml-lifecycle.js";
import type { CreateCardInput, Issue, IssueStatus } from "../issue-tracker/interface.js";

function buildIssueLite(id: string, status: IssueStatus): Issue {
  const merged: Issue = {
    schema_version: 4,
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
    waiting_on: null,
    history: [],
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function defaultCreate(
  overrides: Partial<CreateCardInput> = {},
): CreateCardInput {
  return {
    schema_version: 4,
    tracker: "memory",
    id: "ISS-1",
    parent_id: null,
    children: [],
    status: "ToDo",
    type: "Feature",
    title: "Card title",
    description: "Card description",
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
      const tracker = new MemoryTracker();
      // Seed a memory card carrying an internal id (the memory tracker
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
      const tracker = new MemoryTracker();
      // Memory tracker preserves whatever id we seed — empty here means
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
      const tracker = new MemoryTracker();
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
      writeIssue(repoRoot, issue);
      const reloaded = loadLocal(repoRoot, issue.id, "ISS");
      expect(reloaded?.dispatch).toBeNull();
    });

    it("ISS-87: hydrated Issue is complete — every required field populated, round-trips through serialize+parse", async () => {
      // Card-hydration completeness regression: a tracker-born card
      // with no matching local YAML must produce a YAML that the strict
      // parseIssue validator accepts on round-trip. Defends against a
      // future hydrateFromRemote refactor that drops a required field
      // (e.g. `children`, `blocked`) and only fails downstream when the
      // poller eventually re-reads the file.
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-200" }),
      );
      const issue = await hydrateFromRemote(tracker, external_id, null, repoRoot, "ISS");

      // Every required field is populated with the expected value
      // (not just well-typed) so a hydration regression that drops a
      // remote field's content (e.g. returns `[]` for a non-empty AC
      // list) fails loudly here.
      expect(issue.schema_version).toBe(4);
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

      // Round-trip through writeIssue + loadLocal (which uses the
      // strict parseIssue). Any missing required field would throw
      // here.
      writeIssue(repoRoot, issue);
      const reloaded = loadLocal(repoRoot, issue.id, "ISS");
      expect(reloaded).not.toBeNull();
      expect(reloaded?.external_id).toBe(external_id);
    });

    it("includes remote comments in the hydrated Issue", async () => {
      const tracker = new MemoryTracker();
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
      const tracker = new MemoryTracker();
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
      // Actor uses the dynamic tracker name — MemoryTracker's
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
      writeIssue(repoRoot, issue);
      const reloaded = loadLocal(repoRoot, issue.id, "ISS");
      expect(reloaded?.history).toHaveLength(1);
      expect(reloaded?.history[0].actor).toBe(entry.actor);
      expect(reloaded?.history[0].event).toBe("created");
    });

    it("DX-147: 'created' entry survives writeIssue + loadLocal round-trip without growing a second entry", async () => {
      // Hydrate is the SOLE entry point for the `created` event —
      // bulk-sync's caller (`src/poller/index.ts#bulkSyncMissingYamls`)
      // gates on `findByExternalId`, so a card with a local YAML never
      // re-enters hydrate. Verifying exactly-once means showing the
      // entry survives the round-trip path (write → parse) used by
      // every later worker / poller code path that consumes the YAML.
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-400" }),
      );

      const first = await hydrateFromRemote(tracker, external_id, null, repoRoot, "ISS");
      expect(first.history).toHaveLength(1);
      expect(first.history[0].event).toBe("created");

      writeIssue(repoRoot, first);
      const reloaded = loadLocal(repoRoot, first.id, "ISS");
      // Round-trip is byte-stable: parsed history matches the hydrate
      // output exactly. No second entry was appended during
      // serialize/parse, and the parse path leaves `history` alone.
      expect(reloaded?.history).toEqual(first.history);
    });

    it("DX-147: allocate-new-ISS-N hydrate path also stamps exactly one tracker:<name> 'created' entry", async () => {
      // The branch at `yaml-lifecycle.ts:171` (no `remote.id` — legacy
      // / human-created card) calls `nextIssueId` then `tracker.updateCard`
      // before falling through to the validate-and-append block. Pin
      // that the post-allocation path still emits the `created` entry
      // — a regression that early-returns inside the allocate branch
      // would otherwise ship without a created entry.
      const tracker = new MemoryTracker();
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

  describe("loadLocal", () => {
    it("returns null when no file exists in open/ or closed/", () => {
      ensureIssuesDirs(repoRoot);
      expect(loadLocal(repoRoot, "ISS-9999", "ISS")).toBeNull();
    });

    it("returns the parsed Issue from open/ when present", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-10" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      writeIssue(repoRoot, issue);

      const loaded = loadLocal(repoRoot, "ISS-10", "ISS");
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe("ISS-10");
      expect(loaded?.external_id).toBe(external_id);
      expect(loaded?.dispatch?.id).toBe("did-1");
    });

    it("returns the parsed Issue from closed/ when present and absent from open/", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-11" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        issuePath(repoRoot, "ISS-11", "closed"),
        serializeIssue(issue),
      );

      const loaded = loadLocal(repoRoot, "ISS-11", "ISS");
      expect(loaded?.id).toBe("ISS-11");
    });

    it("throws on corrupt YAML", () => {
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        issuePath(repoRoot, "ISS-99", "open"),
        "not: valid: yaml: at: all\n  - broken",
      );
      expect(() => loadLocal(repoRoot, "ISS-99", "ISS")).toThrow();
    });
  });

  describe("findByExternalId", () => {
    it("returns the issue whose external_id matches by scanning open + closed", async () => {
      const tracker = new MemoryTracker();
      const { external_id: ext } = await tracker.createCard(
        defaultCreate({ id: "ISS-50" }),
      );
      const issue = await hydrateFromRemote(tracker, ext, "did-1", repoRoot, "ISS");
      writeIssue(repoRoot, issue);

      const found = findByExternalId(repoRoot, ext);
      expect(found?.id).toBe("ISS-50");
    });

    it("returns null when no YAML carries the external_id", () => {
      ensureIssuesDirs(repoRoot);
      expect(findByExternalId(repoRoot, "ghost-card")).toBeNull();
    });

    // Regression — ISS-99 prefix-migration dup-spawn: bulk-sync after a
    // rename pass must STILL find the canonical YAML by external_id
    // regardless of which prefix the on-disk file carries. Pre-fix the
    // prefix-filtered regex returned null and bulk-sync re-hydrated 97
    // dup ISS-*.yml files next to their DX-* siblings.
    it("is prefix-agnostic — finds the YAML by external_id alone", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "DX-7" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot,
        "DX",
      );
      writeIssue(repoRoot, issue);

      expect(findByExternalId(repoRoot, external_id)?.id).toBe("DX-7");
    });

    it("co-existing prefixes both resolve by external_id", async () => {
      const tracker = new MemoryTracker();
      const { external_id: extA } = await tracker.createCard(
        defaultCreate({ id: "DX-12" }),
      );
      const { external_id: extB } = await tracker.createCard(
        defaultCreate({ id: "SG-3" }),
      );
      writeIssue(
        repoRoot,
        await hydrateFromRemote(tracker, extA, "d-a", repoRoot, "DX"),
      );
      writeIssue(
        repoRoot,
        await hydrateFromRemote(tracker, extB, "d-b", repoRoot, "SG"),
      );

      expect(findByExternalId(repoRoot, extA)?.id).toBe("DX-12");
      expect(findByExternalId(repoRoot, extB)?.id).toBe("SG-3");
    });

    it("throws on malformed YAML — no silent skip", async () => {
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        join(repoRoot, ".danxbot", "issues", "open", "DX-99.yml"),
        "this: is: not: yaml: at: all: [",
      );
      expect(() => findByExternalId(repoRoot, "any-ext")).toThrow();
    });

    it("throws on rogue filename in the issues dir", () => {
      ensureIssuesDirs(repoRoot);
      writeFileSync(
        join(repoRoot, ".danxbot", "issues", "open", "garbage.yml"),
        "schema_version: 3\n",
      );
      expect(() => findByExternalId(repoRoot, "any-ext")).toThrow(
        /rogue filename/,
      );
    });
  });

  describe("writeIssue", () => {
    it("serializes and writes to open/<id>.yml; round-trips through parseIssue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-12" }),
      );
      const issue = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );

      writeIssue(repoRoot, issue);

      const path = issuePath(repoRoot, "ISS-12", "open");
      expect(existsSync(path)).toBe(true);
      const roundTripped = parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" });
      expect(roundTripped.id).toBe("ISS-12");
      expect(roundTripped.external_id).toBe(external_id);
      expect(roundTripped.dispatch?.id).toBe("did-1");
    });
  });

  describe("stampDispatchAndWrite", () => {
    it("overwrites dispatch_id and writes back, returning the updated Issue", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-13" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      writeIssue(repoRoot, original);

      const updated = stampDispatchAndWrite(repoRoot, original, "did-2");
      expect(updated.dispatch?.id).toBe("did-2");

      const reloaded = loadLocal(repoRoot, "ISS-13", "ISS");
      expect(reloaded?.dispatch?.id).toBe("did-2");
    });

    it("string form stamps the placeholder dispatch shape", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-14" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      writeIssue(repoRoot, original);

      const updated = stampDispatchAndWrite(repoRoot, original, "did-2");
      expect(updated.dispatch).toEqual({
        id: "did-2",
        pid: 0,
        host: "",
        kind: "work",
        started_at: "",
        ttl_seconds: 0,
      });
    });

    it("IssueDispatch form stamps the full record verbatim", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-15" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      writeIssue(repoRoot, original);

      const updated = stampDispatchAndWrite(repoRoot, original, {
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

      const reloaded = loadLocal(repoRoot, "ISS-15", "ISS");
      expect(reloaded?.dispatch?.pid).toBe(4321);
      expect(reloaded?.dispatch?.host).toBe("danxbot-host-a");
      expect(reloaded?.dispatch?.started_at).toBe("2026-05-07T12:00:00.000Z");
      expect(reloaded?.dispatch?.ttl_seconds).toBe(7200);
    });
  });

  describe("clearDispatchAndWrite", () => {
    it("sets dispatch to null and persists", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-16" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        "did-1",
        repoRoot, "ISS",
      );
      const stamped = stampDispatchAndWrite(repoRoot, original, {
        id: "did-1",
        pid: 9999,
        host: "host-x",
        kind: "work",
        started_at: "2026-05-07T12:00:00.000Z",
        ttl_seconds: 7200,
      });
      expect(stamped.dispatch).not.toBeNull();

      const cleared = clearDispatchAndWrite(repoRoot, stamped);
      expect(cleared.dispatch).toBeNull();

      const reloaded = loadLocal(repoRoot, "ISS-16", "ISS");
      expect(reloaded?.dispatch).toBeNull();
    });

    it("is a no-op when dispatch is already null (returns input, no write)", async () => {
      const tracker = new MemoryTracker();
      const { external_id } = await tracker.createCard(
        defaultCreate({ id: "ISS-17" }),
      );
      const original = await hydrateFromRemote(
        tracker,
        external_id,
        null,
        repoRoot, "ISS",
      );
      writeIssue(repoRoot, original);
      expect(original.dispatch).toBeNull();

      const result = clearDispatchAndWrite(repoRoot, original);
      // Same reference — no allocation, no spread.
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
