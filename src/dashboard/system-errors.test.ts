/**
 * DX-134 Phase 4 — backend tests for the system-errors ring buffer +
 * REST endpoint + EventBus topic.
 *
 * Frontend (banner SFC, composable) is exempt from tests per the
 * `UI Frontend Test Exemption` rule in `CLAUDE.md`. Type-check still
 * required.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createServer } from "http";
import { AddressInfo } from "net";
import {
  recordSystemError,
  listSystemErrors,
  _clearSystemErrors,
  SYSTEM_ERRORS_CAPACITY,
  type SystemError,
} from "./system-errors.js";
import { eventBus } from "./event-bus.js";
import { handleListSystemErrors } from "./system-errors-routes.js";

beforeEach(() => {
  _clearSystemErrors();
  eventBus._clear();
});

// ─── Test 1: ring buffer capacity + FIFO eviction ────────────────────────────

describe("recordSystemError — ring buffer", () => {
  it("caps the buffer at SYSTEM_ERRORS_CAPACITY (FIFO eviction)", () => {
    expect(SYSTEM_ERRORS_CAPACITY).toBe(200);

    // Push CAPACITY + 5 events; the oldest 5 should be evicted.
    for (let i = 0; i < SYSTEM_ERRORS_CAPACITY + 5; i++) {
      recordSystemError({
        source: "tracker",
        repo: "danxbot",
        message: `event ${i}`,
      });
    }

    const all = listSystemErrors({ limit: 1000 });
    expect(all).toHaveLength(SYSTEM_ERRORS_CAPACITY);

    // Newest first → first message in the result is the LAST one pushed.
    expect(all[0].message).toBe(`event ${SYSTEM_ERRORS_CAPACITY + 4}`);
    // Last message is the OLDEST surviving entry — index 5 (events 0..4 evicted).
    expect(all[all.length - 1].message).toBe("event 5");
    // Events 0..4 are gone.
    expect(all.find((e) => e.message === "event 0")).toBeUndefined();
    expect(all.find((e) => e.message === "event 4")).toBeUndefined();
  });

  it("assigns a fresh uuid + ISO timestamp + default severity 'error'", () => {
    const event = recordSystemError({
      source: "healer",
      repo: "danxbot",
      message: "stale yaml",
    });

    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(event.severity).toBe("error");
    expect(event.source).toBe("healer");
    expect(event.repo).toBe("danxbot");
    expect(event.message).toBe("stale yaml");
  });

  it("explicit severity 'warn' is preserved", () => {
    const event = recordSystemError({
      source: "healer",
      severity: "warn",
      repo: "danxbot",
      message: "soft warning",
    });
    expect(event.severity).toBe("warn");
  });

  it("details payload round-trips on the stored event", () => {
    const event = recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "401",
      details: { url: "https://api.trello.com/1/cards", attempt: 3 },
    });
    expect(event.details).toEqual({
      url: "https://api.trello.com/1/cards",
      attempt: 3,
    });
  });
});

// ─── Test 2: SSE producer — every record publishes a `system-errors` event ───

describe("recordSystemError — EventBus producer", () => {
  it("publishes a `system-errors` topic event matching the stored row", () => {
    const cb = vi.fn();
    eventBus.subscribe("system-errors", cb);

    const stored = recordSystemError({
      source: "retry-queue",
      severity: "error",
      repo: "danxbot",
      message: "max attempts exceeded",
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ topic: "system-errors", data: stored });
  });

  it("does NOT publish to other topics", () => {
    const otherCb = vi.fn();
    eventBus.subscribe("dispatch:created", otherCb);
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "noise",
    });
    expect(otherCb).not.toHaveBeenCalled();
  });

  it("subscriber added AFTER recording sees only future events (no replay)", () => {
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "before",
    });

    const cb = vi.fn();
    eventBus.subscribe("system-errors", cb);
    expect(cb).not.toHaveBeenCalled();

    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "after",
    });
    expect(cb).toHaveBeenCalledTimes(1);
    const evt = cb.mock.calls[0][0] as {
      topic: string;
      data: SystemError;
    };
    expect(evt.data.message).toBe("after");
  });
});

// ─── Test 3: REST endpoint returns newest-first + respects limit ─────────────

describe("GET /api/system-errors — REST endpoint", () => {
  async function withServer<T>(
    fn: (port: number) => Promise<T>,
  ): Promise<T> {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost/");
      if (url.pathname === "/api/system-errors") {
        handleListSystemErrors(res, url.searchParams);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      return await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("returns events newest-first (matching the buffer order reversed)", async () => {
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "first",
    });
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "second",
    });
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "third",
    });

    await withServer(async (port) => {
      const res = await fetch(`http://localhost:${port}/api/system-errors`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events.map((e) => e.message)).toEqual([
        "third",
        "second",
        "first",
      ]);
    });
  });

  it("respects the `limit` query parameter", async () => {
    for (let i = 0; i < 10; i++) {
      recordSystemError({
        source: "tracker",
        repo: "danxbot",
        message: `m${i}`,
      });
    }

    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?limit=3`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events).toHaveLength(3);
      expect(body.events.map((e) => e.message)).toEqual(["m9", "m8", "m7"]);
    });
  });

  it("clamps absurd limits to the hard cap (200)", async () => {
    // Push CAPACITY events — the buffer auto-evicts oldest, so >200 is the
    // shape that exercises the cap. With CAPACITY entries on disk and
    // ?limit=99999, the response must be exactly the cap (200), proving
    // the route's MAX_LIMIT clamp fires (not just the buffer's natural
    // size).
    for (let i = 0; i < SYSTEM_ERRORS_CAPACITY + 50; i++) {
      recordSystemError({
        source: "tracker",
        repo: "danxbot",
        message: `m${i}`,
      });
    }
    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?limit=99999`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events).toHaveLength(SYSTEM_ERRORS_CAPACITY);
    });
  });

  it("?limit=-1 falls back to the default limit", async () => {
    for (let i = 0; i < 5; i++) {
      recordSystemError({
        source: "tracker",
        repo: "danxbot",
        message: `m${i}`,
      });
    }
    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?limit=-1`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      // Default limit (200) > 5 stored, so all 5 come back. Falling back
      // to default is the fail-open contract — never an error response.
      expect(body.events).toHaveLength(5);
    });
  });

  it("?limit=abc falls back to the default limit", async () => {
    for (let i = 0; i < 5; i++) {
      recordSystemError({
        source: "tracker",
        repo: "danxbot",
        message: `m${i}`,
      });
    }
    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?limit=abc`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events).toHaveLength(5);
    });
  });
});

// ─── Test 4: per-repo filter on REST endpoint ────────────────────────────────

describe("GET /api/system-errors — per-repo filter", () => {
  async function withServer<T>(
    fn: (port: number) => Promise<T>,
  ): Promise<T> {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost/");
      if (url.pathname === "/api/system-errors") {
        handleListSystemErrors(res, url.searchParams);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      return await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("returns ONLY events whose `repo` exactly matches `?repo=`", async () => {
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "danx-1",
    });
    recordSystemError({
      source: "tracker",
      repo: "platform",
      message: "plat-1",
    });
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "danx-2",
    });
    recordSystemError({
      source: "tracker",
      repo: "gpt-manager",
      message: "gpt-1",
    });

    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?repo=danxbot`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events.map((e) => e.message)).toEqual(["danx-2", "danx-1"]);
      expect(body.events.every((e) => e.repo === "danxbot")).toBe(true);
    });
  });

  it("an empty `repo=` query param is treated as no filter", async () => {
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "a",
    });
    recordSystemError({
      source: "tracker",
      repo: "platform",
      message: "b",
    });

    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?repo=`,
      );
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events).toHaveLength(2);
    });
  });

  it("an unknown repo name returns an empty list (not a 4xx)", async () => {
    recordSystemError({
      source: "tracker",
      repo: "danxbot",
      message: "x",
    });

    await withServer(async (port) => {
      const res = await fetch(
        `http://localhost:${port}/api/system-errors?repo=does-not-exist`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { events: SystemError[] };
      expect(body.events).toEqual([]);
    });
  });
});
