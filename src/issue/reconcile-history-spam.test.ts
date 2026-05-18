/**
 * DX-640 / Phase 2 of DX-638 — history-append gating.
 *
 * Pre-DX-640 the heal step's `worker:heal` history entry could fire
 * once per reconcile invocation across the corrupted-YAML→recovered
 * sequence DX-576 / DX-580 hit (~250 spurious entries in ~3min).
 *
 * Post-DX-640 the contract is:
 *
 *   - `applyHealHistory` fires ONLY when `decideFileMove` returns a
 *     non-null `healEntry` (closed → open direction, real semantic
 *     delta).
 *   - Subsequent reconciles see the file already in `open/`,
 *     `decideFileMove` returns null, no heal entry is appended.
 *   - The (cardHash, envGen) skip-cache short-circuits steady-state
 *     reconciles BEFORE the derive path, so corrupted-then-recovered
 *     cards land at most ONE heal entry per real `closed → open`
 *     direction flip.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import {
  reconcileIssue,
  _resetReconcileMutexes,
  _resetDispatchableCache,
  _resetTriageExpiresCache,
  _resetLastPushedHashes,
  _resetSkipCache,
  type ReconcileRepoContext,
} from "./reconcile.js";
import { _resetEnvGen } from "./env-generation.js";
import { ReconcileValidationError } from "./reconcile-types.js";
import { clearAllRepoNames, setRepoName } from "../poller/repo-name.js";

function makeIssue(id: string, status: IssueStatus = "ToDo"): Issue {
  return {
    schema_version: 10,
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
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
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
}

function makeRepoCtx(): {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
  closedDir: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-reconcile-spam-"));
  const openDir = resolve(root, ".danxbot", "issues", "open");
  const closedDir = resolve(root, ".danxbot", "issues", "closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  setRepoName(root, "test-repo");
  return {
    repo: { name: "test-repo", localPath: root, issuePrefix: "DX" },
    openDir,
    closedDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeYaml(dir: string, id: string, issue: Issue): string {
  const path = resolve(dir, `${id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

function countHealEntries(yamlText: string): number {
  const parsed = parseIssue(yamlText, { expectedPrefix: "DX" });
  return parsed.history.filter(
    (h) => h.actor === "worker:heal" && h.event === "status_change",
  ).length;
}

beforeEach(async () => {
  _resetReconcileMutexes();
  _resetDispatchableCache();
  _resetTriageExpiresCache();
  _resetLastPushedHashes();
  _resetSkipCache();
  _resetEnvGen();
  clearAllRepoNames();
  const triageTimer = await import("../dispatch/triage-timer.js");
  triageTimer._clearAllTriageTimers();
});

describe("reconcileIssue — history-spam regression (DX-640)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("repeated reconciles after a single closed→open heal never re-append worker:heal", async () => {
    // Plant a non-terminal card in closed/ — heal direction fires
    // ONCE on the first reconcile.
    const issue = makeIssue("DX-1", "ToDo");
    writeYaml(ctx.closedDir, "DX-1", issue);

    // First reconcile — heal moves closed → open + appends ONE heal
    // entry.
    const r1 = await reconcileIssue(ctx.repo, "DX-1", "watcher");
    expect(r1.changed).toBe(true);
    const openPath = resolve(ctx.openDir, "DX-1.yml");
    const afterHealText = readFileSync(openPath, "utf-8");
    expect(countHealEntries(afterHealText)).toBe(1);

    // 50 follow-up reconciles. The file is now in open/, `decideFileMove`
    // returns null, no new heal entry should ever land. The skip-cache
    // additionally short-circuits at the entry — but even without it,
    // history-gating in `applyHealHistory` would hold the invariant.
    for (let i = 0; i < 50; i++) {
      const r = await reconcileIssue(ctx.repo, "DX-1", "watcher");
      expect(r.changed).toBe(false);
    }
    const finalText = readFileSync(openPath, "utf-8");
    expect(countHealEntries(finalText)).toBe(1); // STILL 1 — no spam.
    // Byte-stable too — no rewrite after the initial heal.
    expect(finalText).toBe(afterHealText);
  });

  it("corrupted-YAML → recovered → repeated reconciles emit ≤1 worker:heal per real delta", async () => {
    // Plant a non-terminal card in closed/. Reconcile heals → open/
    // with ONE history entry.
    const issue = makeIssue("DX-2", "ToDo");
    writeYaml(ctx.closedDir, "DX-2", issue);
    await reconcileIssue(ctx.repo, "DX-2", "watcher");

    const openPath = resolve(ctx.openDir, "DX-2.yml");
    const cleanText = readFileSync(openPath, "utf-8");
    expect(countHealEntries(cleanText)).toBe(1);

    // Corrupt the YAML in place. Reconcile MUST reject (validation
    // error) and emit no side effects — no history, no write back.
    writeFileSync(openPath, "id: DX-2\n  not: { valid yaml :::");
    await expect(
      reconcileIssue(ctx.repo, "DX-2", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);

    // "Recover" — restore the clean YAML.
    writeFileSync(openPath, cleanText);
    const recoveryResult = await reconcileIssue(ctx.repo, "DX-2", "watcher");
    expect(recoveryResult.changed).toBe(false); // YAML already healthy.

    // 20 more reconciles to race through the corrupted→recovered loop.
    // None should emit a new heal entry.
    for (let i = 0; i < 20; i++) {
      await reconcileIssue(ctx.repo, "DX-2", "watcher");
    }
    expect(countHealEntries(readFileSync(openPath, "utf-8"))).toBe(1);
  });

  it("janitorial open→closed move on terminal status emits NO heal entry (DX-147 AC #3)", async () => {
    // Done card sitting in open/ — heal moves it to closed/ without
    // a history entry (filesystem-noise fix, not a state change).
    const issue = makeIssue("DX-3", "Done");
    writeYaml(ctx.openDir, "DX-3", issue);

    const r1 = await reconcileIssue(ctx.repo, "DX-3", "watcher");
    expect(r1.changed).toBe(true);
    const closedPath = resolve(ctx.closedDir, "DX-3.yml");
    expect(countHealEntries(readFileSync(closedPath, "utf-8"))).toBe(0);

    // Repeated reconciles — still zero heal entries.
    for (let i = 0; i < 10; i++) {
      await reconcileIssue(ctx.repo, "DX-3", "watcher");
    }
    expect(countHealEntries(readFileSync(closedPath, "utf-8"))).toBe(0);
  });

  it("re-applying a steady-state projection (no derivation movement) emits zero history", async () => {
    // Card with no children, no parent, status: ToDo in open/.
    // Every reconcile is a pure no-op. Across 30 reconciles, the
    // history array stays empty (no worker:auto-derive, no
    // worker:heal).
    const issue = makeIssue("DX-4", "ToDo");
    const path = writeYaml(ctx.openDir, "DX-4", issue);

    for (let i = 0; i < 30; i++) {
      await reconcileIssue(ctx.repo, "DX-4", "watcher");
    }
    const reread = parseIssue(readFileSync(path, "utf-8"), {
      expectedPrefix: "DX",
    });
    expect(reread.history).toEqual([]);
  });
});
