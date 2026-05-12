/**
 * Shared infrastructure for the inject pipeline.
 *
 * After DX-319 split the pipeline across `sync.ts`, `workspaces.ts`,
 * `per-repo-render.ts`, and `scrubs.ts`, three module-level constants
 * + one helper had to live in every consumer (`projectRoot`, `injectDir`,
 * `log`, `chmodExecutable`). Triplicated `projectRoot` carries non-
 * trivial semantics (the danxbot install root — typo'd `..` count is a
 * silent bug) and the chmod helper is a drift surface; centralizing
 * them here mirrors the existing `src/inject/_shared/hooks/` convention
 * for cross-inject-module shared assets.
 */

import { chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../logger.js";

/** Danxbot install root — three `..`-pops past `src/inject/_shared/`. */
export const projectRoot: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** `src/inject/` — one `..`-pop past `src/inject/_shared/`. */
export const injectDir: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const log = createLogger("inject");

export function chmodExecutable(path: string): void {
  try {
    chmodSync(path, 0o755);
  } catch (e) {
    log.warn(`Failed to chmod ${path}:`, e);
  }
}
