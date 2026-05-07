/**
 * Staged-files dispatch module.
 *
 * `/api/launch` body field `staged_files[]` lets a caller pre-populate the
 * dispatched agent's filesystem before the agent spawns. Two entry shapes
 * are accepted:
 *
 *   - `{path, content}` — inline content. Caller already has the bytes
 *     in hand and just wants them written to disk. Used for small JSON
 *     manifests, schema bodies, etc.
 *   - `{path, source_url, headers?}` — URL reference. Worker streams the
 *     URL to disk during the staging phase. Used for binary blobs (images,
 *     PDFs) so the bytes never travel through the dispatch HTTP body —
 *     the backend ships a tiny URL, the worker fetches once, the agent
 *     reads the file natively (e.g. Claude Code's multimodal Read tool
 *     decodes images directly off disk).
 *
 * Lifecycle:
 *
 *   1. `prepareStagedFiles` — validate every entry: shape (which of the
 *      two variants it is, required fields per variant), placeholder
 *      substitution against the dispatch overlay, allowlist check
 *      against the workspace's `staging-paths` (post-substitution),
 *      path-traversal guard. Pure — no filesystem writes, no network.
 *   2. `writeStagedFiles` (async) — write each prepared entry. Inline
 *      `content` entries write straight to disk. `source_url` entries
 *      fetch the URL (with optional headers) and stream the body to
 *      disk. On any failure, removes everything previously written by
 *      this call so the caller sees an all-or-nothing surface, then
 *      throws.
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
 *   Header values also support `${KEY}` substitution so callers can ship
 *   `Authorization: Bearer ${SCHEMA_API_TOKEN}` without hard-coding the
 *   token in the request body. `source_url` itself supports `${KEY}` for
 *   the same reason.
 *
 * - **Allowlist check is post-substitution.** Both the path and the
 *   allowlist roots are substituted first, then `path.resolve` normalizes
 *   `..` segments, then the resolved path is checked against each
 *   resolved root. A path containing `..` is not pre-rejected — it's
 *   rejected only when `..` walks the resolved path outside the allowlist.
 *
 * - **Allowlist roots are treated as directories.** A root entry of
 *   `/tmp/schemas/${SCHEMA_DEFINITION_ID}/` allows writes anywhere
 *   under that directory tree.
 *
 * - **Empty allowlist rejects any non-empty staged_files.** The workspace
 *   declared no staging surface; reject the body rather than silently
 *   ignoring.
 *
 * - **Source URL fetches happen serially during writeStagedFiles.** Each
 *   fetch failure (non-2xx, network error, body read error) maps to a
 *   "write"-kind StagedFilesError so the HTTP handler returns 500. The
 *   all-or-nothing rollback removes every file already on disk before
 *   re-throwing, regardless of variant.
 *
 * - **No directory cleanup.** We remove the FILES we wrote; we don't
 *   remove directories we created.
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
 *   - `"write"` — every disk-write or fetch failure raised by
 *     `writeStagedFiles` after validation already passed. HTTP handlers
 *     map these to 500.
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

/** Inline-content entry: caller ships the bytes directly in the request body. */
export interface StagedFileContentInput {
  readonly path: string;
  readonly content: string;
}

/**
 * URL-reference entry: caller ships a URL (and optional auth headers) and the
 * worker streams the body to disk. Lets large binary blobs skip the dispatch
 * HTTP body entirely — backend payload stays small, bytes move once
 * (storage → worker).
 */
