import { describe, it, expect, beforeEach, vi } from "vitest";

const mockInsertRestart = vi.fn();
const mockCompleteRestart = vi.fn().mockResolvedValue(undefined);
const mockGetLatestSuccessfulRestart = vi.fn();

vi.mock("./worker-restarts-db.js", () => ({
  insertRestart: (...args: unknown[]) => mockInsertRestart(...args),
  completeRestart: (...args: unknown[]) => mockCompleteRestart(...args),
  getLatestSuccessfulRestart: (...args: unknown[]) =>
    mockGetLatestSuccessfulRestart(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  restartWorker,
  parseRestartRequest,
  pollHealth,
  seedCooldownFromDb,
  getCooldown,
  setCooldown,
  _resetCooldownForTests,
  DEFAULT_COOLDOWN_MS,
  type RestartDeps,
  type RestartRequest,
} from "./restart.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

const REPO = makeRepoContext({ name: "danxbot", workerPort: 5562 });

function makeDeps(overrides: Partial<RestartDeps> = {}): RestartDeps {
  return {
    spawnFinalizer: vi.fn(),
    killSelf: vi.fn(),
    now: () => 1_700_000_000_000,
    resolveOldPid: () => 12345,
    runtime: "host",
    cooldownMs: DEFAULT_COOLDOWN_MS,
    ...overrides,
  };
}

function makeReq(overrides: Partial<RestartRequest> = {}): RestartRequest {
  return {
    requestingDispatchId: "d-1",
    repo: "danxbot",
    reason: "manual operator restart",
    ...overrides,
  };
}

describe("parseRestartRequest", () => {
  it("rejects missing repo", () => {
    const out = parseRestartRequest({ reason: "x" });
    expect(out).toEqual({
      ok: false,
      status: 400,
      error: expect.stringContaining("repo"),
    });
  });

  it("rejects empty repo", () => {
    const out = parseRestartRequest({ repo: "  ", reason: "x" });
    expect(out.ok).toBe(false);
  });

  it("rejects missing reason", () => {
    const out = parseRestartRequest({ repo: "danxbot" });
    expect(out).toEqual({
      ok: false,
      status: 400,
      error: expect.stringContaining("reason"),
    });
  });

  it("accepts valid body — does NOT read requestingDispatchId (route owns it)", () => {
    const out = parseRestartRequest({
      repo: "danxbot",
      reason: "x",
      requestingDispatchId: "d-from-body-ignored",
      timeoutMs: 30_000,
      drainInFlight: true,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.repo).toBe("danxbot");
      expect(out.value.reason).toBe("x");
      // requestingDispatchId is NOT in the parsed value — the route
      // injects it from the URL path.
      expect("requestingDispatchId" in out.value).toBe(false);
      expect(out.value.timeoutMs).toBe(30_000);
      expect(out.value.drainInFlight).toBe(true);
    }
  });

  it("ignores non-positive timeoutMs", () => {
    const out = parseRestartRequest({
      repo: "r",
      reason: "x",
      timeoutMs: -5,
    });
    if (out.ok) expect(out.value.timeoutMs).toBeUndefined();
  });
});

describe("restartWorker — guards", () => {
  beforeEach(() => {
    _resetCooldownForTests();
    mockInsertRestart.mockReset();
    mockInsertRestart.mockResolvedValue(101);
    mockGetLatestSuccessfulRestart.mockReset();
  });

  it("cross-repo → 403, audit cross_repo, no spawn, no kill", async () => {
    const deps = makeDeps();
    const out = await restartWorker(
      makeReq({ repo: "other-repo" }),
      REPO,
      deps,
    );
    expect(out.accepted).toBe(false);
    expect(out.status).toBe(403);
    expect(mockInsertRestart).toHaveBeenCalledTimes(1);
    expect(mockInsertRestart.mock.calls[0][0].outcome).toBe("cross_repo");
    expect(deps.spawnFinalizer).not.toHaveBeenCalled();
    expect(deps.killSelf).not.toHaveBeenCalled();
  });

  it("docker self-restart → 409, audit docker_self", async () => {
    const deps = makeDeps({ runtime: "docker" });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(false);
    expect(out.status).toBe(409);
    expect(mockInsertRestart.mock.calls[0][0].outcome).toBe("docker_self");
    expect(deps.spawnFinalizer).not.toHaveBeenCalled();
  });

  it("cooldown within window → 429, audit cooldown", async () => {
    const now = 1_700_000_000_000;
    setCooldown("danxbot", now - 5_000);
    const deps = makeDeps({ now: () => now });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(false);
    expect(out.status).toBe(429);
    expect(mockInsertRestart.mock.calls[0][0].outcome).toBe("cooldown");
    expect(deps.spawnFinalizer).not.toHaveBeenCalled();
  });

  it("cooldown elapsed → accepts", async () => {
    const now = 1_700_000_000_000;
    setCooldown("danxbot", now - DEFAULT_COOLDOWN_MS - 1);
    const deps = makeDeps({ now: () => now });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(true);
  });

  it("happy path: writes audit, spawns finalizer, returns postFlush, does NOT kill until flushed", async () => {
    const deps = makeDeps();
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({
      started: true,
      oldPid: 12345,
      restartId: 101,
      outcome: "started",
    });
    expect(deps.spawnFinalizer).toHaveBeenCalledTimes(1);
    const spawnArg = (deps.spawnFinalizer as unknown as {
      mock: { calls: [{ restartId: number; port: number }][] };
    }).mock.calls[0][0];
    expect(spawnArg.restartId).toBe(101);
    expect(spawnArg.port).toBe(5562);
    // killSelf NOT yet called — caller must invoke postFlush
    expect(deps.killSelf).not.toHaveBeenCalled();

    out.postFlush();
    expect(deps.killSelf).toHaveBeenCalledTimes(1);
  });

  it("happy path: stamps cooldown so immediate retry hits 429", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({ now: () => now });
    const first = await restartWorker(makeReq(), REPO, deps);
    expect(first.accepted).toBe(true);
    expect(getCooldown("danxbot")).toBe(now);

    const second = await restartWorker(makeReq(), REPO, deps);
    expect(second.accepted).toBe(false);
    expect(second.status).toBe(429);
  });

  it("audit row captures dispatch id + repo + reason + old_pid", async () => {
    const deps = makeDeps({ resolveOldPid: () => 999 });
    await restartWorker(
      makeReq({ requestingDispatchId: "d-42", reason: "forced reload" }),
      REPO,
      deps,
    );
    expect(mockInsertRestart.mock.calls[0][0]).toMatchObject({
      requestingDispatchId: "d-42",
      repo: "danxbot",
      reason: "forced reload",
      outcome: "started",
      oldPid: 999,
      startedAt: 1_700_000_000_000,
    });
  });

  it("spawnFinalizer throw → 500 spawn_failed, no kill, marks the started row as spawn_failed", async () => {
    mockCompleteRestart.mockClear();
    const deps = makeDeps({
      spawnFinalizer: vi.fn(() => {
        throw new Error("ENOENT make");
      }),
    });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(false);
    expect(out.status).toBe(500);
    expect(deps.killSelf).not.toHaveBeenCalled();
    // Initial audit row inserted as "started"…
    expect(mockInsertRestart).toHaveBeenCalledTimes(1);
    expect(mockInsertRestart.mock.calls[0][0].outcome).toBe("started");
    // …then transitioned to "spawn_failed" via completeRestart so the
    // audit log doesn't lie about which restarts actually succeeded.
    expect(mockCompleteRestart).toHaveBeenCalledTimes(1);
    expect(mockCompleteRestart.mock.calls[0][0]).toMatchObject({
      outcome: "spawn_failed",
      newPid: null,
    });
  });

  it("resolveOldPid returning null lands null in audit row + body", async () => {
    const deps = makeDeps({ resolveOldPid: () => null });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(true);
    if (!out.accepted) return;
    expect(out.body.oldPid).toBeNull();
    expect(mockInsertRestart.mock.calls[0][0].oldPid).toBeNull();
  });
});

describe("seedCooldownFromDb", () => {
  beforeEach(() => {
    _resetCooldownForTests();
    mockGetLatestSuccessfulRestart.mockReset();
  });

  it("seeds cooldown from latest success row", async () => {
    const completedAt = new Date("2026-05-05T00:00:00Z");
    mockGetLatestSuccessfulRestart.mockResolvedValueOnce({
      completed_at: completedAt,
    });
    await seedCooldownFromDb("danxbot");
    expect(getCooldown("danxbot")).toBe(completedAt.getTime());
  });

  it("no row → no seed", async () => {
    mockGetLatestSuccessfulRestart.mockResolvedValueOnce(null);
    await seedCooldownFromDb("danxbot");
    expect(getCooldown("danxbot")).toBeNull();
  });

  it("seed → restartWorker call within window → 429 (end-to-end)", async () => {
    mockInsertRestart.mockReset();
    mockInsertRestart.mockResolvedValue(123);
    const completedAt = new Date(1_700_000_000_000);
    mockGetLatestSuccessfulRestart.mockResolvedValueOnce({ completed_at: completedAt });
    await seedCooldownFromDb("danxbot");
    const deps = makeDeps({ now: () => 1_700_000_010_000 });
    const out = await restartWorker(makeReq(), REPO, deps);
    expect(out.accepted).toBe(false);
    expect(out.status).toBe(429);
    expect(mockInsertRestart.mock.calls[0][0].outcome).toBe("cooldown");
  });

  it("row missing completed_at → no seed", async () => {
    mockGetLatestSuccessfulRestart.mockResolvedValueOnce({
      completed_at: null,
    });
    await seedCooldownFromDb("danxbot");
    expect(getCooldown("danxbot")).toBeNull();
  });
});

describe("pollHealth", () => {
  it("returns true on first 200", async () => {
    const now = vi.fn().mockReturnValue(0);
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ok = await pollHealth(5562, 10_000, { fetch, now, sleep }, 100);
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns false when deadline expires before 200", async () => {
    const times = [0, 0, 100, 100, 200, 200, 300, 300];
    let i = 0;
    const now = vi.fn(() => times[i++] ?? 9999);
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ok = await pollHealth(5562, 250, { fetch, now, sleep }, 50);
    expect(ok).toBe(false);
  });

  it("retries through ECONNREFUSED until 200 lands", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200 };
    });
    const now = vi.fn().mockReturnValue(0);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ok = await pollHealth(5562, 10_000, { fetch, now, sleep }, 50);
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("treats non-ok response as not-yet-up", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    });
    const now = vi.fn().mockReturnValue(0);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ok = await pollHealth(5562, 10_000, { fetch, now, sleep }, 50);
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
