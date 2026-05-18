/**
 * Schema-version constants — extracted out of `yaml.ts` so the
 * migration registry (`migrations/registry.ts`) can import them
 * without creating a cycle (yaml.ts → registry.ts → yaml.ts).
 *
 * Maintenance contract + drift-class header lives on the re-exports
 * in `yaml.ts` — read that header before bumping. Two-line summary:
 *   - `KNOWN_SCHEMA_MIN === KNOWN_SCHEMA_MAX - 1` (single-version
 *     tolerance; the validator only accepts the canonical version and
 *     its immediate predecessor). Pinned by a unit test in
 *     `migrations/registry.test.ts`.
 *   - Bumping either constant requires bumping the writer literals in
 *     `yaml.ts` AND publishing `@thehammer/danx-issue-mcp` in the
 *     SAME commit (see `<repo>/CLAUDE.md` § danx-issue-mcp lockstep).
 */
export const KNOWN_SCHEMA_MIN = 11;
export const KNOWN_SCHEMA_MAX = 12;
