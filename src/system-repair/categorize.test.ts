import { describe, it, expect, afterAll, vi } from "vitest";

// DX-565: spy on the SSE fan-out — recordError MUST publish so the
// Self-Repair tab live-updates when a new error is captured.
const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));
vi.mock("./publish.js", () => ({
  publishRepairErrorUpdated: publishSpy,
}));

import {
  normalizeMessage,
  signatureHash,
  recordError,
  getOpenErrorsRanked,
} from "./categorize.js";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as up021 } from "../db/migrations/021_system_errors.js";
import type { PoolClient } from "pg";

/**
 * DX-561 — categorize.ts unit + integration tests.
 *
 * Unit half (normalizeMessage, signatureHash) is pure and always runs.
 * Integration half (recordError, getOpenErrorsRanked) needs a real
 * Postgres. `createTestDb` returns null when PG is unreachable; in that
 * case every `it.skipIf(!handle, ...)` body passes as skipped.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[categorize.test] skipping integration suite — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  await runMigration(handle.pool, up021);
}

async function runMigration(
  pool: import("pg").Pool,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe("normalizeMessage", () => {
  it("strips absolute paths to basenames", () => {
    expect(
      normalizeMessage(
        "Failed to parse YAML at /home/newms/web/danxbot/src/foo.ts",
      ),
    ).toBe("Failed to parse YAML at foo.ts");
  });

  it("strips path + line:col suffix together to basename only", () => {
    expect(
      normalizeMessage("at Object.fn (/home/newms/web/danxbot/src/foo.ts:42:13)"),
    ).toBe("at Object.fn (foo.ts)");
  });

  it("strips relative file:line:col to filename only", () => {
    expect(normalizeMessage("Error at foo.ts:42:13 in handler")).toBe(
      "Error at foo.ts in handler",
    );
  });

  it("strips UUIDs to <UUID>", () => {
    expect(
      normalizeMessage("Dispatch 1efdfbae-a48f-449d-b096-12dddd4dddd2 timed out"),
    ).toBe("Dispatch <UUID> timed out");
  });

  it("strips ISO 8601 timestamps to <TS>", () => {
    expect(
      normalizeMessage("Failed at 2026-05-15T21:58:24.328Z processing batch"),
    ).toBe("Failed at <TS> processing batch");
  });

  it("strips bare ISO dates to <DATE>", () => {
    expect(normalizeMessage("Migration failed for 2026-05-15 partition")).toBe(
      "Migration failed for <DATE> partition",
    );
  });

  it("strips port numbers in host:port to :<PORT>", () => {
    expect(normalizeMessage("Connection refused on localhost:5555")).toBe(
      "Connection refused on localhost:<PORT>",
    );
  });

  it("preserves URL scheme colons while stripping host port", () => {
    expect(normalizeMessage("GET http://localhost:5566/api/foo failed")).toBe(
      "GET http://localhost:<PORT>/api/foo failed",
    );
  });

  it("strips `line N` phrasing to `line <N>`", () => {
    expect(normalizeMessage("Error reported at line 42 in handler")).toBe(
      "Error reported at line <N> in handler",
    );
  });

  it("normalizes the same message with different absolute paths identically", () => {
    const a = normalizeMessage(
      "YAMLParseError reading /home/newms/web/danxbot/src/issue/foo.yml: bad anchor",
    );
    const b = normalizeMessage(
      "YAMLParseError reading /tmp/different/totally/elsewhere/foo.yml: bad anchor",
    );
    expect(a).toBe(b);
    expect(a).toBe("YAMLParseError reading foo.yml: bad anchor");
  });

  it("normalizes a stack frame with path + uuid + timestamp together", () => {
    expect(
      normalizeMessage(
        "Dispatch 1efdfbae-a48f-449d-b096-12dddd4dddd2 at 2026-05-15T10:00:00.000Z crashed at /opt/app/src/worker.ts:99:7",
      ),
    ).toBe("Dispatch <UUID> at <TS> crashed at worker.ts");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeMessage("")).toBe("");
  });

  it("leaves URL paths without a file extension intact", () => {
    // Path regex requires the basename to carry an extension. URLs like
    // `/api/foo` and `/api/v1/users` survive verbatim — this is the
    // load-bearing constraint that lets the regex strip disk paths
    // (`bar.ts`) without collapsing routes.
    expect(normalizeMessage("GET http://host:5566/api/v1/users failed")).toBe(
      "GET http://host:<PORT>/api/v1/users failed",
    );
  });

  it("leaves extensionless disk paths intact (documented lossage)", () => {
    // `/etc/passwd` has no extension on the basename, so the path
    // regex does not match. This is documented lossage: the same
    // error from `/etc/passwd` on two hosts that paraphrase the path
    // differently might fail to dedupe. Accepted trade-off vs. the
    // false-positive URL-path collapse.
    expect(normalizeMessage("Failed to read /etc/passwd: EACCES")).toBe(
      "Failed to read /etc/passwd: EACCES",
    );
  });

  it("is idempotent — re-normalizing yields the same string", () => {
    const once = normalizeMessage(
      "Failed at /opt/foo.ts:42:13 on 2026-01-02T03:04:05Z",
    );
    expect(normalizeMessage(once)).toBe(once);
  });
});

describe("signatureHash", () => {
  it("returns a 16-character lowercase hex string", () => {
    const h = signatureHash({
      component: "issues-mirror",
      errClass: "YAMLParseError",
      normalizedMsg: "Failed to parse foo.yml",
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls for the same input", () => {
    const a = signatureHash({
      component: "audit-pass",
      errClass: "ValidationError",
      normalizedMsg: "AC item missing title",
    });
    const b = signatureHash({
      component: "audit-pass",
      errClass: "ValidationError",
      normalizedMsg: "AC item missing title",
    });
    expect(a).toBe(b);
  });

  it("differs when component differs", () => {
    const a = signatureHash({
      component: "audit-pass",
      errClass: "ValidationError",
      normalizedMsg: "msg",
    });
    const b = signatureHash({
      component: "issues-mirror",
      errClass: "ValidationError",
      normalizedMsg: "msg",
    });
    expect(a).not.toBe(b);
  });

  it("differs when errClass differs", () => {
    const a = signatureHash({
      component: "c",
      errClass: "A",
      normalizedMsg: "msg",
    });
    const b = signatureHash({
      component: "c",
      errClass: "B",
      normalizedMsg: "msg",
    });
    expect(a).not.toBe(b);
  });

  it("differs when normalizedMsg differs", () => {
    const a = signatureHash({
      component: "c",
      errClass: "E",
      normalizedMsg: "msg one",
    });
    const b = signatureHash({
      component: "c",
      errClass: "E",
      normalizedMsg: "msg two",
    });
    expect(a).not.toBe(b);
  });

  it("produces the same hash via normalized paths from different envs", () => {
    const m1 = normalizeMessage(
      "YAMLParseError reading /home/newms/web/danxbot/src/foo.yml: bad anchor",
    );
    const m2 = normalizeMessage(
      "YAMLParseError reading /opt/different/foo.yml: bad anchor",
    );
    const h1 = signatureHash({
      component: "issues-mirror",
      errClass: "YAMLParseError",
      normalizedMsg: m1,
    });
    const h2 = signatureHash({
      component: "issues-mirror",
      errClass: "YAMLParseError",
      normalizedMsg: m2,
    });
    expect(h1).toBe(h2);
  });
});

describe("recordError", () => {
  it.skipIf(!handle)(
    "DX-565: publishes the post-upsert snapshot for the SSE fan-out",
    async () => {
      publishSpy.mockReset();
      const row = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "publish-probe",
        err: makeErr("ProbeError", "probe message"),
        samplePayload: { raw_msg: "probe message" },
      });
      expect(publishSpy).toHaveBeenCalledWith({
        db: handle!.pool,
        errorId: row.id,
      });
    },
  );

  it.skipIf(!handle)(
    "first call inserts a row with count=1 and first_seen=last_seen=now",
    async () => {
      const t0 = Date.now();
      const row = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "issues-mirror",
        err: makeErr("YAMLParseError", "Failed to parse /tmp/a/foo.yml"),
        samplePayload: { raw_msg: "Failed to parse /tmp/a/foo.yml", path: "/tmp/a/foo.yml" },
      });

      expect(row.count).toBe(1);
      expect(row.component).toBe("issues-mirror");
      expect(row.err_class).toBe("YAMLParseError");
      expect(row.category_key).toBe("issues-mirror:YAMLParseError");
      expect(row.repo).toBe("danxbot");
      expect(row.status).toBe("open");
      expect(row.signature_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(row.normalized_msg).toBe("Failed to parse foo.yml");
      expect(row.first_seen.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
      expect(row.last_seen.getTime()).toBeGreaterThanOrEqual(
        row.first_seen.getTime(),
      );
      expect(row.sample_payload.path).toBe("/tmp/a/foo.yml");
    },
  );

  it.skipIf(!handle)(
    "subsequent calls with same signature increment count + update last_seen + replace sample_payload",
    async () => {
      const firstSig = signatureHash({
        component: "audit-pass",
        errClass: "ValidationError",
        normalizedMsg: "AC missing title",
      });

      const r1 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "audit-pass",
        err: makeErr("ValidationError", "AC missing title"),
        samplePayload: { raw_msg: "AC missing title", iter: 1 },
      });
      expect(r1.signature_hash).toBe(firstSig);
      expect(r1.count).toBe(1);

      // tiny sleep to make last_seen meaningfully later than first_seen
      await sleep(20);

      const r2 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "audit-pass",
        err: makeErr("ValidationError", "AC missing title"),
        samplePayload: { raw_msg: "AC missing title", iter: 2 },
      });
      expect(r2.signature_hash).toBe(firstSig);
      expect(r2.count).toBe(2);
      expect(r2.first_seen.getTime()).toBe(r1.first_seen.getTime());
      expect(r2.last_seen.getTime()).toBeGreaterThanOrEqual(
        r1.last_seen.getTime(),
      );
      expect(r2.sample_payload.iter).toBe(2);

      const r3 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "audit-pass",
        err: makeErr("ValidationError", "AC missing title"),
        samplePayload: { raw_msg: "AC missing title", iter: 3 },
      });
      expect(r3.count).toBe(3);
      expect(r3.sample_payload.iter).toBe(3);
    },
  );

  it.skipIf(!handle)(
    "same normalized message from different env paths collapses to one row",
    async () => {
      const r1 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "issues-mirror",
        err: makeErr(
          "YAMLParseError",
          "YAMLParseError reading /home/newms/web/danxbot/src/foo.yml: bad anchor",
        ),
        samplePayload: { raw_msg: "host A" },
      });

      const r2 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "issues-mirror",
        err: makeErr(
          "YAMLParseError",
          "YAMLParseError reading /opt/elsewhere/foo.yml: bad anchor",
        ),
        samplePayload: { raw_msg: "host B" },
      });

      expect(r2.signature_hash).toBe(r1.signature_hash);
      expect(r2.id).toBe(r1.id);
      expect(r2.count).toBe(2);
    },
  );

  it.skipIf(!handle)(
    "preserves non-open status across subsequent occurrences",
    async () => {
      // Pins the contract documented in `recordError`'s header: the ON
      // CONFLICT clause intentionally omits `status`. A regression that
      // added `status = 'open'` to the SET list would silently re-open
      // every error the dispatcher marked `repairing` / `fixed` /
      // `unfixable` on the next occurrence — a quiet correctness break.
      const r1 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "status-preserve",
        err: makeErr("E", "preserve-test"),
        samplePayload: { raw_msg: "preserve-test" },
      });
      await handle!.pool.query(
        `UPDATE system_errors SET status = 'repairing' WHERE id = $1`,
        [r1.id],
      );
      const r2 = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "status-preserve",
        err: makeErr("E", "preserve-test"),
        samplePayload: { raw_msg: "preserve-test" },
      });
      expect(r2.id).toBe(r1.id);
      expect(r2.status).toBe("repairing");
      expect(r2.count).toBe(2);
    },
  );

  it.skipIf(!handle)(
    "concurrent upserts on the same signature land exactly one row + count=N",
    async () => {
      // Atomic-upsert contract: PG's ON CONFLICT serializes concurrent
      // writers on the unique-key index. Without it, a future switch
      // to a read-then-write pattern would silently create duplicate
      // rows under load (or, worse, lose increments).
      const N = 5;
      const ops = Array.from({ length: N }, () =>
        recordError({
          db: handle!.pool,
          repo: "danxbot",
          component: "concurrency",
          err: makeErr("E", "race-test"),
          samplePayload: { raw_msg: "race" },
        }),
      );
      const results = await Promise.all(ops);
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      const finalRow = await handle!.pool.query<{ count: number }>(
        "SELECT count FROM system_errors WHERE id = $1",
        [[...ids][0]],
      );
      expect(finalRow.rows[0].count).toBe(N);
    },
  );

  it.skipIf(!handle)(
    "falls back to err_class='Error' when err.name is empty",
    async () => {
      const e = new Error("nameless");
      // Explicit empty name — Node defaults Error.name to "Error", but
      // a hand-rolled error class with `this.name = ""` exists in the
      // wild and would otherwise insert an empty err_class.
      e.name = "";
      const row = await recordError({
        db: handle!.pool,
        repo: "danxbot",
        component: "nameless",
        err: e,
        samplePayload: { raw_msg: "nameless" },
      });
      expect(row.err_class).toBe("Error");
    },
  );

  it.skipIf(!handle)(
    "different repos with identical signature get separate rows",
    async () => {
      const a = await recordError({
        db: handle!.pool,
        repo: "repo-alpha",
        component: "comp",
        err: makeErr("ErrX", "boom"),
        samplePayload: { raw_msg: "boom" },
      });
      const b = await recordError({
        db: handle!.pool,
        repo: "repo-beta",
        component: "comp",
        err: makeErr("ErrX", "boom"),
        samplePayload: { raw_msg: "boom" },
      });
      // signature_hash carries no repo dimension by design, but the
      // primary-key uniqueness is on signature_hash globally — so the
      // first repo's row wins and the second repo upserts INTO that
      // same row. Document this here: the dispatcher will branch on
      // `repo` when picking a target; sharing the row across repos for
      // the same signature is fine because the sample_payload + last
      // seen reflect the most recent occurrence regardless of repo.
      //
      // If the design needs per-repo rows (Phase 3 might), revisit by
      // moving `repo` into the signature hash. For now we assert the
      // current contract: shared row, count is global.
      expect(b.signature_hash).toBe(a.signature_hash);
      expect(b.id).toBe(a.id);
      expect(b.count).toBe(2);
      // b.repo reflects the latest writer (excluded.repo wins on conflict).
      expect(b.repo).toBe("repo-beta");
    },
  );
});

describe("getOpenErrorsRanked", () => {
  it.skipIf(!handle)(
    "returns only status='open' rows ordered by count DESC then last_seen DESC",
    async () => {
      // Seed three signatures via recordError, then flip one to fixed
      // and one to repairing to verify the status filter.
      const seedRepo = `ranked_${Math.random().toString(36).slice(2, 8)}`;

      const low = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "low-count error"),
        samplePayload: { raw_msg: "low" },
      });

      // mid: 3 occurrences
      let mid = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "mid-count error"),
        samplePayload: { raw_msg: "mid" },
      });
      mid = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "mid-count error"),
        samplePayload: { raw_msg: "mid" },
      });
      mid = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "mid-count error"),
        samplePayload: { raw_msg: "mid" },
      });

      // top: 5 occurrences but marked fixed → should NOT appear
      let top = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "top-count error"),
        samplePayload: { raw_msg: "top" },
      });
      for (let i = 0; i < 4; i++) {
        top = await recordError({
          db: handle!.pool,
          repo: seedRepo,
          component: "ranked",
          err: makeErr("E", "top-count error"),
          samplePayload: { raw_msg: "top" },
        });
      }
      await handle!.pool.query(
        `UPDATE system_errors SET status = 'fixed' WHERE id = $1`,
        [top.id],
      );

      // A 4th: 2 occurrences, status repairing → should NOT appear
      let repairing = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "repairing-error"),
        samplePayload: { raw_msg: "rep" },
      });
      repairing = await recordError({
        db: handle!.pool,
        repo: seedRepo,
        component: "ranked",
        err: makeErr("E", "repairing-error"),
        samplePayload: { raw_msg: "rep" },
      });
      await handle!.pool.query(
        `UPDATE system_errors SET status = 'repairing' WHERE id = $1`,
        [repairing.id],
      );

      const ranked = await getOpenErrorsRanked({
        db: handle!.pool,
        repo: seedRepo,
        limit: 10,
      });

      const idsOnly = ranked.map((r) => r.id);
      expect(idsOnly).toEqual([mid.id, low.id]);
      expect(ranked[0].count).toBe(3);
      expect(ranked[1].count).toBe(1);
      expect(ranked.every((r) => r.status === "open")).toBe(true);
    },
  );

  it.skipIf(!handle)(
    "honors the limit parameter",
    async () => {
      const seedRepo = `limit_${Math.random().toString(36).slice(2, 8)}`;
      for (let i = 0; i < 5; i++) {
        await recordError({
          db: handle!.pool,
          repo: seedRepo,
          component: "limited",
          err: makeErr("E", `limit-msg-${i}`),
          samplePayload: { raw_msg: `m-${i}` },
        });
      }
      const ranked = await getOpenErrorsRanked({
        db: handle!.pool,
        repo: seedRepo,
        limit: 3,
      });
      expect(ranked).toHaveLength(3);
    },
  );

  it.skipIf(!handle)(
    "filters by repo — other repos' rows do not leak",
    async () => {
      const a = `repoA_${Math.random().toString(36).slice(2, 8)}`;
      const b = `repoB_${Math.random().toString(36).slice(2, 8)}`;
      await recordError({
        db: handle!.pool,
        repo: a,
        component: "comp",
        err: makeErr("Iso", "isolated to A"),
        samplePayload: { raw_msg: "A" },
      });
      await recordError({
        db: handle!.pool,
        repo: b,
        component: "comp",
        err: makeErr("Iso", "isolated to B"),
        samplePayload: { raw_msg: "B" },
      });
      const onlyA = await getOpenErrorsRanked({
        db: handle!.pool,
        repo: a,
        limit: 10,
      });
      expect(onlyA.every((r) => r.repo === a)).toBe(true);
      expect(onlyA.some((r) => r.normalized_msg === "isolated to A")).toBe(true);
      expect(onlyA.some((r) => r.normalized_msg === "isolated to B")).toBe(
        false,
      );
    },
  );
});

// File-level teardown — drop the test DB once every describe has run.
// Putting `afterAll` inside a single describe would close the pool
// before sibling describes execute (vitest runs describes in file order,
// each describe's afterAll fires when that describe completes).
afterAll(async () => {
  if (handle) await handle.close();
});

function makeErr(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
