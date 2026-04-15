import { getPool } from "./connection.js";

const DB_PING_TIMEOUT_MS = 2000;

/**
 * Check if the database is reachable by executing a simple query with a timeout.
 * Returns true if the DB responds within DB_PING_TIMEOUT_MS, false otherwise.
 */
export async function checkDbConnection(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const pool = getPool();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DB ping timeout")), DB_PING_TIMEOUT_MS);
    });
    await Promise.race([pool.query("SELECT 1"), timeoutPromise]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
