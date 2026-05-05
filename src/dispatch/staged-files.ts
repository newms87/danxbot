/**
 * Staged-files dispatch module.
 *
 * `/api/launch` body field `staged_files: [{path, content}]` lets a caller
 * pre-populate the dispatched agent's filesystem before the agent spawns.
 * This module owns the full lifecycle:
 *
 *   1. `prepareStagedFiles` — validate every entry: shape, placeholder
 *      substitution against the dispatch overlay, allowlist check against
 *      the workspace's `staging-paths` (post-substitution), path-traversal
 *      guard. Pure — no filesystem writes.
 *   2. `writeStagedFiles` — write each prepared entry. On any failure,
 *      removes everything previously written by this call so the caller
 *      sees an all-or-nothing surface, then throws.
 *   3. `cleanupStagedFiles` — remove files written by `writeStagedFiles`.
 *      Idempotent; safely ignores files already gone. NEVER touches files
 *      outside the list it was given.
 *
 * Single source of truth for staging — the dispatch core calls this and
 * never re-implements path validation itself.
 *
 * Design choices:
 *
 * - **Substitution shares the placeholder rules** (`src/workspace/placeholders.ts`).
 *   `${KEY}` references in `staged_files[].path` resolve against the same
 *   overlay map the workspace resolver uses for `.mcp.json` /
 *   `.claude/settings.json`. Unknown placeholders throw — no silent fallback.
 *
 * - **Allowlist check is post-substitution.** Both the path and the
 *   allowlist roots are substituted first, then `path.resolve` normalizes
 *   `..` segments, then the resolved path is checked against each
 *   resolved root. A path containing `..` is not pre-rejected — it's
 *   rejected only when `..` walks the resolved path outside the allowlist.
 *   This keeps the rule "the resolved abs path must live under one of the
 *   resolved allowlist roots" — single, easy to audit.
 *
 * - **Allowlist roots are treated as directories.** A root entry of
 *   `/tmp/schemas/${SCHEMA_DEFINITION_ID}/` allows writes anywhere
 *   under that directory tree. We compare with a trailing-slash boundary
 *   so `/tmp/schemas/42-evil` cannot escape `/tmp/schemas/42/`.
 *
 * - **Empty allowlist rejects any non-empty staged_files.** The workspace
 *   declared no staging surface; reject the body rather than silently
 *   ignoring. Failing closed protects workspaces from accidentally
 *   inheriting a staging contract they didn't opt into.
 *
 * - **Write order is irrelevant; cleanup order is reverse.** If write 3
 *   of 10 fails, we remove writes 1+2 in reverse order before throwing.
 *   Reverse-order cleanup is conventional for nested directory creation
 *   even though `rmSync({force:true})` doesn't strictly need it.
 *
 * - **No directory cleanup.** We remove the FILES we wrote; we don't
 *   remove directories we created. Some workspaces may share a staging
 *   root across dispatches (e.g. `/tmp/schemas/42/` between schema +
 *   template dispatches) and stripping the root because we happened to
 *   be the writer of the only file at that moment would race with
 *   another dispatch's mid-write. Files-only is the conservative
 *   contract.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { substitute } from "../workspace/placeholders.js";

/**
 * `kind` distinguishes caller-fixable errors from worker-side IO failures:
 *
 *   - `"validation"` — bad shape, unknown placeholder, path outside the
 *     workspace allowlist, or an empty `staging-paths` allowlist with a
 *     non-empty `staged_files` payload. HTTP handlers map these to 400.
 *   - `"write"` — every disk-write failure raised by `writeStagedFiles`
 *     after validation already passed. HTTP handlers map these to 500.
 */
export type StagedFilesErrorKind = "validation" | "write";

export class StagedFilesError extends Error {
  readonly kind: StagedFilesErrorKind;

  constructor(kind: StagedFilesErrorKind, message: string) {
    super(message);
    this.name = "StagedFilesError";
    this.kind = kind;
  }
}

