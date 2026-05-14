/**
 * Unit tests for `cleanupLegacyNeedsApproval` (DX-265).
 *
 * Stubs `globalThis.fetch` to drive the Trello SDK calls underneath
 * `TrelloTracker`. Asserts the orchestrator's externally-observable
 * behavior: which Trello endpoints fire, what local YAMLs land on
 * disk, and what system-events get recorded. Per-step failure modes
 * (lookup throws, migration throws, archive throws, delete throws) are
 * each exercised individually so the audit-trail expectations are
 * pinned to the actual recordSystemError calls — the orchestrator's
 * graceful-degradation contract is the load-bearing invariant
 * documented in `src/worker/legacy-cleanup.ts` and the AC list.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanupLegacyNeedsApproval } from "../../worker/legacy-cleanup.js";
import { TrelloTracker } from "../../issue-tracker/trello.js";
import { MemoryTracker } from "../../issue-tracker/__test__-memory.js";
import { _resetForTesting as resetCircuit } from "../../issue-tracker/circuit-breaker.js";
import {
  _clearSystemErrors,
  listSystemErrors,
} from "../../dashboard/system-errors.js";
import type { TrelloConfig, RepoContext } from "../../types.js";
import type { IssueTracker } from "../../issue-tracker/interface.js";

const TRELLO: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "board",
  reviewListId: "list-review",
  todoListId: "list-todo",
  inProgressListId: "list-ip",
  needsHelpListId: "list-nh",
  doneListId: "list-done",
  cancelledListId: "list-cancelled",
  actionItemsListId: "list-ai",
  bugLabelId: "lbl-bug",
  featureLabelId: "lbl-feature",
  epicLabelId: "lbl-epic",
  needsHelpLabelId: "lbl-nh",
  blockedLabelId: "lbl-blocked",
  requiresHumanLabelId: "lbl-rh",
  triagedLabelId: "lbl-triaged",
};

const LEGACY_LIST_ID = "list-legacy-na";
const LEGACY_LABEL_ID = "lbl-legacy-na";

function makeRepoContext(localPath: string): RepoContext {
  return {
    name: "test-repo",
    url: "git@example:test/test.git",
    localPath,
    hostPath: localPath,
    trello: TRELLO,
    trelloEnabled: true,
    slack: {
      enabled: false,
      botToken: "",
      appToken: "",
      channelId: "",
    },
    db: {
      host: "",
      port: 0,
      user: "",
      password: "",
      database: "",
      enabled: false,
    },
    githubToken: "",
    workerPort: 0,
    issuePrefix: "DX",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 200): Response {
  return new Response("", { status });
}

describe("cleanupLegacyNeedsApproval", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let scratch: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    scratch = mkdtempSync(join(tmpdir(), "legacy-cleanup-"));
    // Create the issues dirs the writeIssue path expects.
    mkdirSync(join(scratch, ".danxbot", "issues", "open"), { recursive: true });
    mkdirSync(join(scratch, ".danxbot", "issues", "closed"), {
      recursive: true,
    });
    _clearSystemErrors();
    // DX-300: reset the process-wide Trello circuit breaker between
    // cases. Several tests below inject 429 responses to test failure
    // paths, which trips the breaker; without this reset, the next
    // test's `deleteLabel` / `archiveList` would short-circuit before
    // hitting fetch and the "label cleanup still runs" invariant
    // would silently break.
    resetCircuit();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(scratch, { recursive: true, force: true });
    _clearSystemErrors();
    resetCircuit();
  });

  // Default lookup mock: list + label both absent. Per-test scenarios
  // override specific URLs above this fallback by checking `mockImplementation`
  // order — `vi.fn().mockImplementation` always picks the latest registered
  // impl, so tests register their full handler in one shot.
  function installFetchHandler(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
    fetchMock.mockImplementation(handler);
  }

  it("non-Trello tracker → skipped=true with no API calls", async () => {
    const tracker: IssueTracker = new MemoryTracker();
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result).toEqual({
      migrated: [],
      failedMigrations: [],
      listArchived: false,
      labelDeleted: false,
      skipped: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSystemErrors()).toEqual([]);
  });

  it("empty board (no list, no label) → no mutations, no system events", async () => {
    installFetchHandler(async (url: string) => {
      if (url.includes("/boards/board/lists")) return jsonResponse([]);
      if (url.includes("/boards/board/labels")) return jsonResponse([]);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result).toEqual({
      migrated: [],
      failedMigrations: [],
      listArchived: false,
      labelDeleted: false,
      skipped: false,
    });

    // Only the two lookup calls fired — no PUT/DELETE.
    const methods = fetchMock.mock.calls.map((c) => c[1]?.method ?? "GET");
    expect(methods).toEqual(["GET", "GET"]);
    expect(listSystemErrors()).toEqual([]);
  });

  it("list-only present (no cards) → archive + info event, no label op", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
          { id: "list-other", name: "Other", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels")) return jsonResponse([]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/closed`) && init?.method === "PUT")
        return emptyResponse(200);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.listArchived).toBe(true);
    expect(result.labelDeleted).toBe(false);
    expect(result.migrated).toEqual([]);
    expect(result.failedMigrations).toEqual([]);

    // One info event for the archival.
    const events = listSystemErrors();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe("info");
    expect(events[0]?.source).toBe("legacy-cleanup");
    expect(events[0]?.message).toMatch(/Archived legacy .* list/);
  });

  it("label-only present → delete + info event, no list op", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists")) return jsonResponse([]);
      if (url.includes("/boards/board/labels"))
        return jsonResponse([
          { id: LEGACY_LABEL_ID, name: "Needs Approval" },
          { id: "lbl-other", name: "Other" },
        ]);
      if (url.includes(`/labels/${LEGACY_LABEL_ID}`) && init?.method === "DELETE")
        return emptyResponse(200);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.labelDeleted).toBe(true);
    expect(result.listArchived).toBe(false);
    expect(result.migrated).toEqual([]);

    const events = listSystemErrors();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe("info");
    expect(events[0]?.message).toMatch(/Deleted legacy .* label/);
  });

  it("both present, no cards → archive + delete + two info events", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([{ id: LEGACY_LABEL_ID, name: "Needs Approval" }]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/closed`) && init?.method === "PUT")
        return emptyResponse(200);
      if (url.includes(`/labels/${LEGACY_LABEL_ID}`) && init?.method === "DELETE")
        return emptyResponse(200);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.listArchived).toBe(true);
    expect(result.labelDeleted).toBe(true);

    const events = listSystemErrors();
    expect(events.map((e) => e.severity)).toEqual(["info", "info"]);
    const messages = events.map((e) => e.message).join("\n");
    expect(messages).toMatch(/Archived legacy .* list/);
    expect(messages).toMatch(/Deleted legacy .* label/);
  });

  it("cards on legacy list → each migrated to Review w/ requires_human + ## Migration comment, list archived", async () => {
    const CARD_ID = "card-abc123";

    installFetchHandler(async (url: string, init?: RequestInit) => {
      // Board lookups for list + label.
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([]); // label absent — exercise list-only path with cards

      // Cards on the legacy list.
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([{ id: CARD_ID, name: "#DX-99: Stray legacy card" }]);

      // The migrate step moves the card to Review FIRST (PUT idList) so
      // the subsequent getCard's listIdToStatus mapping resolves.
      if (
        url.includes(`/cards/${CARD_ID}?`) &&
        init?.method === "PUT" &&
        typeof init.body === "string" &&
        init.body.includes(`"idList":"${TRELLO.reviewListId}"`)
      ) {
        return emptyResponse(200);
      }

      // After the move, getCard reads the card with idList=Review.
      if (
        url.includes(`/cards/${CARD_ID}`) &&
        url.includes("checklists=all") &&
        (!init || init.method === "GET")
      ) {
        return jsonResponse({
          id: CARD_ID,
          name: "#DX-99: Stray legacy card",
          desc: "Pre-existing description",
          idList: TRELLO.reviewListId,
          idLabels: [],
          checklists: [],
        });
      }

      // getComments returns an empty action list.
      if (
        url.includes(`/cards/${CARD_ID}/actions`) &&
        (!init || init.method === "GET")
      ) {
        return jsonResponse([]);
      }

      // Archive the now-empty list.
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        return emptyResponse(200);
      }

      throw new Error(`unexpected url: ${url} method=${init?.method ?? "GET"}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.migrated).toEqual([CARD_ID]);
    expect(result.failedMigrations).toEqual([]);
    expect(result.listArchived).toBe(true);

    // Verify the YAML landed on disk with the required shape.
    const yamlPath = join(scratch, ".danxbot", "issues", "open", "DX-99.yml");
    expect(existsSync(yamlPath)).toBe(true);
    const yamlText = readFileSync(yamlPath, "utf-8");
    expect(yamlText).toMatch(/^status:\s*"?Review"?\s*$/m);
    expect(yamlText).toContain("requires_human:");
    expect(yamlText).toContain(
      "Auto-migrated from legacy Needs Approval Trello list",
    );
    expect(yamlText).toContain("set_by: agent");
    expect(yamlText).toContain("## Migration");

    // Info events: 1 per migrated card + 1 archive.
    const events = listSystemErrors();
    expect(events.map((e) => e.severity)).toEqual(["info", "info"]);
  });

  it("idempotent — second run with artifacts already absent records no events and makes no mutations", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT")
        return jsonResponse([]);
      if (url.includes("/boards/board/labels")) return jsonResponse([]);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    // First call (already-clean board).
    const first = await cleanupLegacyNeedsApproval({ repo, tracker });
    // Second call.
    const second = await cleanupLegacyNeedsApproval({ repo, tracker });

    for (const r of [first, second]) {
      expect(r.listArchived).toBe(false);
      expect(r.labelDeleted).toBe(false);
      expect(r.migrated).toEqual([]);
    }
    expect(listSystemErrors()).toEqual([]);
  });

  it("archive failure → warn event, label cleanup still runs", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([{ id: LEGACY_LABEL_ID, name: "Needs Approval" }]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([]);
      // Archive call returns 500.
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        return new Response("server error", { status: 500 });
      }
      if (url.includes(`/labels/${LEGACY_LABEL_ID}`) && init?.method === "DELETE")
        return emptyResponse(200);
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.listArchived).toBe(false);
    // Label cleanup independent of list cleanup — proceeds.
    expect(result.labelDeleted).toBe(true);

    const severities = listSystemErrors().map((e) => e.severity);
    // Order: warn (archive failure) then info (label deleted).
    expect(severities).toContain("warn");
    expect(severities).toContain("info");
  });

  it("card migration failure → list archival deferred, label cleanup still runs", async () => {
    const CARD_ID = "card-fails";

    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([{ id: LEGACY_LABEL_ID, name: "Needs Approval" }]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([{ id: CARD_ID, name: "#DX-100: Card that fails" }]);
      // moveToStatus PUT fails — migration aborts before getCard fires.
      // DX-300: use 5xx not 429 — a 429 trips the process-wide circuit
      // breaker, which (correctly) pauses every subsequent Trello call
      // including the deleteLabel cleanup we want this test to observe.
      // The intent of the test ("orchestrator continues past one
      // failure") is preserved with any non-2xx code; rate-limit
      // back-pressure is a separate concern pinned in
      // `src/__tests__/integration/trello-circuit.test.ts`.
      if (url.includes(`/cards/${CARD_ID}?`) && init?.method === "PUT") {
        return new Response("server error", { status: 500 });
      }
      // Archive must NOT be called when migration failed — assert this
      // via the throw in the default branch below.
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        throw new Error("Archive must not run when migration failed");
      }
      if (url.includes(`/labels/${LEGACY_LABEL_ID}`) && init?.method === "DELETE")
        return emptyResponse(200);
      throw new Error(`unexpected url: ${url} method=${init?.method ?? "GET"}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.migrated).toEqual([]);
    expect(result.failedMigrations).toEqual([CARD_ID]);
    expect(result.listArchived).toBe(false);
    expect(result.labelDeleted).toBe(true);

    // YAML must NOT exist for the failed-migration card.
    expect(
      existsSync(join(scratch, ".danxbot", "issues", "open", "DX-100.yml")),
    ).toBe(false);

    const severities = listSystemErrors().map((e) => e.severity);
    expect(severities).toContain("warn"); // migration warn
    expect(severities).toContain("info"); // label deleted info
  });

  it("delete-label failure → warn event, list archive still succeeds", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([{ id: LEGACY_LABEL_ID, name: "Needs Approval" }]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([]);
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        return emptyResponse(200);
      }
      if (
        url.includes(`/labels/${LEGACY_LABEL_ID}`) &&
        init?.method === "DELETE"
      ) {
        return new Response("conflict", { status: 409 });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    // List archive proceeds; label delete fails — independent paths.
    expect(result.listArchived).toBe(true);
    expect(result.labelDeleted).toBe(false);

    const events = listSystemErrors();
    const severities = events.map((e) => e.severity);
    expect(severities).toContain("info"); // archive info
    expect(severities).toContain("warn"); // delete warn
    expect(
      events.find((e) => e.severity === "warn")?.message,
    ).toMatch(/failed to delete .* label/);
  });

  it("listCards failure with label present → warn event, archive skipped, label still deleted", async () => {
    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([{ id: LEGACY_LABEL_ID, name: "Needs Approval" }]);
      // Enumerating cards on the legacy list blows up — orchestrator
      // can't safely decide whether the list is empty, so it skips
      // archival entirely. Label cleanup is independent and proceeds.
      // DX-300: use 5xx not 429 — see the matching comment in the
      // "card migration failure" test for the rate-limit-vs-circuit
      // rationale.
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`)) {
        return new Response("server error", { status: 500 });
      }
      // Archive call MUST NOT fire — guarded by the catch.
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        throw new Error("Archive must not fire when listCards failed");
      }
      if (
        url.includes(`/labels/${LEGACY_LABEL_ID}`) &&
        init?.method === "DELETE"
      ) {
        return emptyResponse(200);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.migrated).toEqual([]);
    expect(result.failedMigrations).toEqual([]);
    expect(result.listArchived).toBe(false);
    expect(result.labelDeleted).toBe(true);

    const events = listSystemErrors();
    const severities = events.map((e) => e.severity);
    expect(severities).toContain("warn"); // listCards warn
    expect(severities).toContain("info"); // label deleted info
    expect(
      events.find((e) => e.severity === "warn")?.message,
    ).toMatch(/failed to enumerate cards/);
  });

  it("partial-success migration loop → successful card lands, failed card recorded, archive deferred", async () => {
    // Two cards: first succeeds end-to-end, second fails on moveToStatus.
    // The loop must continue past the failure (no early break), so we
    // observe both events in the audit trail and the success-side YAML
    // on disk.
    const OK_CARD = "card-ok";
    const FAIL_CARD = "card-fail";

    installFetchHandler(async (url: string, init?: RequestInit) => {
      if (url.includes("/boards/board/lists") && init?.method !== "PUT") {
        return jsonResponse([
          { id: LEGACY_LIST_ID, name: "Needs Approval", closed: false },
        ]);
      }
      if (url.includes("/boards/board/labels"))
        return jsonResponse([]);
      if (url.includes(`/lists/${LEGACY_LIST_ID}/cards`))
        return jsonResponse([
          { id: OK_CARD, name: "#DX-200: First (OK)" },
          { id: FAIL_CARD, name: "#DX-201: Second (FAIL)" },
        ]);

      // OK card: move + hydrate + getComments succeed.
      if (
        url.includes(`/cards/${OK_CARD}?`) &&
        init?.method === "PUT" &&
        typeof init.body === "string" &&
        init.body.includes(`"idList":"${TRELLO.reviewListId}"`)
      ) {
        return emptyResponse(200);
      }
      if (
        url.includes(`/cards/${OK_CARD}`) &&
        url.includes("checklists=all")
      ) {
        return jsonResponse({
          id: OK_CARD,
          name: "#DX-200: First (OK)",
          desc: "",
          idList: TRELLO.reviewListId,
          idLabels: [],
          checklists: [],
        });
      }
      if (
        url.includes(`/cards/${OK_CARD}/actions`) &&
        (!init || init.method === "GET")
      ) {
        return jsonResponse([]);
      }

      // FAIL card: move throws (rate limit).
      if (url.includes(`/cards/${FAIL_CARD}?`) && init?.method === "PUT") {
        return new Response("rate limited", { status: 429 });
      }

      // Archive MUST NOT run — failedMigrations.length > 0.
      if (
        url.includes(`/lists/${LEGACY_LIST_ID}/closed`) &&
        init?.method === "PUT"
      ) {
        throw new Error("Archive must not run when any migration failed");
      }
      throw new Error(`unexpected url: ${url} method=${init?.method ?? "GET"}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.migrated).toEqual([OK_CARD]);
    expect(result.failedMigrations).toEqual([FAIL_CARD]);
    expect(result.listArchived).toBe(false);

    // Successful card's YAML must exist.
    expect(
      existsSync(join(scratch, ".danxbot", "issues", "open", "DX-200.yml")),
    ).toBe(true);
    // Failed card's YAML must NOT exist (move-to-Review fails before
    // hydrate, so nothing lands on disk).
    expect(
      existsSync(join(scratch, ".danxbot", "issues", "open", "DX-201.yml")),
    ).toBe(false);

    const events = listSystemErrors();
    const messages = events.map((e) => e.message).join("\n");
    expect(messages).toMatch(/Migrated card card-ok/);
    expect(messages).toMatch(/failed to migrate card card-fail/);
  });

  it("lookup failure on `findListByName` → warn event, returns without further calls", async () => {
    installFetchHandler(async (url: string) => {
      if (url.includes("/boards/board/lists")) {
        return new Response("auth fail", { status: 401 });
      }
      // Even though findLabelByName runs in Promise.all, it should also
      // see the error from the failing branch — we don't reach archive
      // or delete regardless.
      if (url.includes("/boards/board/labels")) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const tracker = new TrelloTracker(TRELLO);
    const repo = makeRepoContext(scratch);

    const result = await cleanupLegacyNeedsApproval({ repo, tracker });

    expect(result.listArchived).toBe(false);
    expect(result.labelDeleted).toBe(false);
    expect(result.skipped).toBe(false);

    const events = listSystemErrors();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe("warn");
    expect(events[0]?.message).toMatch(/lookup failed/);
  });
});
