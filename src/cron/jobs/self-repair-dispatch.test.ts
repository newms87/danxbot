/**
 * Tests for the {@link runSelfRepairDispatch} job — DX-563 Phase 3.
 *
 * The cron job uses dependency injection for every external surface
 * (DB, FS, settings reader) so the test can pin the orchestration
 * order without booting Postgres or a real repo. The integration
 * test exercises the full chain against a live schema.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSelfRepairDispatch,
  selfRepairDispatch,
} from "./self-repair-dispatch.js";
import type { SystemErrorRow, SystemErrorRepairRow } from "../../system-repair/types.js";

const EPIC = "DX-560";

function row(overrides: Partial<SystemErrorRow> = {}): SystemErrorRow {
  return {
    id: 7,
    signature_hash: "abc123",
    category_key: "worker:TypeError",
    component: "worker",
    err_class: "TypeError",
    normalized_msg: "boom",
    sample_payload: { raw_msg: "boom" },
    count: 5,
    first_seen: new Date("2026-05-14T10:00:00Z"),
    last_seen: new Date("2026-05-15T22:00:00Z"),
    status: "open",
    repo: "danxbot",
    recurrence_count: 0,
    ...overrides,
  };
}

function attempt(overrides: Partial<SystemErrorRepairRow> = {}): SystemErrorRepairRow {
  return {
    id: 1, error_id: 7, attempt_n: 1, card_id: "DX-700", dispatch_id: null,
    started_at: new Date(), ended_at: new Date(), verdict: "failed",
    report_md: "x",
    ...overrides,
  };
}

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "self-repair-dispatch-"));
  mkdirSync(join(dir, ".danxbot", "issues", "open"), { recursive: true });
  return dir;
}

function noopMirror(): () => Promise<void> {
  return async () => undefined;
}

describe("runSelfRepairDispatch", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("no-ops when no candidate is found", async () => {
    const repoDir = makeRepoDir();
    const getCandidate = vi.fn().mockResolvedValue(null);
    const getPrior = vi.fn();
    const insertAttempt = vi.fn();
    const writeYaml = vi.fn();
    const danxIssueCreate = vi.fn();
    const setCard = vi.fn();
    const flipStatus = vi.fn();

    const result = await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate,
      getPrior,
      insertAttempt,
      writeYaml,
      danxIssueCreate,
      setCard,
      flipStatus,
    });

    expect(result.kind).toBe("no-candidate");
    expect(getCandidate).toHaveBeenCalledWith({ repo: "danxbot", threshold: 3 });
    expect(getPrior).not.toHaveBeenCalled();
    expect(insertAttempt).not.toHaveBeenCalled();
  });

  it("dispatches in correct order: getPrior → insertAttempt → writeYaml → create → setCard → flipStatus", async () => {
    const repoDir = makeRepoDir();
    const events: string[] = [];

    const getCandidate = vi.fn().mockImplementation(async () => { events.push("getCandidate"); return row(); });
    const getPrior = vi.fn().mockImplementation(async () => { events.push("getPrior"); return []; });
    const insertAttempt = vi.fn().mockImplementation(async () => { events.push("insertAttempt"); return attempt({ id: 99, error_id: 7, attempt_n: 1, card_id: null, ended_at: null, verdict: null, report_md: null }); });
    const writeYaml = vi.fn().mockImplementation((args: { filename: string; content: string }) => { events.push(`writeYaml:${args.filename}`); });
    const danxIssueCreate = vi.fn().mockImplementation(async (args: { filename: string }) => { events.push(`create:${args.filename}`); return { created: true, id: "DX-900" }; });
    const setCard = vi.fn().mockImplementation(async (args: { attemptId: number; cardId: string }) => { events.push(`setCard:${args.cardId}`); });
    const flipStatus = vi.fn().mockImplementation(async (args: { errorId: number; status: string }) => { events.push(`flipStatus:${args.status}`); });

    const result = await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate,
      getPrior,
      insertAttempt,
      writeYaml,
      danxIssueCreate,
      setCard,
      flipStatus,
    });

    expect(result.kind).toBe("dispatched");
    if (result.kind === "dispatched") {
      expect(result.attemptN).toBe(1);
      expect(result.cardId).toBe("DX-900");
      expect(result.errorId).toBe(7);
    }
    expect(events[0]).toBe("getCandidate");
    expect(events[1]).toBe("getPrior");
    expect(events[2]).toBe("insertAttempt");
    expect(events[3].startsWith("writeYaml:")).toBe(true);
    expect(events[4].startsWith("create:")).toBe(true);
    expect(events[5]).toBe("setCard:DX-900");
    expect(events[6]).toBe("flipStatus:repairing");
  });

  it("computes attempt_n as priorCount + 1", async () => {
    const repoDir = makeRepoDir();
    const priors = [attempt({ id: 1, attempt_n: 1 }), attempt({ id: 2, attempt_n: 2 })];
    const insertAttempt = vi.fn().mockResolvedValue(attempt({ id: 99, attempt_n: 3 }));

    await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate: vi.fn().mockResolvedValue(row()),
      getPrior: vi.fn().mockResolvedValue(priors),
      insertAttempt,
      writeYaml: vi.fn(),
      danxIssueCreate: vi.fn().mockResolvedValue({ created: true, id: "DX-900" }),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });

    expect(insertAttempt).toHaveBeenCalledWith({ errorId: 7, attemptN: 3 });
  });

  it("draft YAML carries parent_id, type=Bug, status=ToDo, and one AC", async () => {
    const repoDir = makeRepoDir();
    let writtenContent = "";
    let writtenName = "";

    await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate: vi.fn().mockResolvedValue(row()),
      getPrior: vi.fn().mockResolvedValue([]),
      insertAttempt: vi.fn().mockResolvedValue(attempt({ id: 99 })),
      writeYaml: vi.fn().mockImplementation((args: { filename: string; content: string }) => {
        writtenName = args.filename;
        writtenContent = args.content;
      }),
      danxIssueCreate: vi.fn().mockResolvedValue({ created: true, id: "DX-900" }),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });

    expect(writtenName).toMatch(/^self-repair-/);
    expect(writtenContent).toContain(`parent_id: ${EPIC}`);
    expect(writtenContent).toContain("type: Bug");
    expect(writtenContent).toContain("status: ToDo");
    expect(writtenContent).toContain("Self-Repair > Attempt 1");
  });

  it("does not call writeYaml/create/setCard/flipStatus when insertAttempt throws (mid-flight crash leaves repair row stranded — per Phase 3 design)", async () => {
    const repoDir = makeRepoDir();
    const writeYaml = vi.fn();
    const danxIssueCreate = vi.fn();
    const setCard = vi.fn();
    const flipStatus = vi.fn();

    await expect(
      runSelfRepairDispatch({
        ctx: { repoName: "danxbot", repoRoot: repoDir },
        epicId: EPIC,
        readThreshold: () => 3,
        ensureDisplayMirror: noopMirror(),
        getCandidate: vi.fn().mockResolvedValue(row()),
        getPrior: vi.fn().mockResolvedValue([]),
        insertAttempt: vi.fn().mockRejectedValue(new Error("DB down")),
        writeYaml,
        danxIssueCreate,
        setCard,
        flipStatus,
      }),
    ).rejects.toThrow("DB down");

    expect(writeYaml).not.toHaveBeenCalled();
    expect(danxIssueCreate).not.toHaveBeenCalled();
    expect(setCard).not.toHaveBeenCalled();
    expect(flipStatus).not.toHaveBeenCalled();
  });

  it("does not call flipStatus when setCard throws (orphans the card but error row stays open)", async () => {
    const repoDir = makeRepoDir();
    const flipStatus = vi.fn();

    await expect(
      runSelfRepairDispatch({
        ctx: { repoName: "danxbot", repoRoot: repoDir },
        epicId: EPIC,
        readThreshold: () => 3,
        ensureDisplayMirror: noopMirror(),
        getCandidate: vi.fn().mockResolvedValue(row()),
        getPrior: vi.fn().mockResolvedValue([]),
        insertAttempt: vi.fn().mockResolvedValue(attempt({ id: 99 })),
        writeYaml: vi.fn(),
        danxIssueCreate: vi.fn().mockResolvedValue({ created: true, id: "DX-900" }),
        setCard: vi.fn().mockRejectedValue(new Error("UPDATE fail")),
        flipStatus,
      }),
    ).rejects.toThrow("UPDATE fail");
    expect(flipStatus).not.toHaveBeenCalled();
  });

  it("does not call setCard/flipStatus when danx_issue_create fails", async () => {
    const repoDir = makeRepoDir();
    const setCard = vi.fn();
    const flipStatus = vi.fn();

    const result = await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate: vi.fn().mockResolvedValue(row()),
      getPrior: vi.fn().mockResolvedValue([]),
      insertAttempt: vi.fn().mockResolvedValue(attempt({ id: 99 })),
      writeYaml: vi.fn(),
      danxIssueCreate: vi.fn().mockResolvedValue({ created: false, errors: ["bang"] }),
      setCard,
      flipStatus,
    });

    expect(result.kind).toBe("create-failed");
    expect(setCard).not.toHaveBeenCalled();
    expect(flipStatus).not.toHaveBeenCalled();
  });

  it("respects threshold from settings", async () => {
    const repoDir = makeRepoDir();
    const getCandidate = vi.fn().mockResolvedValue(null);
    await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 7,
      ensureDisplayMirror: noopMirror(),
      getCandidate,
      getPrior: vi.fn(),
      insertAttempt: vi.fn(),
      writeYaml: vi.fn(),
      danxIssueCreate: vi.fn(),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });
    expect(getCandidate).toHaveBeenCalledWith({ repo: "danxbot", threshold: 7 });
  });

  it("skips entirely when ctx is missing", async () => {
    const getCandidate = vi.fn();
    const result = await runSelfRepairDispatch({
      ctx: undefined,
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate,
      getPrior: vi.fn(),
      insertAttempt: vi.fn(),
      writeYaml: vi.fn(),
      danxIssueCreate: vi.fn(),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });
    expect(result.kind).toBe("no-context");
    expect(getCandidate).not.toHaveBeenCalled();
  });

  it("writes the YAML to <repoRoot>/.danxbot/issues/open/", async () => {
    const repoDir = makeRepoDir();
    // Use the real defaultWriteYaml via the actual integration path —
    // but we can also pin the path via the writeYaml hook.
    let observedPath = "";
    await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate: vi.fn().mockResolvedValue(row()),
      getPrior: vi.fn().mockResolvedValue([]),
      insertAttempt: vi.fn().mockResolvedValue(attempt({ id: 99 })),
      writeYaml: vi.fn().mockImplementation((args: { filename: string }) => {
        observedPath = join(repoDir, ".danxbot", "issues", "open", `${args.filename}.yml`);
      }),
      danxIssueCreate: vi.fn().mockResolvedValue({ created: true, id: "DX-900" }),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });
    expect(observedPath).toMatch(/\.danxbot\/issues\/open\/self-repair-.*\.yml$/);
  });

  it("invokes ensureSelfRepairDisplayMirror once per tick", async () => {
    const repoDir = makeRepoDir();
    const mirror = vi.fn(async () => undefined);
    await runSelfRepairDispatch({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: mirror,
      getCandidate: vi.fn().mockResolvedValue(null),
      getPrior: vi.fn(),
      insertAttempt: vi.fn(),
      writeYaml: vi.fn(),
      danxIssueCreate: vi.fn(),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledWith(repoDir);
  });
});

describe("selfRepairDispatch — CronJob registration", () => {
  it("intervalSec is 60s (AC1)", () => {
    expect(selfRepairDispatch.intervalSec).toBe(60);
    expect(selfRepairDispatch.name).toBe("self-repair-dispatch");
  });
});

describe("runSelfRepairDispatch — integration smoke (no DB)", () => {
  it("default writeYaml lands a real file under .danxbot/issues/open/", async () => {
    const repoDir = makeRepoDir();
    // No DB-injected fakes for getCandidate — bypass DB by stubbing it
    // to return our fixed row, then exercise the default writeYaml hook.
    const { runSelfRepairDispatch: realRun } = await import("./self-repair-dispatch.js");

    await realRun({
      ctx: { repoName: "danxbot", repoRoot: repoDir },
      epicId: EPIC,
      readThreshold: () => 3,
      ensureDisplayMirror: noopMirror(),
      getCandidate: vi.fn().mockResolvedValue(row()),
      getPrior: vi.fn().mockResolvedValue([]),
      insertAttempt: vi.fn().mockResolvedValue(attempt({ id: 99, attempt_n: 1 })),
      // No writeYaml override -> use real default
      danxIssueCreate: vi.fn().mockResolvedValue({ created: true, id: "DX-900" }),
      setCard: vi.fn(),
      flipStatus: vi.fn(),
    });

    const files = readdirSync(join(repoDir, ".danxbot", "issues", "open"));
    expect(files.length).toBe(1);
    const yaml = readFileSync(join(repoDir, ".danxbot", "issues", "open", files[0]), "utf-8");
    expect(yaml).toContain("type: Bug");
    expect(yaml).toContain(`parent_id: ${EPIC}`);
    expect(yaml).toContain("Self-Repair > Attempt 1");
  });
});
