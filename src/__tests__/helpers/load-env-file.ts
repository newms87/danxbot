/**
 * Hand-rolled `.env` loader for vitest setup files.
 *
 * Why not `process.loadEnvFile()`? Available only in Node 20.12+. The
 * host where dispatched agents run vitest is Node 18.19.x, which lacks
 * the API and would crash on import. Why not `dotenv` (the npm
 * package)? Adds a dependency for ~30 lines of parsing the project
 * already has the budget to write directly.
 *
 * Format supported (matches Node's `--env-file` minimalism, NOT
 * dotenv-cli's inline-comment stripping):
 *
 *   - `KEY=VALUE` — assigns `VALUE` to `KEY`
 *   - `KEY="..."` / `KEY='...'` — strips matching surrounding quotes
 *   - `KEY=` — assigns the empty string
 *   - `KEY=a=b=c` — only the FIRST `=` separates; rest is value
 *   - `# comment` / blank lines — ignored
 *   - inline `#` — preserved as part of the value (URLs, tokens, etc.)
 *
 * Multi-line values, escaped sequences, and `${VAR}` interpolation are
 * intentionally NOT supported — keep the parser small and the failure
 * mode obvious. The danxbot `.env` is operator-curated and uses simple
 * scalar values throughout.
 *
 * Idempotency: the loader does NOT override values already present in
 * `process.env`. Operators (and CI) can shell-export a key to override
 * the file without rewriting it. Re-running the loader on the same
 * file is a no-op.
 *
 * Failure mode: a missing file is a silent no-op (CI / fresh clones
 * have no `.env`). Any other I/O error throws — that's a real bug.
 */

import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
