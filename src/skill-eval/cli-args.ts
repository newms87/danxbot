/**
 * Shared CLI argument helpers for the skill-eval entry points
 * (`run.ts` single-query CLI + `run-eval-set.ts` eval-set CLI).
 *
 * Both CLIs need the same `--flag value` / `--flag=value` parsing and
 * the same strict positive-integer validator; putting the helpers in
 * either entry point creates a CLI-imports-CLI smell. Sibling module
 * keeps each CLI a pure entry point.
 */

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

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
