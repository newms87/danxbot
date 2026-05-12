import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConflictVerdict } from "./apply-conflict-verdict.js";
import { serializeIssue, parseIssue } from "../issue-tracker/yaml.js";
import type { Issue, WaitingOn } from "../issue-tracker/interface.js";
import type {
  ConflictVerdict,
} from "../dispatch/conflict-check.js";
import type { RepoContext } from "../types.js";

function issue(
  id: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: id,
    description: "",
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
    history: [],
    ...overrides,
  };
}

let repoDir: string;
let repo: RepoContext;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "apply-conflict-test-"));
  repo = {
    name: "danxbot",
    localPath: repoDir,
    issuePrefix: "DX",
    workerPort: 5562,
  } as unknown as RepoContext;
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function readBack(id: string): Issue {
  const path = join(repoDir, ".danxbot", "issues", "open", `${id}.yml`);
  return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "DX" });
}

function seedOnDisk(i: Issue): void {
  const dir = join(repoDir, ".danxbot", "issues", "open");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${i.id}.yml`), serializeIssue(i), "utf-8");
}

describe("applyConflictVerdict", () => {
  it("kind=ok → transient, no YAML write", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = { kind: "ok", reason: "x" };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, []);
    expect(outcome).toBe("transient");
    // YAML unchanged.
    expect(readBack("DX-1").conflict_on).toEqual([]);
  });

  it("kind=conflict with empty partners → transient, no YAML write", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = {
      kind: "conflict",
      reason: "spawn failed",
      partners: [],
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, []);
    expect(outcome).toBe("transient");
    expect(readBack("DX-1").conflict_on).toEqual([]);
  });

  it("kind=conflict → stamps candidate.conflict_on persistently", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = {
      kind: "conflict",
      reason: "shared module",
      partners: [
        { id: "DX-2", reason: "fn rename in module X" },
        { id: "DX-3", reason: "interface signature change" },
      ],
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, []);
    expect(outcome).toBe("conflict_on");
    const fresh = readBack("DX-1");
    expect(fresh.conflict_on).toEqual([
      { id: "DX-2", reason: "fn rename in module X" },
      { id: "DX-3", reason: "interface signature change" },
    ]);
  });

  it("conflict stamp merges with existing entries (dedup by id, last reason wins)", async () => {
    const candidate = issue("DX-1", {
      conflict_on: [
        { id: "DX-2", reason: "stale reason" },
        { id: "DX-5", reason: "untouched" },
      ],
    });
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = {
      kind: "conflict",
      reason: "x",
      partners: [{ id: "DX-2", reason: "updated reason" }],
    };
    await applyConflictVerdict(repo, candidate, verdict, []);
    const fresh = readBack("DX-1");
    expect(fresh.conflict_on).toEqual([
      { id: "DX-2", reason: "updated reason" },
      { id: "DX-5", reason: "untouched" },
    ]);
  });

  it("conflict stamp ignores self-references defensively", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = {
      kind: "conflict",
      reason: "x",
      partners: [
        { id: "DX-1", reason: "self — should be dropped" },
        { id: "DX-2", reason: "ok" },
      ],
    };
    await applyConflictVerdict(repo, candidate, verdict, []);
    expect(readBack("DX-1").conflict_on).toEqual([
      { id: "DX-2", reason: "ok" },
    ]);
  });

  it("kind=wait_for with no cycle → stamps candidate.waiting_on persistently", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const partner = issue("DX-2", { status: "In Progress" });
    const verdict: ConflictVerdict = {
      kind: "wait_for",
      reason: "DX-2 defines the AgentLock interface",
      wait_for: ["DX-2"],
      consumed_artifact: "AgentLock interface",
      cycle_audit: { walked: ["DX-2"] },
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, [
      partner,
    ]);
    expect(outcome).toBe("waiting_on");
    const fresh = readBack("DX-1");
    expect(fresh.status).toBe("ToDo");
    expect(fresh.waiting_on).not.toBeNull();
    expect(fresh.waiting_on?.by).toEqual(["DX-2"]);
    expect(fresh.waiting_on?.reason).toMatch(/AgentLock interface/);
  });

  it("kind=wait_for with cycle (candidate appears in partner's waiting_on chain) → demoted to conflict_on", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    // Partner DX-2 transitively waits on DX-1 via DX-3.
    const partner = issue("DX-2", {
      status: "In Progress",
      waiting_on: <WaitingOn>{
        reason: "depends on DX-3",
        timestamp: "2026-05-12T00:00:00Z",
        by: ["DX-3"],
      },
    });
    const middle = issue("DX-3", {
      status: "ToDo",
      waiting_on: <WaitingOn>{
        reason: "depends on DX-1",
        timestamp: "2026-05-12T00:00:00Z",
        by: ["DX-1"], // cycle back to candidate
      },
    });
    const verdict: ConflictVerdict = {
      kind: "wait_for",
      reason: "DX-2 defines artifact",
      wait_for: ["DX-2"],
      consumed_artifact: "X",
      cycle_audit: { walked: ["DX-2"] },
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, [
      partner,
      middle,
    ]);
    expect(outcome).toBe("waiting_on_demoted_to_conflict");
    const fresh = readBack("DX-1");
    // waiting_on NOT stamped.
    expect(fresh.waiting_on).toBeNull();
    // conflict_on stamped instead.
    expect(fresh.conflict_on).toHaveLength(1);
    expect(fresh.conflict_on[0].id).toBe("DX-2");
    expect(fresh.conflict_on[0].reason).toMatch(/demoted from wait_for/i);
  });

  it("kind=wait_for with empty wait_for[] → transient (defensive)", async () => {
    const candidate = issue("DX-1");
    seedOnDisk(candidate);
    const verdict: ConflictVerdict = {
      kind: "wait_for",
      reason: "x",
      wait_for: [],
      consumed_artifact: "X",
      cycle_audit: { walked: [] },
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, []);
    expect(outcome).toBe("transient");
    expect(readBack("DX-1").waiting_on).toBeNull();
  });

  it("conflict stamp creates the issues/open/ dir if missing (no pre-seed)", async () => {
    const candidate = issue("DX-1");
    // NO seedOnDisk — the picker may reach this path before any other
    // writer has touched the issue dir on a fresh repo. mkdir -p
    // recursive ensures the write succeeds.
    const verdict: ConflictVerdict = {
      kind: "conflict",
      reason: "x",
      partners: [{ id: "DX-2", reason: "shared module" }],
    };
    const outcome = await applyConflictVerdict(repo, candidate, verdict, []);
    expect(outcome).toBe("conflict_on");
    expect(readBack("DX-1").conflict_on).toEqual([
      { id: "DX-2", reason: "shared module" },
    ]);
  });
});
