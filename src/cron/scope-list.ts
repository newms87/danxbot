/**
 * Dispatch-scope enumeration helper — DX-327.
 *
 * The Phase 4 reaper joins live systemd transient scope units
 * (`danxbot-dispatch-<id>.scope`, created by `buildSystemdRunArgs` in
 * `src/agent/scope.ts`) against the `dispatches` Postgres table to
 * detect orphans whose worker died uncleanly before `job.stop` could
 * call `systemctl --user stop`. This module isolates the parsing +
 * shelling-out side from the cron job body so the parsers are pure +
 * unit-testable, and the job stays a thin orchestrator.
 *
 * Two systemctl calls per tick:
 *   1. `list-units --all --output=json --type=scope 'danxbot-dispatch-*.scope'`
 *      → JSON array of {unit, load, active, sub, description, ...}.
 *      The glob narrows the result to our scopes; `--all` keeps inactive
 *      units in the listing so the parser surfaces "scope was active but
 *      systemctl marked it inactive after stop" mid-tick edge cases.
 *   2. `show --property=Id,ActiveEnterTimestamp <unit ...>` → key=value
 *      blocks separated by blank lines, one block per unit. The
 *      `Id` field is the canonical unit name (systemctl normalizes
 *      aliases), and `ActiveEnterTimestamp` is the epoch the scope
 *      entered the active state — used downstream for the 60s race-
 *      window guard.
 *
 * The exec dependency is injected (`opts.exec`) so unit tests can
 * stub it without touching the real systemd. Tests live in
 * `scope-list.test.ts` next door.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SCOPE_PREFIX = "danxbot-dispatch-";
const SCOPE_SUFFIX = ".scope";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
) => Promise<ExecResult>;

const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, [...args]);
  return { stdout, stderr };
};

export interface DispatchScopeUnit {
  /** Canonical unit name as `systemctl show` reports it (`Id=`). */
  readonly unit: string;
  /** UUID parsed from the unit name — matches `dispatches.id`. */
  readonly dispatchId: string;
  /** Epoch ms the scope entered the active state. */
  readonly activeEnterEpochMs: number;
}

/**
 * Extract the dispatch id from a scope unit name. Returns null for any
 * input that doesn't match the canonical `danxbot-dispatch-<id>.scope`
 * shape — defense-in-depth in case the list-units glob ever matches
 * something unexpected, or a future renaming leaves stale units.
 */
export function parseDispatchIdFromUnitName(unit: string): string | null {
  if (!unit.startsWith(SCOPE_PREFIX)) return null;
  if (!unit.endsWith(SCOPE_SUFFIX)) return null;
  const id = unit.slice(SCOPE_PREFIX.length, unit.length - SCOPE_SUFFIX.length);
  if (id.length === 0) return null;
  return id;
}

/**
 * Parse `systemctl --user list-units --output=json` output and return
 * only the entries whose unit name matches the canonical danxbot
 * dispatch-scope shape. Non-string `unit` fields are silently dropped
 * (systemctl shouldn't emit them, but the JSON shape isn't pinned by
 * a public schema — be conservative).
 */
export function parseListUnitsJson(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `scope-list: expected systemctl list-units --output=json root to be an array, got ${typeof parsed}`,
    );
  }
  const units: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const unit = (entry as Record<string, unknown>).unit;
    if (typeof unit !== "string") continue;
    if (parseDispatchIdFromUnitName(unit) === null) continue;
    units.push(unit);
  }
  return units;
}

/**
 * Parse `systemctl show --property=Id,ActiveEnterTimestamp <unit ...>`
 * output and return a Map of `Id` → epoch ms. Blocks whose timestamp
 * is empty (scope not yet active, or already cleaned up) are dropped
 * from the result — callers treat missing entries as "skip this
 * scope" rather than "treat as age=0".
 */
export function parseShowActiveEnterTimestamps(
  showOutput: string,
): Map<string, number> {
  const result = new Map<string, number>();
  const blocks = showOutput.split(/\n\n+/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    let unit: string | null = null;
    let epochMs: number | null = null;
    for (const line of trimmed.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if (key === "Id") {
        unit = value;
      } else if (key === "ActiveEnterTimestamp") {
        if (value === "") continue;
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) epochMs = parsed;
      }
    }
    if (unit !== null && epochMs !== null) result.set(unit, epochMs);
  }
  return result;
}

export interface ListDispatchScopesOptions {
  readonly exec?: ExecFn;
}

/**
 * Enumerate every live danxbot dispatch scope unit + its
 * ActiveEnterTimestamp. Skips the show call entirely when the list
 * call returned no matches — keeps the cron tick a no-op when no
 * dispatches are in flight.
 */
export async function listDispatchScopes(
  opts: ListDispatchScopesOptions = {},
): Promise<DispatchScopeUnit[]> {
  const exec = opts.exec ?? defaultExec;

  const listResult = await exec("systemctl", [
    "--user",
    "list-units",
    "--all",
    "--output=json",
    "--type=scope",
    "danxbot-dispatch-*.scope",
  ]);
  const units = parseListUnitsJson(listResult.stdout);
  if (units.length === 0) return [];

  const showResult = await exec("systemctl", [
    "--user",
    "show",
    "--property=Id,ActiveEnterTimestamp",
    ...units,
  ]);
  const timestamps = parseShowActiveEnterTimestamps(showResult.stdout);

  const result: DispatchScopeUnit[] = [];
  for (const unit of units) {
    const dispatchId = parseDispatchIdFromUnitName(unit);
    if (dispatchId === null) continue;
    const activeEnterEpochMs = timestamps.get(unit);
    if (activeEnterEpochMs === undefined) continue;
    result.push({ unit, dispatchId, activeEnterEpochMs });
  }
  return result;
}
