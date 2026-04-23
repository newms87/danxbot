/**
 * `make reset-data` CLI — wipes operational data tables (dispatches,
 * threads, events, health_check) while leaving users + api_tokens
 * untouched. Typically invoked via `make reset-data LOCALHOST=1`, which
 * runs this file inside the dashboard container via `docker exec`; the
 * script itself works anywhere the dashboard DB env vars are set.
 *
 * Matches the shape of `create-user.ts`: pure `runCli` for test
 * injection, shell-entry guard at the bottom.
 *
 * Scope is intentionally local-only — there is no `TARGET=<remote>`
 * branch on the Makefile side. Production data is not something we
 * want wiped by a one-liner.
 */

import { closePool } from "../db/connection.js";
import { resetAllData } from "../dashboard/reset-data.js";

export async function runCli(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  try {
    const result = await resetAllData();
    stdout.write(
      `Reset complete. ${result.rowsDeleted} row(s) deleted across ${result.tablesCleared.length} table(s):\n`,
    );
    for (const table of result.tablesCleared) {
      const count = result.perTable[table] ?? 0;
      stdout.write(`  ${table.padEnd(20)} ${count}\n`);
    }
    return 0;
  } catch (err) {
    stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.stdout, process.stderr)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