export interface StagedFileSourceUrlInput {
  readonly path: string;
  readonly source_url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type StagedFileInput = StagedFileContentInput | StagedFileSourceUrlInput;

/** Prepared content entry — placeholder-substituted, allowlist-checked, ready to write. */
export interface PreparedContentEntry {
  readonly kind: "content";
  /** Absolute, normalized path on disk. */
  readonly absolutePath: string;
  readonly content: string;
}

/** Prepared URL entry — placeholder-substituted, allowlist-checked, ready to fetch. */
export interface PreparedSourceUrlEntry {
  readonly kind: "source_url";
  /** Absolute, normalized path on disk. */
  readonly absolutePath: string;
  readonly sourceUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type PreparedStagedFile = PreparedContentEntry | PreparedSourceUrlEntry;

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

function isContentEntry(
  entry: Record<string, unknown>,
): entry is StagedFileContentInput & Record<string, unknown> {
  return typeof entry.content === "string";
}

function isSourceUrlEntry(
  entry: Record<string, unknown>,
): entry is StagedFileSourceUrlInput & Record<string, unknown> {
  return typeof entry.source_url === "string";
}

/**
 * Validate body shape — every entry MUST be either
 * `{path: string, content: string}` or
 * `{path: string, source_url: string, headers?: {[k]: string}}`. Reject
 * loudly so a bad client sees a precise error. Exported as
 * {@link validateStagedFilesShape} so the HTTP-layer worker can short-
 * circuit obviously-malformed requests before dispatch starts (single
 * source of truth — both pre-dispatch validation and prepareStagedFiles
 * call into the same logic).
 */
export function validateStagedFilesShape(
  stagedFiles: readonly unknown[],
): asserts stagedFiles is readonly StagedFileInput[] {
  return validateShape(stagedFiles);
}

function validateShape(
  stagedFiles: readonly unknown[],
): asserts stagedFiles is readonly StagedFileInput[] {
  stagedFiles.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}] must be an object with {path, content} or {path, source_url}`,
      );
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.length === 0) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path must be a non-empty string`,
      );
    }

    const hasContent = "content" in obj;
    const hasSourceUrl = "source_url" in obj;

    if (hasContent && hasSourceUrl) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}] must provide either content or source_url, not both`,
      );
    }

    if (!hasContent && !hasSourceUrl) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}] must provide either content (string) or source_url (string)`,
      );
    }

    if (hasContent && typeof obj.content !== "string") {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].content must be a string`,
      );
    }

    if (hasSourceUrl) {
      if (typeof obj.source_url !== "string" || obj.source_url.length === 0) {
        throw new StagedFilesError(
          "validation",
          `staged_files[${index}].source_url must be a non-empty string`,
        );
      }
      if ("headers" in obj && obj.headers !== undefined) {
        const headers = obj.headers;
        if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
          throw new StagedFilesError(
            "validation",
            `staged_files[${index}].headers must be an object of string values`,
          );
        }
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value !== "string") {
            throw new StagedFilesError(
              "validation",
              `staged_files[${index}].headers["${name}"] must be a string`,
            );
          }
        }
      }
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

function substituteHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>>,
  index: number,
): Readonly<Record<string, string>> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    try {
      out[name] = substitute(value, overlay);
    } catch (err) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].headers["${name}"]: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
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
    let substitutedPath: string;
    try {
      substitutedPath = substitute(entry.path, overlay);
    } catch (err) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const absolutePath = resolve(substitutedPath);
    const inside = roots.some(
      (root) =>
        absolutePath === root.slice(0, -sep.length) ||
        absolutePath.startsWith(root),
    );
    if (!inside) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].path "${substitutedPath}" resolves to "${absolutePath}" which is outside the workspace allowlist (${stagingPaths.join(", ")})`,
      );
    }

    const obj = entry as unknown as Record<string, unknown>;
    if (isContentEntry(obj)) {
      return {
        kind: "content" as const,
        absolutePath,
        content: obj.content,
      };
    }

    // source_url variant — substitute placeholders in URL + headers too.
    if (!isSourceUrlEntry(obj)) {
      // Defensive — validateShape should have caught this.
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}] must provide either content or source_url`,
      );
    }
    let substitutedUrl: string;
    try {
      substitutedUrl = substitute(obj.source_url, overlay);
    } catch (err) {
      throw new StagedFilesError(
        "validation",
        `staged_files[${index}].source_url: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const substitutedHeaders = substituteHeaders(obj.headers, overlay, index);

    return {
      kind: "source_url" as const,
      absolutePath,
      sourceUrl: substitutedUrl,
      headers: substitutedHeaders,
    };
  });
}

async function fetchToBuffer(entry: PreparedSourceUrlEntry): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(entry.sourceUrl, {
      headers: entry.headers as Record<string, string> | undefined,
    });
  } catch (err) {
    throw new StagedFilesError(
      "write",
      `failed to fetch staged file source_url "${entry.sourceUrl}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!response.ok) {
    throw new StagedFilesError(
      "write",
      `staged file source_url "${entry.sourceUrl}" returned HTTP ${response.status} ${response.statusText}`,
    );
  }

  try {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    throw new StagedFilesError(
      "write",
      `failed to read body from staged file source_url "${entry.sourceUrl}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Write every prepared entry to disk. On any write failure, removes every
 * file written by this call (in reverse order) before re-throwing the
 * StagedFilesError so the caller sees an all-or-nothing outcome.
 *
 * Returns the list of absolute paths written — caller stores these for
 * post-dispatch cleanup via `cleanupStagedFiles`.
 *
 * Async because `source_url` entries fetch the URL during this phase.
 * Inline `content` entries do not need network — the await is a no-op for
 * those. Content + URL entries are processed in input order.
 */
export async function writeStagedFiles(
  prepared: readonly PreparedStagedFile[],
): Promise<string[]> {
  const written: string[] = [];
  try {
    for (const entry of prepared) {
      mkdirSync(dirname(entry.absolutePath), { recursive: true });
      if (entry.kind === "content") {
        writeFileSync(entry.absolutePath, entry.content);
      } else {
        const buffer = await fetchToBuffer(entry);
        writeFileSync(entry.absolutePath, buffer);
      }
      written.push(entry.absolutePath);
    }
    return written;
  } catch (err) {
    // Roll back every file written so far. Cleanup must not throw — a
    // double-failure here would mask the original write/fetch error.
    for (const path of [...written].reverse()) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Intentionally swallow — see comment above.
      }
    }
    if (err instanceof StagedFilesError) {
      throw err;
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
