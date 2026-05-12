/**
 * State file for the system cron tick dispatcher — DX-324.
 *
 * Lives at `<repo>/.danxbot/cron-state.json`. Shape:
 * `Record<string, number>` where the key is `CronJob.name` and the
 * value is the millisecond epoch of the last successful run. A
 * missing file is treated as an empty map — every registered job
 * fires unconditionally on the first tick after install.
 *
 * Writes use temp+rename (PID-suffixed temp path) so a crashed
 * writer cannot leave a torn primary file on disk. We do NOT
 * take a lock — overlapping ticks would be last-writer-wins on
 * the merged `state[job.name]` map, losing at most one stamp.
 * That is acceptable: cron's minute cadence makes overlap rare
 * and a lost stamp just causes the affected job to fire once
 * extra on the next tick. The rename guarantees readers never
 * observe a half-written file, NOT that two concurrent writes
 * compose.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type CronTickState = Record<string, number>;

const STATE_FILENAME = "cron-state.json";
const DANXBOT_DIR = ".danxbot";

export function stateFilePath(repoRoot: string): string {
  return join(repoRoot, DANXBOT_DIR, STATE_FILENAME);
}

/**
 * Read the state file. Returns `{}` when the file does not exist —
 * a first-tick install has no prior run history, every job fires.
 * Throws when the file IS present but unparseable: a corrupt state
 * file should fail loud at the next tick rather than silently
 * re-fire every job indefinitely.
 */
export function readState(repoRoot: string): CronTickState {
  const path = stateFilePath(repoRoot);
  if (!existsSync(path)) return {};
  const body = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(
      `cron state file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `cron state file at ${path} must contain a JSON object, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }`,
    );
  }
  return parsed as CronTickState;
}

/**
 * Write the state file atomically. Creates `<repo>/.danxbot/` if
 * absent. Temp path is PID-suffixed; the `try/finally` removes the
 * orphan if `writeFileSync` or `renameSync` throws so a crashed
 * writer does not litter `.tmp` files.
 */
export function writeState(repoRoot: string, state: CronTickState): void {
  const path = stateFilePath(repoRoot);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const body = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; original error is what callers need.
    }
    throw err;
  }
}
