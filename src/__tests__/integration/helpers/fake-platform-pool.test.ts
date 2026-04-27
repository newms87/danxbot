import { describe, it, expect, beforeEach } from "vitest";
import {
  createFakePlatformPool,
  type FakePlatformPool,
} from "./fake-platform-pool.js";

describe("FakePlatformPool", () => {
  let pool: FakePlatformPool;

  beforeEach(() => {
    pool = createFakePlatformPool();
  });

  describe("query() with exact-string fixtures", () => {
    it("returns the registered rows + auto-derived fields when an exact-string fixture matches", async () => {
      pool.registerQuery("SELECT id FROM users", [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);

      const [rows, fields] = await pool.query({ sql: "SELECT id FROM users" });

      expect(rows).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
      // Fields synthesized from the union of row keys (ordered by first appearance).
      expect(fields.map((f) => f.name)).toEqual(["id", "name"]);
    });

    it("matches plain-string sql arg as well as { sql, timeout } object arg", async () => {
      pool.registerQuery("SHOW TABLES", [{ Tables_in_db: "users" }]);

      const [rows1] = await pool.query("SHOW TABLES");
      const [rows2] = await pool.query({ sql: "SHOW TABLES", timeout: 100 });

      expect(rows1).toEqual([{ Tables_in_db: "users" }]);
      expect(rows2).toEqual([{ Tables_in_db: "users" }]);
    });
  });

  describe("query() with RegExp fixtures", () => {
    it("matches via RegExp when the fixture is a regex (case-insensitive whitespace tolerance)", async () => {
      pool.registerQuery(/^\s*SHOW\s+TABLES\b/i, [
        { Tables_in_db: "users" },
        { Tables_in_db: "events" },
      ]);

      const [rows] = await pool.query({ sql: "  show tables  " });
      expect(rows).toEqual([
        { Tables_in_db: "users" },
        { Tables_in_db: "events" },
      ]);
    });
  });

  describe("query() with predicate fixtures", () => {
    it("matches via a predicate function for fully-custom dispatching", async () => {
      pool.registerQuery(
        (sql) => sql.includes("FROM events"),
        [{ count: 42 }],
      );

      const [rows] = await pool.query({ sql: "SELECT COUNT(*) AS count FROM events" });
      expect(rows).toEqual([{ count: 42 }]);
    });
  });

  describe("query() ordering / multiple fixtures", () => {
    it("uses the FIRST registered fixture that matches (registration order, not most-specific)", async () => {
      pool.registerQuery(/SELECT/i, [{ first: true }]);
      pool.registerQuery("SELECT * FROM users", [{ second: true }]);

      const [rows] = await pool.query({ sql: "SELECT * FROM users" });
      expect(rows).toEqual([{ first: true }]);
    });
  });

  describe("query() unmatched failures", () => {
    it("throws a descriptive error when no fixture matches (silent-empty-rows is forbidden)", async () => {
      pool.registerQuery("SELECT id FROM users", [{ id: 1 }]);

      await expect(pool.query({ sql: "SELECT name FROM accounts" })).rejects.toThrow(
        /FakePlatformPool: no canned result for query/,
      );
    });

    it("the unmatched-error mentions the actual SQL so the missing fixture is obvious to the test author", async () => {
      try {
        await pool.query({ sql: "DESCRIBE foo" });
        expect.fail("expected throw");
      } catch (err) {
        expect((err as Error).message).toMatch(/DESCRIBE foo/);
      }
    });
  });

  describe("query() error fixtures", () => {
    it("rejects with the registered Error when a fixture is registered with `error`", async () => {
      pool.registerQueryError("SELECT * FROM forbidden", new Error("permission denied"));

      await expect(pool.query({ sql: "SELECT * FROM forbidden" })).rejects.toThrow(
        "permission denied",
      );
    });
  });

  describe("explicit fields override", () => {
    it("uses caller-supplied fields when provided (so empty rows can still carry column metadata)", async () => {
      pool.registerQuery(
        "SELECT id FROM users WHERE 1=0",
        [],
        [{ name: "id" }, { name: "name" }],
      );

      const [rows, fields] = await pool.query({ sql: "SELECT id FROM users WHERE 1=0" });
      expect(rows).toEqual([]);
      expect(fields.map((f) => f.name)).toEqual(["id", "name"]);
    });
  });

  describe("inspection", () => {
    it("getQueryLog returns every SQL string the pool has been asked to run, in order", async () => {
      pool.registerQuery(/.*/, [{}]);
      await pool.query({ sql: "SELECT 1" });
      await pool.query("SELECT 2");

      expect(pool.getQueryLog()).toEqual(["SELECT 1", "SELECT 2"]);
    });
  });

  describe("reset()", () => {
    it("clears fixtures and the query log so a follow-up test sees a clean slate", async () => {
      pool.registerQuery("SELECT 1", [{ x: 1 }]);
      await pool.query({ sql: "SELECT 1" });

      pool.reset();

      expect(pool.getQueryLog()).toEqual([]);
      await expect(pool.query({ sql: "SELECT 1" })).rejects.toThrow(/no canned result/);
    });
  });

  describe("tuple shape compatibility with sql-executor", () => {
    it("returned tuple destructures into [rows, fields] with rows preserving registered order and fields exposing { name }", async () => {
      // Mirrors `const [rows, fields] = await pool.query(...)` in
      // `src/worker/sql-executor.ts:148`. The runtime shape — array
      // tuple length 2, fields[*].name string — must line up with
      // mysql2's contract or `executeQuery` blows up at column
      // extraction. TS compatibility is verified at the type-check
      // layer; this test pins the runtime shape.
      pool.registerQuery("SELECT id, name FROM users", [
        { id: 1, name: "alice" },
      ]);

      const result = await pool.query({ sql: "SELECT id, name FROM users", timeout: 5000 });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      const [rows, fields] = result;
      expect(rows[0]).toMatchObject({ id: 1, name: "alice" });
      expect(fields[0].name).toBe("id");
    });
  });
});
