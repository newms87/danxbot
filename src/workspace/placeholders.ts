/**
 * Placeholder substitution — pure string machinery that turns `${KEY}`
 * references inside workspace files (`.mcp.json`, `.claude/settings.json`)
 * into real values supplied by the dispatch `overlay`.
 *
 * The resolver builds a single substitution map per dispatch (caller-
 * supplied overlay + optional-placeholder defaults merged into one
 * table) and hands it here. Every substitution goes through `substitute`;
 * every caller-overlay goes through `validateOverlay` before the
 * substitution map is built. Neither falls back silently on required
 * placeholders — missing required values throw loud. Silent fallbacks
 * would hide misconfigured workspaces until they produced corrupt MCP
 * configs at runtime.
 *
 * ## Required vs optional placeholders
 *
 * A manifest declares two placeholder groups:
 *
 *   - `required-placeholders` — MUST appear in overlay with a non-empty
 *     string value. `validateOverlay` enforces this.
 *   - `optional-placeholders` — MAY be omitted from overlay. If absent,
 *     `buildSubstitutionMap` inserts them with value `""` so files that
 *     reference `${OPTIONAL_KEY}` substitute to an empty string rather
 *     than throwing `PlaceholderError`. This is the documented semantics
 *     of "optional," not a silent fallback: the manifest explicitly
 *     opted into defaults-to-empty for these keys.
 *
 * A `${KEY}` reference in a workspace file that is NOT declared in
 * either group (or supplied by overlay) always throws — workspaces
 * cannot reference undeclared placeholders.
 *
 * ## Substitution rules
 *
 *   - `substitute` does NOT recurse. A placeholder that resolves to a
 *     string containing `${...}` stays as the literal text — overlays
 *     are data, not macros. This keeps the substitution total and
 *     eliminates an infinite-recursion risk from mutually referential
 *     overlay entries.
 *   - Malformed syntax (`$FOO`, `${FOO` without close brace) is left
 *     untouched. Only well-formed `${KEY}` patterns are replaced. This
 *     matches what callers visually expect and means a typo in a
 *     workspace file stays visible rather than being silently
 *     interpreted as "no placeholder."
 *   - Placeholder keys must start with a letter or underscore and
 *     contain only letters, digits, and underscores. `${1FOO}` is NOT a
 *     placeholder (matches shell env-var conventions).
 *   - Empty-string values substitute cleanly (see optional-placeholder
 *     semantics above). `validateOverlay` rejects empty strings for
 *     required placeholders — empty is "absent" at the validation
 *     boundary.
 */

import type { WorkspaceManifest } from "./manifest.js";

export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderError";
  }
}

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function substitute(
  content: string,
  overlay: Readonly<Record<string, string>>,
): string {
  return content.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in overlay)) {
      const known = Object.keys(overlay);
      throw new PlaceholderError(
        `unknown placeholder \${${key}} — known keys: ${known.length ? known.join(", ") : "(none)"}`,
      );
    }
    return overlay[key];
  });
}

export function validateOverlay(
  manifest: WorkspaceManifest,
  overlay: Readonly<Record<string, string>>,
): void {
  const missing: string[] = [];
  for (const key of manifest.requiredPlaceholders) {
    const value = overlay[key];
    if (typeof value !== "string" || value.length === 0) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new PlaceholderError(
      `workspace "${manifest.name}" missing required placeholder(s): ${missing.join(", ")}`,
    );
  }
}

/**
 * Build the substitution map handed to `substitute` for each of the
 * workspace's template files. Starts with the caller's overlay and
 * pre-fills every declared optional-placeholder with `""` when absent
 * — the documented default for optional keys. Required placeholders
 * are not touched here; `validateOverlay` must run first and will
 * throw if any are missing.
 *
 * The returned map is a fresh object; mutating the overlay afterwards
 * does not affect substitution.
 */
export function buildSubstitutionMap(
  manifest: WorkspaceManifest,
  overlay: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { ...overlay };
  for (const key of manifest.optionalPlaceholders) {
    if (!(key in out)) out[key] = "";
  }
  return out;
}
