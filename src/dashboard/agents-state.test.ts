import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRes } from "../__tests__/helpers/http-mocks.js";
import { handleGetAgentRuntimeState, buildRuntimeState } from "./agents-state.js";
import { deps } from "./agents-test-fixtures.js";

/**
 * DX-684 — runtime-state endpoint.
 *
 * All three readers route through `runtimeVolumePath(repoName, ...)`
 * which honors the `DANX_RUNTIME_ROOT` env override. Tests point it at
 * a tmp dir per test so the fixtures isolate cleanly.
 */
describe("agents-state — GET /api/agents/:repo/state", () => {
  let tmpRoot: string;
  const repoName = "danxbot";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "danxbot-agents-state-"));
    process.env.DANX_RUNTIME_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, repoName), { recursive: true });
  });

  afterEach(() => {
    delete process.env.DANX_RUNTIME_ROOT;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeRuntime(basename: string, body: unknown): void {
    writeFileSync(
      join(tmpRoot, repoName, basename),
      typeof body === "string" ? body : JSON.stringify(body),
      "utf8",
    );
  }

  it("returns all-null shape when no runtime files exist", () => {
    const state = buildRuntimeState(repoName);
    expect(state).toEqual({
      critical_failure: null,
      sync_state: null,
      runtime_settings: null,
    });
  });

  it("surfaces a stamped CRITICAL_FAILURE", () => {
    writeRuntime("CRITICAL_FAILURE", {
      timestamp: "2026-05-18T12:00:00Z",
      source: "agent",
      dispatchId: "d-1",
      reason: "MCP tools missing",
    });
    const state = buildRuntimeState(repoName);
    expect(state.critical_failure).toMatchObject({
      source: "agent",
      dispatchId: "d-1",
      reason: "MCP tools missing",
    });
    expect(state.sync_state).toBeNull();
    expect(state.runtime_settings).toBeNull();
  });

  it("surfaces a stamped sync-root-state.json", () => {
    writeRuntime("sync-root-state.json", {
      reason: "dirty",
      detail: "working tree dirty: M src/foo.ts",
      since: "2026-05-18T11:00:00Z",
      lastTriedAt: "2026-05-18T11:00:00Z",
    });
    const state = buildRuntimeState(repoName);
    expect(state.sync_state).toMatchObject({
      reason: "dirty",
      detail: "working tree dirty: M src/foo.ts",
    });
  });

  it("surfaces a stamped settings-runtime.json (drift)", () => {
    writeRuntime("settings-runtime.json", {
      display: { worker: { repoName } },
      meta: { updatedAt: "2026-05-18T10:00:00Z", updatedBy: "worker" },
    });
    const state = buildRuntimeState(repoName);
    expect(state.runtime_settings).toEqual({
      display: { worker: { repoName } },
      meta: { updatedAt: "2026-05-18T10:00:00Z", updatedBy: "worker" },
    });
  });

  it("returns null for a malformed sync-root-state.json (degrades gracefully)", () => {
    writeRuntime("sync-root-state.json", "not json at all {");
    const state = buildRuntimeState(repoName);
    expect(state.sync_state).toBeNull();
  });

  it("returns null for a malformed settings-runtime.json (non-object payload)", () => {
    // The drift file must be `{display, meta}`. A scalar payload (or
    // any non-object) fails the `isDriftShape` predicate and the route
    // degrades to null rather than handing the SPA an `any`-grade
    // value. Symmetric with the sync_state malformed case.
    writeRuntime("settings-runtime.json", "42");
    const state = buildRuntimeState(repoName);
    expect(state.runtime_settings).toBeNull();
  });

  it("returns null for a settings-runtime.json missing required keys", () => {
    writeRuntime("settings-runtime.json", { display: {} });
    const state = buildRuntimeState(repoName);
    expect(state.runtime_settings).toBeNull();
  });

  it("returns the unparseable synthetic for a malformed CRITICAL_FAILURE (fail-CLOSED)", () => {
    // The dashboard MUST surface an unparseable flag — silently dropping
    // it would re-enable the poller's halt gate on the next read, which
    // is the exact bug critical-failure.ts exists to prevent.
    writeRuntime("CRITICAL_FAILURE", "{bad json");
    const state = buildRuntimeState(repoName);
    expect(state.critical_failure).not.toBeNull();
    expect(state.critical_failure?.source).toBe("unparseable");
  });

  it("HTTP handler returns 200 with the aggregated state", async () => {
    writeRuntime("CRITICAL_FAILURE", {
      timestamp: "2026-05-18T12:00:00Z",
      source: "agent",
      dispatchId: "d-1",
      reason: "MCP tools missing",
    });
    const res = createMockRes();
    await handleGetAgentRuntimeState(res, repoName, deps());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.critical_failure.reason).toBe("MCP tools missing");
    expect(body.sync_state).toBeNull();
    expect(body.runtime_settings).toBeNull();
  });

  it("HTTP handler returns 404 for unknown repo", async () => {
    const res = createMockRes();
    await handleGetAgentRuntimeState(res, "unknown", deps());
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toMatch(/not configured/);
  });
});