/** A single entry from the `/api/launch` body's `staged_files[]` array. */
export interface StagedFileInput {
  readonly path: string;
  readonly content: string;
}

/** Prepared entry — placeholder-substituted, allowlist-checked, ready to write. */
export interface PreparedStagedFile {
  /** Absolute, normalized path on disk. */
  readonly absolutePath: string;
  readonly content: string;
}

export interface PrepareStagedFilesOptions {
  readonly stagedFiles: readonly StagedFileInput[];
  /**
   * Allowlist roots (already placeholder-substituted by the resolver).
   * Empty array forbids any staged file.
   */
  readonly stagingPaths: readonly string[];
  /** Substitution map — same shape the workspace resolver uses. */
  readonly overlay: Readonly<Record<string, string>>;
}

/**
 * Validate body shape — every entry MUST be `{path: string, content: string}`.
 * Caller-supplied; reject loudly so a bad client sees a precise error.
 */
function validateShape(
  stagedFiles: readonly unknown[],
): asserts stagedFiles is readonly StagedFileInput[] {
  stagedFiles.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}] must be an object with {path, content}`,
      );
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.length === 0) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path must be a non-empty string`,
      );
    }
    if (typeof obj.content !== "string") {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].content must be a string`,
      );
    }
  });
}

/**
 * Convert a (possibly placeholder-bearing) allowlist root to a normalized
 * absolute directory prefix ending in the platform separator. The trailing
 * separator is what makes `/tmp/schemas/42/` reject `/tmp/schemas/42-evil`.
 */
function rootBoundary(root: string): string {
  const abs = resolve(root);
  return abs.endsWith(sep) ? abs : abs + sep;
}

export function prepareStagedFiles(
  options: PrepareStagedFilesOptions,
): readonly PreparedStagedFile[] {
  const { stagedFiles, stagingPaths, overlay } = options;
  validateShape(stagedFiles);

  if (stagedFiles.length === 0) return [];

  if (stagingPaths.length === 0) {
    throw new StagedFilesError(
      "validation",
      "workspace declares no staging-paths — cannot accept staged_files",
    );
  }

  const roots = stagingPaths.map((r) => rootBoundary(r));

  return stagedFiles.map((entry, index) => {
    let substituted: string;
    try {
      substituted = substitute(entry.path, overlay);
    } catch (err) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const absolutePath = resolve(substituted);
    const inside = roots.some(
      (root) =>
        absolutePath === root.slice(0, -sep.length) ||
        absolutePath.startsWith(root),
    );
    if (!inside) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path "${substituted}" resolves to "${absolutePath}" which is outside the workspace allowlist (${stagingPaths.join(", ")})`,
      );
    }

    return { absolutePath, content: entry.content };
  });
}

/**
 * Write every prepared entry to disk. On any write failure, removes every
 * file written by this call (in reverse order) before re-throwing the
 * StagedFilesError so the caller sees an all-or-nothing outcome.
 *
 * Returns the list of absolute paths written — caller stores these for
 * post-dispatch cleanup via `cleanupStagedFiles`.
 */
export function writeStagedFiles(
  prepared: readonly PreparedStagedFile[],
): string[] {
  const written: string[] = [];
  try {
    for (const entry of prepared) {
      mkdirSync(dirname(entry.absolutePath), { recursive: true });
      writeFileSync(entry.absolutePath, entry.content);
      written.push(entry.absolutePath);
    }
    return written;
  } catch (err) {
    // Roll back every file written so far. Cleanup must not throw — a
    // double-failure here would mask the original write error.
    for (const path of [...written].reverse()) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Intentionally swallow — see comment above.
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new StagedFilesError(
      "write",
      `failed to write staged file: ${detail}`,
    );
  }
}

/**
 * Remove every path the worker staged. Idempotent — files already gone
 * are silently skipped (rmSync force:true). NEVER touches anything not
 * in the supplied list.
 */
export function cleanupStagedFiles(paths: readonly string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort cleanup; never throw from teardown.
    }
  }
}
