/**
 * Shared CLI argument helpers for the skill-eval entry points
 * (`run.ts` single-query CLI, `run-eval-set.ts` eval-set CLI,
 * `run-iterate.ts` iteration loop CLI, `run-all-sweep.ts` --all sweep CLI).
 *
 * Every CLI in this package shares the same `--flag value` / `--flag=value`
 * parsing, the same strict integer validators, and the same common flag
 * surface (repo-root / workspace / timeouts / parallel / seed /
 * pricing-model). Centralizing those here keeps the per-CLI parsers
 * small and the defaults in one place — adding a new CLI is "parse
 * common, then parse my unique flags".
 *
 * Probe transport is direct `claude -p` spawn (see `probe.ts`); there
 * is no worker port or repo-name in the common flag set anymore.
 */

import { resolve } from "node:path";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
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
 * Reject any `--unknown-flag` not in the per-CLI allowlist. Each entry
 * runner declares the union of common + CLI-specific flags it accepts;
 * a typo (e.g. `--eval-set-dir` for `--eval-sets-dir`) silently fell
 * through to a default value before — operator surprise, masked
 * misconfigs. The check runs after `pickArg` consumes every value, so
 * a flag value like `--workspace skill-eval` does not get mistaken for
 * an unknown flag.
 *
 * Bare positional args (anything not starting with `--`) are passed
 * through untouched; positional handling stays in the per-CLI parser
 * (e.g. plugin:skill).
 */
export function validateKnownFlags(
  argv: readonly string[],
  knownFlags: readonly string[],
  ErrorCtor: new (message: string) => Error,
): void {
  const known = new Set(knownFlags);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const equalsIdx = tok.indexOf("=");
    const name = (equalsIdx === -1 ? tok : tok.slice(0, equalsIdx)).slice(2);
    if (!known.has(name)) {
      throw new ErrorCtor(
        `unknown flag --${name} — expected one of: ${Array.from(known).sort().map((n) => `--${n}`).join(", ")}`,
      );
    }
    if (equalsIdx === -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      i++;
    }
  }
}

/**
 * Shared flag names every CLI consumes via `parseCommonRunFlags`. Used
 * by each per-CLI parser to seed its `validateKnownFlags` allowlist —
 * the per-CLI parser concatenates this list with its own unique flag
 * names so a typo on either surface gets caught loudly.
 */
export const COMMON_KNOWN_FLAGS = [
  "repo-root",
  "workspace",
  "workspace-cwd",
  "timeout-ms",
  "parallel",
  "runs-per-query",
  "seed",
  "pricing-model",
] as const;

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
  readonly repoRoot: string;
  readonly workspace: string;
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
  readonly parallel: number;
  readonly runsPerQuery: number;
  readonly seed: number;
  readonly pricingModel: string;
}

/**
 * Parse the shared flag surface. Throws the caller's chosen `ErrorCtor`
 * on any rejection so the per-CLI catch block matches the per-CLI error
 * type. Missing `--repo-root` (with no `DANXBOT_REPO_ROOT` env) is
 * fatal — the workspace cwd cannot be derived without it.
 */
export function parseCommonRunFlags(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  ErrorCtor: new (message: string) => Error,
): CommonRunFlags {
  const repoRoot = pickArg(argv, "repo-root") ?? env.DANXBOT_REPO_ROOT ?? null;
  if (!repoRoot) {
    throw new ErrorCtor(
      "missing --repo-root (no DANXBOT_REPO_ROOT env either)",
    );
  }

  const workspace = pickArg(argv, "workspace") ?? "skill-eval";
  const workspaceCwd =
    pickArg(argv, "workspace-cwd") ??
    resolve(repoRoot, ".danxbot", "workspaces", workspace);

  const timeoutMs = parsePositiveInt(
    "timeout-ms",
    pickArg(argv, "timeout-ms") ?? `${DEFAULT_TIMEOUT_MS}`,
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
    repoRoot,
    workspace,
    workspaceCwd,
    timeoutMs,
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
