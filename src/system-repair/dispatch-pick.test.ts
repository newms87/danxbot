/**
 * DX-650 — worker-fault category whitelist (Phase 1 foundation for
 * Self-Repair rebuild epic DX-580). The whitelist gates which
 * `system_errors` rows can fire an agent repair dispatch. Wrong-side
 * categories would re-create the DX-560 loop class by firing repair
 * dispatches against agent-domain rows.
 *
 * One `it` per category — no batch loop. The pin is the load-bearing
 * safety wall; reviewers should see each category individually.
 */
import { describe, it, expect } from "vitest";
import {
  WORKER_FAULT_CATEGORY_PREFIXES,
  isWorkerFaultCategory,
} from "./dispatch-pick.js";

describe("WORKER_FAULT_CATEGORY_PREFIXES", () => {
  it("pins exact membership (size + every allowed prefix) — guards silent additions to the safety wall", () => {
    expect(WORKER_FAULT_CATEGORY_PREFIXES.size).toBe(7);
    for (const prefix of [
      "worker-boot",
      "dispatch-spawn",
      "mcp-load",
      "claude-auth",
      "cron-job",
      "dashboard-route",
      "reconcile-internal",
    ]) {
      expect(WORKER_FAULT_CATEGORY_PREFIXES.has(prefix)).toBe(true);
    }
  });
});

describe("isWorkerFaultCategory — allowed prefixes return true", () => {
  it("worker-boot:* (worker process failed to boot)", () => {
    expect(isWorkerFaultCategory("worker-boot:port-in-use")).toBe(true);
  });

  it("dispatch-spawn:* (spawnAgent threw before claude PID landed)", () => {
    expect(isWorkerFaultCategory("dispatch-spawn:eacces")).toBe(true);
  });

  it("mcp-load:* (workspace MCP server failed to load)", () => {
    expect(isWorkerFaultCategory("mcp-load:trello-timeout")).toBe(true);
  });

  it("claude-auth:* (silent dispatch — no JSONL ever appeared)", () => {
    expect(isWorkerFaultCategory("claude-auth:credentials-missing")).toBe(true);
  });

  it("cron-job:* (a cron job in src/cron/jobs threw)", () => {
    expect(isWorkerFaultCategory("cron-job:reap-orphan-dispatches")).toBe(true);
  });

  it("dashboard-route:* (a dashboard route handler threw uncaught)", () => {
    expect(isWorkerFaultCategory("dashboard-route:issues-patch")).toBe(true);
  });

  it("reconcile-internal:* (reconcile.ts step threw NOT from agent YAML data)", () => {
    expect(isWorkerFaultCategory("reconcile-internal:trello-push")).toBe(true);
  });
});

describe("isWorkerFaultCategory — forbidden agent-domain prefixes return false", () => {
  it("audit-pass:* (agent-domain — never triggers worker repair)", () => {
    expect(isWorkerFaultCategory("audit-pass:ReconcileValidationError")).toBe(
      false,
    );
  });

  it("orphan-ip-heal:* (agent-domain)", () => {
    expect(isWorkerFaultCategory("orphan-ip-heal:stale-dispatch")).toBe(false);
  });

  it("invariant-heal:* (agent-domain)", () => {
    expect(isWorkerFaultCategory("invariant-heal:duplicate-parent")).toBe(
      false,
    );
  });

  it("audit-drift (exact-match, no colon — agent-domain)", () => {
    expect(isWorkerFaultCategory("audit-drift")).toBe(false);
  });

  it("reconcile-validation:* (agent YAML data — not a worker fault)", () => {
    expect(isWorkerFaultCategory("reconcile-validation:bad-status")).toBe(
      false,
    );
  });
});

describe("isWorkerFaultCategory — unknown categories default-deny", () => {
  it("unknown prefix returns false", () => {
    expect(isWorkerFaultCategory("random-thing:foo")).toBe(false);
  });

  it("empty string returns false", () => {
    expect(isWorkerFaultCategory("")).toBe(false);
  });

  it("bare prefix without colon (not in exact-match set) returns false", () => {
    expect(isWorkerFaultCategory("worker-boot")).toBe(false);
  });

  it("prefix that is a substring of allowed but distinct returns false", () => {
    expect(isWorkerFaultCategory("worker-boots:fake")).toBe(false);
  });

  it("trailing colon with empty subcategory returns true (prefix matched, sub-key absent)", () => {
    expect(isWorkerFaultCategory("worker-boot:")).toBe(true);
  });

  it("leading colon defends against empty-prefix wildcard match", () => {
    expect(isWorkerFaultCategory(":worker-boot")).toBe(false);
  });
});
