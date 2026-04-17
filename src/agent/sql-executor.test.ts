import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock pool and logger so they're available in vi.mock factory
const { mockPool, mockLogger } = vi.hoisted(() => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(),
  };
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { mockPool, mockLogger };
});

vi.mock("../db/connection.js", () => ({
  getPlatformPool: () => mockPool,
}));

vi.mock("../logger.js", () => ({
  createLogger: () => mockLogger,
}));

import {
  extractSqlBlocks,
  isSafeQuery,
  formatResultsAsTable,
  formatResultsAsCsv,
  executeQuery,
  processResponse,
  processResponseWithAttachments,
} from "./sql-executor.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractSqlBlocks", () => {
  it("extracts a single sql:execute block", () => {
    const text = "Here are the results:\n```sql:execute\nSELECT * FROM users\n```\nDone.";
    const blocks = extractSqlBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].query).toBe("SELECT * FROM users");
    expect(blocks[0].fullMatch).toBe("```sql:execute\nSELECT * FROM users\n```");
  });

  it("extracts multiple sql:execute blocks", () => {
    const text = "First:\n```sql:execute\nSELECT 1\n```\nSecond:\n```sql:execute\nSELECT 2\n```";
    const blocks = extractSqlBlocks(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].query).toBe("SELECT 1");
    expect(blocks[1].query).toBe("SELECT 2");
  });

  it("returns empty array when no blocks found", () => {
    const text = "Just some regular text with no SQL blocks.";
    const blocks = extractSqlBlocks(text);

    expect(blocks).toEqual([]);
  });

  it("ignores regular sql blocks without :execute", () => {
    const text = "Example:\n```sql\nSELECT * FROM users\n```\nDone.";
    const blocks = extractSqlBlocks(text);

    expect(blocks).toEqual([]);
  });

  it("handles multiline queries", () => {
    const text = "```sql:execute\nSELECT u.name, u.email\nFROM users u\nWHERE u.active = 1\nLIMIT 10\n```";
    const blocks = extractSqlBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].query).toBe("SELECT u.name, u.email\nFROM users u\nWHERE u.active = 1\nLIMIT 10");
  });
});

describe("isSafeQuery", () => {
  it("allows SELECT queries", () => {
    expect(isSafeQuery("SELECT * FROM users")).toBe(true);
  });

  it("allows SELECT queries case-insensitively", () => {
    expect(isSafeQuery("select * from users")).toBe(true);
    expect(isSafeQuery("Select id From users")).toBe(true);
  });

  it("allows SELECT with leading whitespace", () => {
    expect(isSafeQuery("  SELECT * FROM users")).toBe(true);
  });

  it("allows SELECT with subqueries", () => {
    expect(isSafeQuery("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")).toBe(true);
  });

  it("rejects INSERT queries", () => {
    expect(isSafeQuery("INSERT INTO users (name) VALUES ('test')")).toBe(false);
  });

  it("rejects UPDATE queries", () => {
    expect(isSafeQuery("UPDATE users SET name = 'test'")).toBe(false);
  });

  it("rejects DELETE queries", () => {
    expect(isSafeQuery("DELETE FROM users")).toBe(false);
  });

  it("rejects DROP queries", () => {
    expect(isSafeQuery("DROP TABLE users")).toBe(false);
  });

  it("rejects ALTER queries", () => {
    expect(isSafeQuery("ALTER TABLE users ADD COLUMN age INT")).toBe(false);
  });

  it("rejects CREATE queries", () => {
    expect(isSafeQuery("CREATE TABLE test (id INT)")).toBe(false);
  });

  it("rejects TRUNCATE queries", () => {
    expect(isSafeQuery("TRUNCATE TABLE users")).toBe(false);
  });

  it("rejects multi-statement queries", () => {
    expect(isSafeQuery("SELECT 1; DROP TABLE users")).toBe(false);
  });

  it("allows SELECT with semicolon at end only", () => {
    expect(isSafeQuery("SELECT * FROM users;")).toBe(true);
  });

  it("rejects empty queries", () => {
    expect(isSafeQuery("")).toBe(false);
    expect(isSafeQuery("   ")).toBe(false);
  });

  it("rejects SELECT INTO OUTFILE", () => {
    expect(isSafeQuery("SELECT * INTO OUTFILE '/tmp/data' FROM users")).toBe(false);
  });

  it("rejects SELECT INTO DUMPFILE", () => {
    expect(isSafeQuery("SELECT * INTO DUMPFILE '/tmp/data' FROM users")).toBe(false);
  });

  it("allows DESCRIBE for schema introspection", () => {
    expect(isSafeQuery("DESCRIBE suppliers")).toBe(true);
    expect(isSafeQuery("describe suppliers")).toBe(true);
    expect(isSafeQuery("DESC suppliers")).toBe(true);
  });

  it("allows SHOW TABLES", () => {
    expect(isSafeQuery("SHOW TABLES")).toBe(true);
    expect(isSafeQuery("show tables")).toBe(true);
    expect(isSafeQuery("SHOW TABLES LIKE '%supplier%'")).toBe(true);
  });

  it("allows SHOW COLUMNS", () => {
    expect(isSafeQuery("SHOW COLUMNS FROM suppliers")).toBe(true);
  });

  it("allows SHOW INDEX / INDEXES", () => {
    expect(isSafeQuery("SHOW INDEX FROM suppliers")).toBe(true);
    expect(isSafeQuery("SHOW INDEXES FROM suppliers")).toBe(true);
  });

  it("allows SHOW CREATE TABLE for schema reference", () => {
    expect(isSafeQuery("SHOW CREATE TABLE suppliers")).toBe(true);
  });

  it("rejects SHOW DATABASES (can expose other tenants)", () => {
    expect(isSafeQuery("SHOW DATABASES")).toBe(false);
  });

  it("rejects SHOW GRANTS (credential discovery)", () => {
    expect(isSafeQuery("SHOW GRANTS FOR 'root'@'%'")).toBe(false);
  });

  it("rejects INTO OUTFILE case-insensitively", () => {
    expect(isSafeQuery("select * into outfile '/tmp/data' from users")).toBe(false);
    expect(isSafeQuery("SELECT * Into Outfile '/tmp/data' FROM users")).toBe(false);
  });

  it("rejects REPLACE queries", () => {
    expect(isSafeQuery("REPLACE INTO users (name) VALUES ('test')")).toBe(false);
  });

  it("rejects RENAME queries", () => {
    expect(isSafeQuery("RENAME TABLE users TO old_users")).toBe(false);
  });

  it("rejects GRANT queries", () => {
    expect(isSafeQuery("GRANT SELECT ON users TO 'reader'")).toBe(false);
  });

  it("rejects REVOKE queries", () => {
    expect(isSafeQuery("REVOKE SELECT ON users FROM 'reader'")).toBe(false);
  });
});

