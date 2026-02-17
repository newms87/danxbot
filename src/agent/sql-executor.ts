import { getPlatformPool } from "../db/connection.js";
import { createLogger } from "../logger.js";
import type { FieldPacket } from "mysql2/promise";

const log = createLogger("sql-executor");

const SQL_BLOCK_PATTERN = "```sql:execute\\n([\\s\\S]*?)\\n```";
const MAX_ROWS = 50;
const QUERY_TIMEOUT_MS = 10000;

export interface SqlBlock {
  fullMatch: string;
  query: string;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  totalRows?: number;
  error?: string;
}

/**
 * Extract all ```sql:execute blocks from response text.
 */
export function extractSqlBlocks(text: string): SqlBlock[] {
  const blocks: SqlBlock[] = [];
  let match: RegExpExecArray | null;

  const regex = new RegExp(SQL_BLOCK_PATTERN, "g");

  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      fullMatch: match[0],
      query: match[1].trim(),
    });
  }

  return blocks;
}

/**
 * Check if a query is safe to execute (SELECT only).
 */
export function isSafeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;

  // Must start with SELECT
  if (!/^\s*SELECT\b/i.test(trimmed)) return false;

  // Block SELECT INTO OUTFILE/DUMPFILE (writes query results to disk)
  if (/INTO\s+(OUTFILE|DUMPFILE)\b/i.test(trimmed)) return false;

  // Reject multi-statement queries: semicolon followed by more SQL
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) return false;

  return true;
}

/**
 * Escape a CSV field: quote if it contains comma, double-quote, or newline.
 */
function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format query results as CSV.
 */
export function formatResultsAsCsv(columns: string[], rows: string[][]): string {
  const header = columns.map(escapeCsvField).join(",");
  if (rows.length === 0) return header;
  const body = rows.map((row) => row.map(escapeCsvField).join(",")).join("\n");
  return `${header}\n${body}`;
}

/**
 * Format query results as a markdown table.
 */
export function formatResultsAsTable(
  columns: string[],
  rows: string[][],
  totalRows?: number,
): string {
  if (rows.length === 0) return "*No results found.*";

  const escape = (val: string) => val.replace(/\|/g, "\\|");

  const header = `| ${columns.map(escape).join(" | ")} |`;
  const separator = `|${columns.map(() => "---").join("|")}|`;
  const body = rows
    .map((row) => `| ${row.map(escape).join(" | ")} |`)
    .join("\n");

  let table = `${header}\n${separator}\n${body}`;

  if (totalRows !== undefined && totalRows > rows.length) {
    table += `\n*(Showing ${rows.length} of ${totalRows} rows)*`;
  }

  return table;
}

/**
 * Execute a SELECT query against the platform database.
 */
export async function executeQuery(query: string): Promise<QueryResult> {
  try {
    const pool = getPlatformPool();
    const [rows, fields] = await pool.query({ sql: query, timeout: QUERY_TIMEOUT_MS }) as [
      Record<string, unknown>[],
      FieldPacket[],
    ];

    const columns = fields.map((f) => f.name);
    const totalRows = rows.length;
    const truncated = rows.slice(0, MAX_ROWS);

    const stringRows = truncated.map((row) =>
      columns.map((col) => {
        const val = row[col];
        return val === null || val === undefined ? "NULL" : String(val);
      }),
    );

    return {
      columns,
      rows: stringRows,
      ...(totalRows > MAX_ROWS ? { totalRows } : {}),
    };
  } catch (error) {
    log.error("Query execution failed", error);
    return {
      columns: [],
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Process agent response text, executing any sql:execute blocks
 * and replacing them with formatted results.
 */
export async function processResponse(text: string): Promise<string> {
  return (await processResponseWithAttachments(text)).text;
}

export interface SqlAttachment {
  csv: string;
  filename: string;
  query: string;
}

export interface ProcessedResponse {
  text: string;
  attachments: SqlAttachment[];
}

/**
 * Process agent response text, executing sql:execute blocks,
 * replacing them with formatted tables, and collecting CSV attachments.
 */
export async function processResponseWithAttachments(text: string): Promise<ProcessedResponse> {
  const blocks = extractSqlBlocks(text);
  if (blocks.length === 0) return { text, attachments: [] };

  const replacements: string[] = [];
  const attachments: SqlAttachment[] = [];
  const timestamp = Date.now();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let replacement: string;

    if (!isSafeQuery(block.query)) {
      log.warn("Unsafe query rejected", block.query);
      replacement = "_Only SELECT queries are allowed._";
    } else {
      const queryResult = await executeQuery(block.query);
      if (queryResult.error) {
        log.warn("Query execution failed", queryResult.error);
        replacement = "_Query execution failed._";
      } else if (queryResult.rows.length === 0) {
        replacement = "*No results found.*";
      } else {
        replacement = formatResultsAsTable(
          queryResult.columns,
          queryResult.rows,
          queryResult.totalRows,
        );
        attachments.push({
          csv: formatResultsAsCsv(queryResult.columns, queryResult.rows),
          filename: `query-result-${timestamp}-${i + 1}.csv`,
          query: block.query,
        });
      }
    }

    replacements.push(replacement);
  }

  // Replace blocks from last to first to avoid index shifting
  let result = text;
  const regex = new RegExp(SQL_BLOCK_PATTERN, "g");
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match);
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    result = result.slice(0, m.index) + replacements[i] + result.slice(m.index + m[0].length);
  }

  return { text: result, attachments };
}
