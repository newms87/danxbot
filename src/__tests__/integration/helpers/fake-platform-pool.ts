/**
 * Fake `pg` Pool double — minimal surface to satisfy `getPlatformPool()`
 * consumers without standing up a real Postgres.
 *
 * The only consumer in production is `src/worker/sql-executor.ts`'s
 * `executeQuery`, which calls:
 *
 *     const pool = getPlatformPool();
 *     const client = await pool.connect();
 *     await client.query("SET LOCAL statement_timeout = ...");
 *     const result = await client.query<...>(query);
 *     // result.rows + result.fields[].name
 *     client.release();
 *
 * The fake provides:
 *
 *   - `connect()` returning a fake client whose `query()` honors fixtures.
 *   - `registerQuery(matcher, rows, fields?)` for canned happy responses.
 *   - `registerQueryError(matcher, err)` for canned failures.
 *   - `getQueryLog()` so tests can assert exactly which SQL ran.
 *   - `reset()` to clear fixtures + log between tests.
 *
 * Unmatched queries throw a loud "no canned result for query: <sql>" error.
 * The fake silently swallows `SET LOCAL` statements so per-call
 * statement_timeout configuration in production code never needs a fixture.
 */

import { vi, type Mock } from "vitest";

type Matcher =
  | string
  | RegExp
  | ((sql: string) => boolean);

interface Fixture {
  matcher: Matcher;
  kind: "ok" | "error";
  rows?: Record<string, unknown>[];
  fields?: { name: string }[];
  error?: Error;
}

export interface FakePlatformPool {
  connect: Mock<() => Promise<FakePoolClient>>;
  end: Mock<() => Promise<void>>;
  registerQuery: (
    matcher: Matcher,
    rows: Record<string, unknown>[],
    fields?: { name: string }[],
  ) => void;
  registerQueryError: (matcher: Matcher, err: Error) => void;
  getQueryLog: () => string[];
  reset: () => void;
}

export interface FakePoolClient {
  query: Mock<
    (
      sql: string,
      params?: unknown[],
    ) => Promise<{
      rows: Record<string, unknown>[];
      fields: { name: string }[];
      rowCount: number;
    }>
  >;
  release: Mock<() => void>;
}

function matches(matcher: Matcher, sql: string): boolean {
  if (typeof matcher === "string") return sql === matcher;
  if (matcher instanceof RegExp) return matcher.test(sql);
  return matcher(sql);
}

function deriveFields(
  rows: Record<string, unknown>[],
): { name: string }[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  return cols.map((name) => ({ name }));
}

export function createFakePlatformPool(): FakePlatformPool {
  const fixtures: Fixture[] = [];
  const queryLog: string[] = [];

  function makeClient(): FakePoolClient {
    const query = vi.fn(async (sql: string) => {
      // SET LOCAL statement_timeout is sql-executor's per-call timeout
      // configuration — silently swallow so tests don't need a fixture.
      if (/^\s*SET\s+LOCAL\s+/i.test(sql)) {
        return { rows: [], fields: [], rowCount: 0 };
      }
      queryLog.push(sql);

      const fixture = fixtures.find((f) => matches(f.matcher, sql));
      if (!fixture) {
        throw new Error(
          `FakePlatformPool: no canned result for query: ${sql}. ` +
            `Register one via pool.registerQuery(matcher, rows) before invoking.`,
        );
      }
      if (fixture.kind === "error") {
        throw fixture.error!;
      }
      const rows = fixture.rows!;
      const fields = fixture.fields ?? deriveFields(rows);
      return { rows, fields, rowCount: rows.length };
    });
    const release = vi.fn(() => undefined);
    return { query, release };
  }

  const connect = vi.fn(async () => makeClient());
  const end = vi.fn(async () => undefined);

  return {
    connect,
    end,
    registerQuery(matcher, rows, fields) {
      fixtures.push({ matcher, kind: "ok", rows, fields });
    },
    registerQueryError(matcher, err) {
      fixtures.push({ matcher, kind: "error", error: err });
    },
    getQueryLog() {
      return queryLog.slice();
    },
    reset() {
      fixtures.length = 0;
      queryLog.length = 0;
      connect.mockClear();
      end.mockClear();
    },
  };
}