describe("formatResultsAsTable", () => {
  it("formats columns and rows as markdown table", () => {
    const result = formatResultsAsTable(["id", "name"], [["1", "Alice"], ["2", "Bob"]]);

    expect(result).toBe("| id | name |\n|---|---|\n| 1 | Alice |\n| 2 | Bob |");
  });

  it("returns no results message for empty rows", () => {
    const result = formatResultsAsTable(["id", "name"], []);

    expect(result).toBe("*No results found.*");
  });

  it("includes truncation note when totalRows exceeds row count", () => {
    const result = formatResultsAsTable(
      ["id"],
      [["1"], ["2"]],
      100,
    );

    expect(result).toContain("*(Showing 2 of 100 rows)*");
  });

  it("does not include truncation note when all rows shown", () => {
    const result = formatResultsAsTable(["id"], [["1"], ["2"]]);

    expect(result).not.toContain("Showing");
  });

  it("escapes pipe characters in cell values", () => {
    const result = formatResultsAsTable(["value"], [["a|b"]]);

    expect(result).toContain("a\\|b");
    expect(result).not.toContain("a|b");
  });
});

describe("executeQuery", () => {
  it("returns columns and rows from successful query", async () => {
    const fields = [{ name: "id" }, { name: "name" }];
    const rows = [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const result = await executeQuery("SELECT * FROM users");

    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([["1", "Alice"], ["2", "Bob"]]);
    expect(result.error).toBeUndefined();
  });

  it("returns error for failed queries", async () => {
    mockPool.query.mockRejectedValue(new Error("Table not found"));

    const result = await executeQuery("SELECT * FROM nonexistent");

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.error).toBe("Table not found");
  });

  it("truncates results over 50 rows", async () => {
    const fields = [{ name: "id" }];
    const rows = Array.from({ length: 75 }, (_, i) => ({ id: i + 1 }));
    mockPool.query.mockResolvedValue([rows, fields]);

    const result = await executeQuery("SELECT * FROM big_table");

    expect(result.rows).toHaveLength(50);
    expect(result.totalRows).toBe(75);
  });

  it("converts null values to string 'NULL'", async () => {
    const fields = [{ name: "id" }, { name: "email" }];
    const rows = [{ id: 1, email: null }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const result = await executeQuery("SELECT id, email FROM users");

    expect(result.rows).toEqual([["1", "NULL"]]);
  });

  it("passes timeout option to pool.query", async () => {
    const fields = [{ name: "id" }];
    mockPool.query.mockResolvedValue([[{ id: 1 }], fields]);

    await executeQuery("SELECT 1");

    expect(mockPool.query).toHaveBeenCalledWith({ sql: "SELECT 1", timeout: 10000 });
  });

  it("returns all 50 rows without totalRows when exactly 50", async () => {
    const fields = [{ name: "id" }];
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    mockPool.query.mockResolvedValue([rows, fields]);

    const result = await executeQuery("SELECT * FROM users");

    expect(result.rows).toHaveLength(50);
    expect(result.totalRows).toBeUndefined();
  });

  it("handles undefined values in rows", async () => {
    const fields = [{ name: "id" }, { name: "optional" }];
    const rows = [{ id: 1, optional: undefined }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const result = await executeQuery("SELECT id, optional FROM users");

    expect(result.rows).toEqual([["1", "NULL"]]);
  });
});

describe("processResponse", () => {
  it("returns text unchanged when no sql:execute blocks", async () => {
    const text = "Here is some regular text.";
    const result = await processResponse(text);

    expect(result).toBe(text);
  });

  it("replaces sql:execute blocks with CSV attachment reference", async () => {
    const fields = [{ name: "id" }, { name: "name" }];
    const rows = [{ id: 1, name: "Alice" }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const text = "Results:\n```sql:execute\nSELECT * FROM users\n```\nDone.";
    const result = await processResponse(text);

    expect(result).toContain("Query returned 1 row");
    expect(result).toContain("see attached CSV");
    expect(result).toContain("Results:");
    expect(result).toContain("Done.");
    expect(result).not.toContain("sql:execute");
  });

  it("shows error for unsafe queries", async () => {
    const text = "```sql:execute\nDROP TABLE users\n```";
    const result = await processResponse(text);

    expect(result).toContain("Only SELECT queries are allowed");
    expect(result).not.toContain("sql:execute");
  });

  it("shows generic error for failed queries", async () => {
    mockPool.query.mockRejectedValue(new Error("Unknown column"));

    const text = "```sql:execute\nSELECT bad_col FROM users\n```";
    const result = await processResponse(text);

    expect(result).toContain("Query execution failed");
    expect(result).not.toContain("Unknown column");
  });

  it("handles multiple blocks in one response", async () => {
    const fields1 = [{ name: "count" }];
    const rows1 = [{ count: 42 }];
    const fields2 = [{ name: "name" }];
    const rows2 = [{ name: "Alice" }];

    mockPool.query
      .mockResolvedValueOnce([rows1, fields1])
      .mockResolvedValueOnce([rows2, fields2]);

    const text = "Count:\n```sql:execute\nSELECT COUNT(*) as count FROM users\n```\nNames:\n```sql:execute\nSELECT name FROM users LIMIT 1\n```";
    const result = await processResponse(text);

    expect(result).toContain("Query returned 1 row");
    expect(result).toContain("Count:");
    expect(result).toContain("Names:");
    expect(result).not.toContain("sql:execute");
  });

  it("handles mixed safe and unsafe blocks", async () => {
    const fields = [{ name: "id" }];
    const rows = [{ id: 1 }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const text = "Safe:\n```sql:execute\nSELECT * FROM users\n```\nUnsafe:\n```sql:execute\nDELETE FROM users\n```";
    const result = await processResponse(text);

    expect(result).toContain("Query returned 1 row");
    expect(result).toContain("Only SELECT queries are allowed");
    expect(result).not.toContain("sql:execute");
  });

  it("handles duplicate identical sql:execute blocks", async () => {
    const fields = [{ name: "count" }];
    const rows = [{ count: 5 }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const text = "First:\n```sql:execute\nSELECT COUNT(*) as count FROM users\n```\nSecond:\n```sql:execute\nSELECT COUNT(*) as count FROM users\n```";
    const result = await processResponse(text);

    // Both blocks should be replaced, not just the first one
    expect(result).not.toContain("sql:execute");
    expect(result).toContain("First:");
    expect(result).toContain("Second:");
  });

  it("does not leak error details to user", async () => {
    mockPool.query.mockRejectedValue(
      new Error("Table 'platform.secret_table' doesn't exist at /var/lib/mysql/data"),
    );

    const text = "```sql:execute\nSELECT * FROM secret_table\n```";
    const result = await processResponse(text);

    expect(result).toContain("Query execution failed");
    expect(result).not.toContain("secret_table");
    expect(result).not.toContain("/var/lib/mysql");
  });

  it("logs rejected unsafe queries", async () => {
    const text = "```sql:execute\nDROP TABLE users\n```";
    await processResponse(text);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unsafe query rejected"),
      expect.any(String),
    );
  });
});

describe("formatResultsAsCsv", () => {
  it("formats columns and rows as CSV", () => {
    const result = formatResultsAsCsv(["id", "name"], [["1", "Alice"], ["2", "Bob"]]);
    expect(result).toBe("id,name\n1,Alice\n2,Bob");
  });

  it("returns header only for empty rows", () => {
    const result = formatResultsAsCsv(["id", "name"], []);
    expect(result).toBe("id,name");
  });

  it("quotes values containing commas", () => {
    const result = formatResultsAsCsv(["name"], [["Smith, John"]]);
    expect(result).toBe('name\n"Smith, John"');
  });

  it("quotes values containing double quotes and escapes them", () => {
    const result = formatResultsAsCsv(["desc"], [['He said "hello"']]);
    expect(result).toBe('desc\n"He said ""hello"""');
  });

  it("quotes values containing newlines", () => {
    const result = formatResultsAsCsv(["text"], [["line1\nline2"]]);
    expect(result).toBe('text\n"line1\nline2"');
  });

  it("quotes column names containing commas", () => {
    const result = formatResultsAsCsv(["a,b"], [["val"]]);
    expect(result).toBe('"a,b"\nval');
  });
});

describe("processResponseWithAttachments", () => {
  it("returns text and empty attachments when no sql:execute blocks", async () => {
    const result = await processResponseWithAttachments("Just text.");
    expect(result.text).toBe("Just text.");
    expect(result.attachments).toEqual([]);
  });

  it("replaces sql:execute blocks and returns CSV attachments", async () => {
    const fields = [{ name: "id" }, { name: "name" }];
    const rows = [{ id: 1, name: "Alice" }];
    mockPool.query.mockResolvedValue([rows, fields]);

    const text = "Results:\n```sql:execute\nSELECT * FROM users\n```\nDone.";
    const result = await processResponseWithAttachments(text);

    // Text should have CSV attachment reference (not inline table)
    expect(result.text).toContain("Query returned 1 row");
    expect(result.text).toContain("see attached CSV");
    expect(result.text).not.toContain("sql:execute");

    // Should have one CSV attachment
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].csv).toBe("id,name\n1,Alice");
    expect(result.attachments[0].filename).toMatch(/^query-result.*\.csv$/);
    expect(result.attachments[0].query).toBe("SELECT * FROM users");
  });

  it("does not create attachments for failed queries", async () => {
    mockPool.query.mockRejectedValue(new Error("Table not found"));

    const text = "```sql:execute\nSELECT * FROM bad_table\n```";
    const result = await processResponseWithAttachments(text);

    expect(result.text).toContain("Query execution failed");
    expect(result.attachments).toEqual([]);
  });

  it("does not create attachments for unsafe queries", async () => {
    const text = "```sql:execute\nDROP TABLE users\n```";
    const result = await processResponseWithAttachments(text);

    expect(result.text).toContain("Only SELECT queries are allowed");
    expect(result.attachments).toEqual([]);
  });

  it("does not create attachments for empty results", async () => {
    const fields = [{ name: "id" }];
    mockPool.query.mockResolvedValue([[], fields]);

    const text = "```sql:execute\nSELECT * FROM empty_table\n```";
    const result = await processResponseWithAttachments(text);

    expect(result.text).toContain("No results found");
    expect(result.attachments).toEqual([]);
  });

  it("creates multiple attachments for multiple blocks", async () => {
    const fields1 = [{ name: "count" }];
    const rows1 = [{ count: 42 }];
    const fields2 = [{ name: "name" }];
    const rows2 = [{ name: "Alice" }];

    mockPool.query
      .mockResolvedValueOnce([rows1, fields1])
      .mockResolvedValueOnce([rows2, fields2]);

    const text = "First:\n```sql:execute\nSELECT COUNT(*) as count FROM users\n```\nSecond:\n```sql:execute\nSELECT name FROM users LIMIT 1\n```";
    const result = await processResponseWithAttachments(text);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].csv).toBe("count\n42");
    expect(result.attachments[1].csv).toBe("name\nAlice");
  });
});
