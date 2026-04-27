/**
 * Fake `mysql2/promise` Pool double — minimal surface to satisfy
 * `getPlatformPool()` consumers without standing up a real MySQL.
 *
 * The only consumer in production is `src/worker/sql-executor.ts`'s
 * `executeQuery`, which calls:
 *
 *     const pool = getPlatformPool();
 *     const [rows, fields] = await pool.query({ sql: query, timeout: ... });
 *
 * That's the entire surface — `query` returning a `[rows, fields]` tuple.
 * The fake adds:
 *
 *   - `registerQuery(matcher, rows, fields?)` for canned happy responses.
 *   - `registerQueryError(matcher, err)` for canned failures.
 *   - `getQueryLog()` so tests can assert exactly which SQL ran.
 *   - `reset()` to clear fixtures + log between tests.
 *
 * Unmatched queries throw a loud "no canned result for query: <sql>" error
 * — the WHOLE point of the fake is to make missing fixtures fail loud
 * instead of silently returning empty rows (the K2zQYIdX class of bug).
 */

import { vi, type Mock } from "vitest";

type Matcher =
  | string
  | RegExp
  | ((sql: string) => boolean);

interface Fixture {
  matcher: Matcher;
  // EITHER `rows` (success) OR `error` (failure). The fixture types are
  // separated by the `kind` discriminator so a malformed registration
  // can't smuggle both into the same fixture.
  kind: "ok" | "error";
  rows?: Record<string, unknown>[];
  fields?: { name: string }[];
  error?: Error;
}

export interface FakePlatformPool {
  /** Mirrors `Pool.query`: accepts a string OR an `{sql, timeout?}` object. */
  query: Mock<
    (
      arg: string | { sql: string; timeout?: number },
    ) => Promise<[Record<string, unknown>[], { name: string }[]]>
  >;
  end: Mock<() => Promise<void>>;
  /** Register a canned `[rows, fields]` response for queries matching `matcher`. */
  registerQuery: (
    matcher: Matcher,
    rows: Record<string, unknown>[],
    fields?: { name: string }[],
  ) => void;
  /** Register a canned thrown Error for queries matching `matcher`. */
  registerQueryError: (matcher: Matcher, err: Error) => void;
  /** Every SQL string the pool has been asked to run, in invocation order. */
  getQueryLog: () => string[];
  /** Clear fixtures + log so a follow-up test sees a clean slate. */
  reset: () => void;
}

function extractSql(arg: string | { sql: string; timeout?: number }): string {
  return typeof arg === "string" ? arg : arg.sql;
}

function matches(matcher: Matcher, sql: string): boolean {
  if (typeof matcher === "string") return sql === matcher;
  if (matcher instanceof RegExp) return matcher.test(sql);
  return matcher(sql);
}

/**
 * Synthesize a `FieldPacket`-shaped array from the union of keys across `rows`,
 * preserving first-appearance order. `mysql2` returns one `FieldPacket` per
 * column in the SELECT list; for fakes, the union of row keys is the closest
 * truthful approximation.
 */
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

  const query = vi.fn(
    async (arg: string | { sql: string; timeout?: number }) => {
      const sql = extractSql(arg);
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
      return [rows, fields] as [Record<string, unknown>[], { name: string }[]];
    },
  );

  const end = vi.fn(async () => undefined);

  return {
    query,
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
      query.mockClear();
      end.mockClear();
    },
  };
}
