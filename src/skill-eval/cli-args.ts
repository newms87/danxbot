/**
 * Shared CLI argument helpers for the skill-eval entry points
 * (`run.ts` single-query CLI, `run-eval-set.ts` eval-set CLI,
 * `run-iterate.ts` iteration loop CLI, `run-all-sweep.ts` --all sweep CLI).
 *
 * Every CLI in this package shares the same `--flag value` / `--flag=value`
 * parsing, the same strict integer validators, and the same common flag
 * surface (worker-port / repo-root / workspace / timeouts / parallel /
 * seed / pricing-model). Centralizing those here keeps the per-CLI
 * parsers small and the defaults in one place — adding a new CLI is
 * "parse common, then parse my unique flags".
 */

import { resolve } from "node:path";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_PARALLEL = 3;
export const DEFAULT_RUNS_PER_QUERY = 3;
export const DEFAULT_SEED = 1;
// Defaults to the same pricing model the existing per-CLI parsers used;
// the dispatched agent's actual model is whatever the host's `~/.claude`
// config defaults to, but we estimate cost with this flag because the
// JSONL doesn't surface a per-message model field at aggregation time.
export const DEFAULT_PRICING_MODEL = "claude-sonnet-4-6";

export function pickArg(argv: readonly string[], name: string): string | null {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

/**
 * Validate that `raw` is a base-10 positive integer with no trailing
 * non-digits. `Number.parseInt("5563abc")` returns `5563` — fine for
 * lenient input, dangerous for a config value the operator typed. The
 * `Number()` cast is intentionally strict.
 *
 * `ErrorCtor` is the error class the caller wants thrown — different
 * CLIs surface their own error class (`RunnerArgsError`,
 * `RunEvalSetArgsError`) so the rejection lands in the matching catch
 * block at the entry point. Default `Error` keeps the helper usable
 * without ceremony from tests.
 */
export function parsePositiveInt(
  name: string,
  raw: string,
  ErrorCtor: new (message: string) => Error = Error,
): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new ErrorCtor(
      `invalid --${name}: must be a positive integer (got "${raw}")`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ErrorCtor(
      `invalid --${name}: must be a positive integer (got "${raw}")`,
    );
  }
  return n;
}

/**
 * Like `parsePositiveInt` but accepts 0. Used for `--seed` (0 is a
 * legal RNG seed) where every other constraint is identical.
 */
export function parseNonNegativeInt(
  name: string,
  raw: string,
  ErrorCtor: new (message: string) => Error = Error,
): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new ErrorCtor(
      `invalid --${name}: must be a non-negative integer (got "${raw}")`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ErrorCtor(
      `invalid --${name}: must be a non-negative integer (got "${raw}")`,
    );
  }
  return n;
}

/**
 * Flag set every skill-eval CLI consumes. Returned by `parseCommonRunFlags`
 * so each entry point pulls its shared values from one place. CLI-unique
 * flags (`--plugin-skill`, `--eval-sets-dir`, `--max-iterations`, etc.)
 * live in the per-CLI parser.
 */
export interface CommonRunFlags {
  readonly workerPort: number;
  readonly repoRoot: string;
  readonly workspace: string;
  readonly repoName: string;
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly parallel: number;
  readonly runsPerQuery: number;
  readonly seed: number;
  readonly pricingModel: string;
}

/**
 * Parse the shared flag surface. Throws the caller's chosen `ErrorCtor`
 * on any rejection so the per-CLI catch block matches the per-CLI error
 * type. Missing `--worker-port` (with no `DANXBOT_WORKER_PORT` env) or
 * missing `--repo-root` (with no `DANXBOT_REPO_ROOT` env) is fatal —
 * both are required for any dispatch.
 */
export function parseCommonRunFlags(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  ErrorCtor: new (message: string) => Error,
): CommonRunFlags {
  const portRaw = pickArg(argv, "worker-port") ?? env.DANXBOT_WORKER_PORT ?? null;
  if (!portRaw) {
    throw new ErrorCtor(
      "missing --worker-port (no DANXBOT_WORKER_PORT env either)",
    );
  }
  const workerPort = parsePositiveInt("worker-port", portRaw, ErrorCtor);

  const repoRoot = pickArg(argv, "repo-root") ?? env.DANXBOT_REPO_ROOT ?? null;
  if (!repoRoot) {
    throw new ErrorCtor(
      "missing --repo-root (no DANXBOT_REPO_ROOT env either)",
    );
  }

  const workspace = pickArg(argv, "workspace") ?? "skill-eval";
  const repoName = pickArg(argv, "repo") ?? "danxbot";
  const workspaceCwd =
    pickArg(argv, "workspace-cwd") ??
    resolve(repoRoot, ".danxbot", "workspaces", workspace);

  const timeoutMs = parsePositiveInt(
    "timeout-ms",
    pickArg(argv, "timeout-ms") ?? `${DEFAULT_TIMEOUT_MS}`,
    ErrorCtor,
  );
  const pollIntervalMs = parsePositiveInt(
    "poll-interval-ms",
    pickArg(argv, "poll-interval-ms") ?? `${DEFAULT_POLL_INTERVAL_MS}`,
    ErrorCtor,
  );
  const parallel = parsePositiveInt(
    "parallel",
    pickArg(argv, "parallel") ?? `${DEFAULT_PARALLEL}`,
    ErrorCtor,
  );
  const runsPerQuery = parsePositiveInt(
    "runs-per-query",
    pickArg(argv, "runs-per-query") ?? `${DEFAULT_RUNS_PER_QUERY}`,
    ErrorCtor,
  );
  const seed = parseNonNegativeInt(
    "seed",
    pickArg(argv, "seed") ?? `${DEFAULT_SEED}`,
    ErrorCtor,
  );
  const pricingModel =
    pickArg(argv, "pricing-model") ?? DEFAULT_PRICING_MODEL;

  return {
    workerPort,
    repoRoot,
    workspace,
    repoName,
    workspaceCwd,
    timeoutMs,
    pollIntervalMs,
    parallel,
    runsPerQuery,
    seed,
    pricingModel,
  };
}

/**
 * Anchor-aware "did node invoke me as the CLI?" check. Pure of process
 * state for testability: tests pass an argv1 directly, runtime callers
 * read `process.argv[1]`. Matches `<scriptBaseName>.ts` or `.js` only
 * when it is a path segment (preceded by `/`, `\`, or start of string)
 * — prevents the false positive where a sibling file `notrun-all-sweep.ts`
 * would have triggered the previous unanchored regex.
 */
export function isInvokedAsScript(
  scriptBaseName: string,
  argv1: string | undefined = typeof process === "undefined"
    ? undefined
    : process.argv[1],
): boolean {
  if (!argv1) return false;
  const escaped = scriptBaseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(?:^|[/\\\\])${escaped}\\.(?:ts|js)$`);
  return regex.test(argv1);
}
