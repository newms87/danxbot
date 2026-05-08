import { describe, it, expect, beforeEach } from "vitest";
import {
  createFakePlatformPool,
  type FakePlatformPool,
  type FakePoolClient,
} from "./fake-platform-pool.js";

describe("FakePlatformPool", () => {
  let pool: FakePlatformPool;
  let client: FakePoolClient;

  beforeEach(async () => {
    pool = createFakePlatformPool();
    client = await pool.connect();
  });

  describe("query() with exact-string fixtures", () => {
    it("returns the registered rows + auto-derived fields when an exact-string fixture matches", async () => {
      pool.registerQuery("SELECT id FROM users", [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);

      const result = await client.query("SELECT id FROM users");

      expect(result.rows).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
      expect(result.fields.map((f) => f.name)).toEqual(["id", "name"]);
    });
  });

  describe("query() with RegExp fixtures", () => {
    it("matches via RegExp when the fixture is a regex (case-insensitive whitespace tolerance)", async () => {
      pool.registerQuery(/^\s*SHOW\s+TABLES\b/i, [
        { Tables_in_db: "users" },
        { Tables_in_db: "events" },
      ]);

      const result = await client.query("  show tables  ");
      expect(result.rows).toEqual([
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

      const result = await client.query("SELECT COUNT(*) AS count FROM events");
      expect(result.rows).toEqual([{ count: 42 }]);
    });
  });

  describe("query() ordering / multiple fixtures", () => {
    it("uses the FIRST registered fixture that matches (registration order, not most-specific)", async () => {
      pool.registerQuery(/SELECT/i, [{ first: true }]);
      pool.registerQuery("SELECT * FROM users", [{ second: true }]);

      const result = await client.query("SELECT * FROM users");
      expect(result.rows).toEqual([{ first: true }]);
    });
  });

  describe("query() unmatched failures", () => {
    it("throws a descriptive error when no fixture matches (silent-empty-rows is forbidden)", async () => {
      pool.registerQuery("SELECT id FROM users", [{ id: 1 }]);

      await expect(client.query("SELECT name FROM accounts")).rejects.toThrow(
        /FakePlatformPool: no canned result for query/,
      );
    });

    it("the unmatched-error mentions the actual SQL so the missing fixture is obvious to the test author", async () => {
      try {
        await client.query("DESCRIBE foo");
        expect.fail("expected throw");
      } catch (err) {
        expect((err as Error).message).toMatch(/DESCRIBE foo/);
      }
    });
  });

  describe("query() error fixtures", () => {
    it("rejects with the registered Error when a fixture is registered with `error`", async () => {
      pool.registerQueryError("SELECT * FROM forbidden", new Error("permission denied"));

      await expect(client.query("SELECT * FROM forbidden")).rejects.toThrow(
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

      const result = await client.query("SELECT id FROM users WHERE 1=0");
      expect(result.rows).toEqual([]);
      expect(result.fields.map((f) => f.name)).toEqual(["id", "name"]);
    });
  });

  describe("inspection", () => {
    it("getQueryLog returns every SQL string the pool has been asked to run, in order", async () => {
      pool.registerQuery(/.*/, [{}]);
      await client.query("SELECT 1");
      await client.query("SELECT 2");

      expect(pool.getQueryLog()).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("getQueryLog excludes SET LOCAL statement_timeout — it's transparent infra", async () => {
      pool.registerQuery(/.*/, [{}]);
      await client.query("SET LOCAL statement_timeout = 10000");
      await client.query("SELECT actual");
      expect(pool.getQueryLog()).toEqual(["SELECT actual"]);
    });
  });

  describe("reset()", () => {
    it("clears fixtures and the query log so a follow-up test sees a clean slate", async () => {
      pool.registerQuery("SELECT 1", [{ x: 1 }]);
      await client.query("SELECT 1");

      pool.reset();

      expect(pool.getQueryLog()).toEqual([]);
      await expect(client.query("SELECT 1")).rejects.toThrow(/no canned result/);
    });
  });

  describe("client shape compatibility with sql-executor", () => {
    it("client.query returns { rows, fields } with rows preserving registered order and fields exposing { name }", async () => {
      pool.registerQuery("SELECT id, name FROM users", [
        { id: 1, name: "alice" },
      ]);

      const result = await client.query("SELECT id, name FROM users");
      expect(result.rows[0]).toMatchObject({ id: 1, name: "alice" });
      expect(result.fields[0].name).toBe("id");
    });
  });
});
