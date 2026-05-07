import { describe, expect, it } from "vitest";
import {
  checkYamlDispatchLiveness,
  TTL_SECONDS_BY_KIND,
} from "./dispatch-liveness-yaml.js";
import type { IssueDispatch } from "../issue-tracker/interface.js";

const HOST = "danxbot-host-a";
const NOW = Date.parse("2026-05-07T12:00:00.000Z");

function makeDispatch(overrides: Partial<IssueDispatch> = {}): IssueDispatch {
  return {
    id: "did-1",
    pid: 1234,
    host: HOST,
    kind: "work",
    started_at: new Date(NOW - 60_000).toISOString(),
    ttl_seconds: 7200,
    ...overrides,
  };
}

describe("checkYamlDispatchLiveness", () => {
  it("returns alive for same-host PID still in the kernel and TTL not expired", () => {
    const verdict = checkYamlDispatchLiveness(makeDispatch(), {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => true,
    });
    expect(verdict).toEqual({ kind: "alive" });
  });

  it("returns dead-pid when same host but PID has been reaped", () => {
    const verdict = checkYamlDispatchLiveness(makeDispatch({ pid: 4567 }), {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => false,
    });
    expect(verdict).toEqual({ kind: "dead-pid" });
  });

  it("returns dead-pid for sentinel pid 0 even when isPidAlive would return true", () => {
    // Phase 1 stamped pid: 0 as a placeholder. Reattach must clear those
    // entries, NOT report them as alive — `process.kill(0, 0)` would
    // target the current process group and falsely succeed.
    const verdict = checkYamlDispatchLiveness(makeDispatch({ pid: 0 }), {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => true,
    });
    expect(verdict).toEqual({ kind: "dead-pid" });
  });

  it("returns dead-pid for negative pid", () => {
    const verdict = checkYamlDispatchLiveness(makeDispatch({ pid: -5 }), {
      currentHost: HOST,
      now: NOW,
      isPidAlive: () => true,
    });
    expect(verdict).toEqual({ kind: "dead-pid" });
  });

  it("returns dead-ttl when started_at + ttl < now, regardless of PID liveness", () => {
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({
        started_at: new Date(NOW - 8000 * 1000).toISOString(),
        ttl_seconds: 7200,
      }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "dead-ttl" });
  });

  it("returns cross-host when dispatch.host doesn't match currentHost", () => {
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({ host: "other-host" }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "cross-host" });
  });

  it("returns cross-host when dispatch.host is empty (Phase 1 migrated stamp)", () => {
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({ host: "", pid: 0 }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "cross-host" });
  });

  it("treats started_at empty + ttl_seconds 0 as no-TTL (falls through to PID check)", () => {
    // Phase 1 placeholder shape. Liveness here decides on PID alone; TTL
    // is unknown because there's no started_at to anchor it.
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({ started_at: "", ttl_seconds: 0 }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "alive" });
  });

  it("treats malformed started_at as no-TTL (falls through to PID check)", () => {
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({ started_at: "not a date", ttl_seconds: 60 }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "alive" });
  });

  it("cross-host check shadows TTL — cross-host wins even when PID is dead and TTL is fresh", () => {
    // The reattach pass should clear cross-host entries with a single
    // verdict regardless of remote PID/TTL state — local-only deploys
    // can't probe a remote process, so reporting dead-pid would falsely
    // imply we know the remote.
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({ host: "other-host", pid: 0, started_at: "", ttl_seconds: 0 }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => false,
      },
    );
    expect(verdict).toEqual({ kind: "cross-host" });
  });

  it("TTL check shadows PID — expired TTL with a live PID returns dead-ttl, not alive", () => {
    const verdict = checkYamlDispatchLiveness(
      makeDispatch({
        started_at: new Date(NOW - 8000 * 1000).toISOString(),
        ttl_seconds: 7200,
        pid: 99999,
      }),
      {
        currentHost: HOST,
        now: NOW,
        isPidAlive: () => true,
      },
    );
    expect(verdict).toEqual({ kind: "dead-ttl" });
  });
});

describe("TTL_SECONDS_BY_KIND", () => {
  it("work TTL is 2 hours (matches AgentDispatch::MAX_RUNTIME_SECONDS)", () => {
    expect(TTL_SECONDS_BY_KIND.work).toBe(7200);
  });

  it("triage TTL is 10 minutes", () => {
    expect(TTL_SECONDS_BY_KIND.triage).toBe(600);
  });
});
