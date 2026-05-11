import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armTriageTimer,
  clearTriageTimer,
  scanAndArmTriageTimers,
  _clearAllTriageTimers,
  _isTriageTimerArmed,
  _getTriageTimerExpiresAt,
  type ReconcileFn,
} from "./triage-timer.js";
import {
  createEmptyIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type { ReconcileRepoContext } from "../issue/reconcile.js";
import type { ReconcileResult } from "../issue/reconcile-types.js";

function emptyResult(): ReconcileResult {
  return {
    changed: false,
    prevHash: null,
    nextHash: "",
    errors: [],
    fanout: {
      parentId: null,
      dependents: [],
      dispatchableChanged: false,
    },
  };
}

function makeRepo(localPath: string, name = "danxbot"): ReconcileRepoContext {
  return { name, localPath, issuePrefix: "DX" };
}

describe("triage-timer", () => {
  let tempDir: string;
  let repo: ReconcileRepoContext;
  let reconcile: ReconcileFn;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
    tempDir = mkdtempSync(join(tmpdir(), "triage-timer-test-"));
    mkdirSync(join(tempDir, ".danxbot", "issues", "open"), { recursive: true });
    repo = makeRepo(tempDir);
    reconcile = vi.fn<ReconcileFn>().mockResolvedValue(emptyResult());
    _clearAllTriageTimers();
  });

  afterEach(() => {
    _clearAllTriageTimers();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("armTriageTimer", () => {
    it("fires reconcile in audit mode after expiresAt elapses", async () => {
      const expiresAtMs = Date.now() + 60_000;
      armTriageTimer({ repo, cardId: "DX-1", expiresAtMs, reconcile });

      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(true);
      expect(reconcile).not.toHaveBeenCalled();

      vi.advanceTimersByTime(59_999);
      expect(reconcile).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(repo, "DX-1", "audit");
      // Timer self-clears on fire.
      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(false);
    });

    it("clears the prior timer when re-armed for the same (repo, card)", () => {
      armTriageTimer({
        repo,
        cardId: "DX-1",
        expiresAtMs: Date.now() + 60_000,
        reconcile,
      });
      const firstExpiry = _getTriageTimerExpiresAt("danxbot", "DX-1");

      const laterExpiry = Date.now() + 120_000;
      armTriageTimer({
        repo,
        cardId: "DX-1",
        expiresAtMs: laterExpiry,
        reconcile,
      });

      expect(_getTriageTimerExpiresAt("danxbot", "DX-1")).toBe(laterExpiry);
      expect(firstExpiry).not.toBe(laterExpiry);

      // Only the second timer should fire — even at the first timer's
      // would-be expiry, reconcile is not called.
      vi.advanceTimersByTime(70_000);
      expect(reconcile).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it("past-due expiresAt fires on the next macrotask (clamped to 0 delay)", async () => {
      const pastExpiry = Date.now() - 60_000;
      armTriageTimer({
        repo,
        cardId: "DX-2",
        expiresAtMs: pastExpiry,
        reconcile,
      });

      expect(reconcile).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(repo, "DX-2", "audit");
    });

    it("swallows a rejecting reconcile so the timer fire does not crash the event loop", async () => {
      const boom = vi
        .fn<ReconcileFn>()
        .mockRejectedValue(new Error("reconcile boom"));
      armTriageTimer({
        repo,
        cardId: "DX-3",
        expiresAtMs: 0,
        reconcile: boom,
      });

      vi.advanceTimersByTime(0);
      // Flush the microtask queue so the rejection's catch fires.
      await Promise.resolve();
      await Promise.resolve();

      expect(boom).toHaveBeenCalledTimes(1);
      expect(_isTriageTimerArmed("danxbot", "DX-3")).toBe(false);
    });
  });

  describe("clearTriageTimer", () => {
    it("clears an armed timer so reconcile never fires", () => {
      armTriageTimer({
        repo,
        cardId: "DX-1",
        expiresAtMs: Date.now() + 60_000,
        reconcile,
      });
      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(true);

      clearTriageTimer("danxbot", "DX-1");
      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(false);

      vi.advanceTimersByTime(120_000);
      expect(reconcile).not.toHaveBeenCalled();
    });

    it("is idempotent — clearing a non-armed key does not throw", () => {
      expect(() => clearTriageTimer("danxbot", "DX-999")).not.toThrow();
    });
  });

  describe("scanAndArmTriageTimers (boot-scan re-arm)", () => {
    function writeIssue(cardId: string, expiresAt: string): void {
      const issue = {
        ...createEmptyIssue({
          id: cardId,
          status: "Review",
          title: `Card ${cardId}`,
        }),
        triage: {
          expires_at: expiresAt,
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
      };
      const path = join(
        tempDir,
        ".danxbot",
        "issues",
        "open",
        `${cardId}.yml`,
      );
      writeFileSync(path, serializeIssue(issue));
    }

    it("arms a timer for every open YAML with a future expires_at", () => {
      const future1 = new Date(Date.now() + 60_000).toISOString();
      const future2 = new Date(Date.now() + 120_000).toISOString();
      writeIssue("DX-1", future1);
      writeIssue("DX-2", future2);

      scanAndArmTriageTimers({ repo, reconcile });

      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(true);
      expect(_isTriageTimerArmed("danxbot", "DX-2")).toBe(true);
      expect(_getTriageTimerExpiresAt("danxbot", "DX-1")).toBe(
        Date.parse(future1),
      );
      expect(_getTriageTimerExpiresAt("danxbot", "DX-2")).toBe(
        Date.parse(future2),
      );
    });

    it("arms an immediate-fire timer when expires_at is empty (never triaged)", () => {
      writeIssue("DX-3", "");

      scanAndArmTriageTimers({ repo, reconcile });

      expect(_isTriageTimerArmed("danxbot", "DX-3")).toBe(true);
      expect(_getTriageTimerExpiresAt("danxbot", "DX-3")).toBe(0);

      vi.advanceTimersByTime(0);
      expect(reconcile).toHaveBeenCalledWith(repo, "DX-3", "audit");
    });

    it("arms an immediate-fire timer when expires_at is unparseable", () => {
      writeIssue("DX-4", "not-a-date");

      scanAndArmTriageTimers({ repo, reconcile });

      expect(_isTriageTimerArmed("danxbot", "DX-4")).toBe(true);
      expect(_getTriageTimerExpiresAt("danxbot", "DX-4")).toBe(0);
    });

    it("arms an immediate-fire timer when expires_at is in the past", () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      writeIssue("DX-5", past);

      scanAndArmTriageTimers({ repo, reconcile });

      expect(_isTriageTimerArmed("danxbot", "DX-5")).toBe(true);
      vi.advanceTimersByTime(0);
      expect(reconcile).toHaveBeenCalledWith(repo, "DX-5", "audit");
    });

    it("skips a malformed YAML and continues the scan", () => {
      writeFileSync(
        join(tempDir, ".danxbot", "issues", "open", "DX-99.yml"),
        "not: [valid: yaml: at all",
      );
      writeIssue("DX-1", new Date(Date.now() + 60_000).toISOString());

      expect(() => scanAndArmTriageTimers({ repo, reconcile })).not.toThrow();
      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(true);
      expect(_isTriageTimerArmed("danxbot", "DX-99")).toBe(false);
    });

    it("no-op when open/ does not exist", () => {
      rmSync(join(tempDir, ".danxbot"), { recursive: true });
      expect(() => scanAndArmTriageTimers({ repo, reconcile })).not.toThrow();
    });
  });

  describe("_clearAllTriageTimers (test seam)", () => {
    it("drains every armed timer", () => {
      armTriageTimer({
        repo,
        cardId: "DX-1",
        expiresAtMs: Date.now() + 60_000,
        reconcile,
      });
      armTriageTimer({
        repo,
        cardId: "DX-2",
        expiresAtMs: Date.now() + 60_000,
        reconcile,
      });

      _clearAllTriageTimers();

      expect(_isTriageTimerArmed("danxbot", "DX-1")).toBe(false);
      expect(_isTriageTimerArmed("danxbot", "DX-2")).toBe(false);
    });
  });
});
