import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type {
  Issue,
  IssueRef,
  IssueStatus,
} from "../issue-tracker/interface.js";
import { resolveWaitingOnCards } from "./waiting-on-resolver.js";

function buildIssue(overrides: Partial<Issue> & { id: string }): Issue {
  const { id, ...rest } = overrides;
  const merged: Issue = {
    schema_version: 4,
    tracker: "memory",
    id,
    external_id: `ext-${id}`,
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: `Title for ${id}`,
    description: "",
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
    ...rest,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
}

function writeIssueAt(repoRoot: string, issue: Issue, state: "open" | "closed" = "open"): void {
  const dir = resolve(repoRoot, ".danxbot", "issues", state);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issue.id}.yml`), serializeIssue(issue));
}

function loadIssue(repoRoot: string, id: string, state: "open" | "closed" = "open"): Issue {
  const path = resolve(repoRoot, ".danxbot", "issues", state, `${id}.yml`);
  return parseIssue(readFileSync(path, "utf-8"));
}

function ref(externalId: string, title: string, status: IssueStatus): IssueRef {
  return { id: "", external_id: externalId, title, status };
}

describe("resolveWaitingOnCards", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-waiting-on-resolver-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const ctx = (root: string) => ({
    name: "test-repo",
    localPath: root,
    issuePrefix: "ISS",
  });

  it("passes through cards with no local YAML (defensive — bulk-sync covers these)", () => {
    const cards = [ref("ext-orphan", "No local YAML yet", "ToDo")];
    expect(resolveWaitingOnCards(ctx(repoRoot), cards)).toEqual(cards);
  });

  it("passes through cards whose local YAML has waiting_on: null", () => {
    const issue = buildIssue({ id: "ISS-1", waiting_on: null });
    writeIssueAt(repoRoot, issue);

    const cards = [ref(issue.external_id, issue.title, "ToDo")];
    expect(resolveWaitingOnCards(ctx(repoRoot), cards)).toEqual(cards);

    // Untouched — no history added.
    expect(loadIssue(repoRoot, "ISS-1").history).toEqual([]);
  });

  it("drops cards whose deps are still non-terminal — no clear, no history entry", () => {
    const dep = buildIssue({ id: "ISS-99", status: "In Progress" });
    const waiting = buildIssue({
      id: "ISS-1",
      waiting_on: {
        reason: "Waits on ISS-99",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-99"],
      },
    });
    writeIssueAt(repoRoot, dep);
    writeIssueAt(repoRoot, waiting);

    const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
    const out = resolveWaitingOnCards(ctx(repoRoot), cards);
    expect(out).toEqual([]);

    const reloaded = loadIssue(repoRoot, "ISS-1");
    expect(reloaded.waiting_on).not.toBeNull();
    expect(reloaded.history).toEqual([]);
  });

  // ----- DX-147 — auto-clear emits worker:auto-derive unblocked entry -----

  it("DX-147: clearing waiting_on when every dep is terminal appends ONE worker:auto-derive unblocked entry with the dep ids in the note", () => {
    // Two deps: one Done, one Cancelled — both terminal.
    const d1 = buildIssue({ id: "ISS-90", status: "Done" });
    const d2 = buildIssue({ id: "ISS-91", status: "Cancelled" });
    writeIssueAt(repoRoot, d1, "closed");
    writeIssueAt(repoRoot, d2, "closed");

    const waiting = buildIssue({
      id: "ISS-1",
      waiting_on: {
        reason: "Waits on ISS-90 + ISS-91",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-90", "ISS-91"],
      },
    });
    writeIssueAt(repoRoot, waiting);

    const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
    const out = resolveWaitingOnCards(ctx(repoRoot), cards);
    expect(out).toEqual(cards);

    const reloaded = loadIssue(repoRoot, "ISS-1");
    expect(reloaded.waiting_on).toBeNull();
    expect(reloaded.history).toHaveLength(1);
    const entry = reloaded.history[0];
    expect(entry.actor).toBe("worker:auto-derive");
    expect(entry.event).toBe("unblocked");
    // Note must reference EVERY dep id so dashboard readers can
    // correlate the unblock back to the chain (`note: All deps
    // terminal: ISS-X, ISS-Y` per the spec).
    expect(entry.note).toContain("ISS-90");
    expect(entry.note).toContain("ISS-91");
    // ISO-8601 surface check.
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
  });

  it("DX-147: a missing dep (no YAML on disk) keeps the card waiting — no clear, no history entry", () => {
    // `waiting_on.by` references a never-created dep. The resolver
    // treats that as "still waiting" (per the docstring) and drops
    // the card from the dispatch list. No write to disk, no history
    // mutation. Pins the missing-dep branch at
    // `waiting-on-resolver.ts:67-70` (`stillWaiting.push(\`${id}(missing)\`)`).
    const waiting = buildIssue({
      id: "ISS-1",
      waiting_on: {
        reason: "Waits on ISS-99 (does not exist locally)",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-99"],
      },
    });
    writeIssueAt(repoRoot, waiting);

    const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
    const out = resolveWaitingOnCards(ctx(repoRoot), cards);
    expect(out).toEqual([]);

    const reloaded = loadIssue(repoRoot, "ISS-1");
    expect(reloaded.waiting_on).not.toBeNull();
    expect(reloaded.history).toEqual([]);
  });

  it("DX-147: ANY non-terminal dep keeps the card waiting even if other deps are terminal (mixed set)", () => {
    // Three deps: two terminal, one In Progress. The "ANY
    // non-terminal" rule means the card stays waiting. Pins the
    // existential semantic of `stillWaiting.length > 0`.
    const done = buildIssue({ id: "ISS-90", status: "Done" });
    const cancelled = buildIssue({ id: "ISS-91", status: "Cancelled" });
    const live = buildIssue({ id: "ISS-92", status: "In Progress" });
    writeIssueAt(repoRoot, done, "closed");
    writeIssueAt(repoRoot, cancelled, "closed");
    writeIssueAt(repoRoot, live);

    const waiting = buildIssue({
      id: "ISS-1",
      waiting_on: {
        reason: "Waits on three deps",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-90", "ISS-91", "ISS-92"],
      },
    });
    writeIssueAt(repoRoot, waiting);

    const cards = [ref(waiting.external_id, waiting.title, "ToDo")];
    const out = resolveWaitingOnCards(ctx(repoRoot), cards);
    expect(out).toEqual([]);

    const reloaded = loadIssue(repoRoot, "ISS-1");
    expect(reloaded.waiting_on).not.toBeNull();
    expect(reloaded.history).toEqual([]);
  });

  it("appends history without losing prior entries (cap + truncation are appendHistory's responsibility)", () => {
    const d = buildIssue({ id: "ISS-90", status: "Done" });
    writeIssueAt(repoRoot, d, "closed");

    const prior = {
      timestamp: "2026-05-01T00:00:00.000Z",
      actor: "dispatch:abc",
      event: "blocked" as const,
      to: "ToDo" as IssueStatus,
      note: "Waiting on ISS-90",
    };
    const waiting = buildIssue({
      id: "ISS-1",
      waiting_on: {
        reason: "Waits on ISS-90",
        timestamp: "2026-05-08T00:00:00.000Z",
        by: ["ISS-90"],
      },
      history: [prior],
    });
    writeIssueAt(repoRoot, waiting);

    resolveWaitingOnCards(ctx(repoRoot), [ref(waiting.external_id, waiting.title, "ToDo")]);

    const reloaded = loadIssue(repoRoot, "ISS-1");
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.history[0]).toMatchObject(prior);
    expect(reloaded.history[1].actor).toBe("worker:auto-derive");
    expect(reloaded.history[1].event).toBe("unblocked");
  });
});
