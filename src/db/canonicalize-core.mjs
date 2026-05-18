/**
 * DX-635 — pure canonical-hash core, shared between the sync helper
 * (`src/db/canonicalize.ts`) and the worker_threads task
 * (`src/threadpool/tasks/canonical-hash.mjs`).
 *
 * `.mjs` (not `.ts`) so worker_threads load it natively — tsx's ESM
 * loader explicitly skips registration when `isMainThread` is false
 * (see `node_modules/tsx/dist/esm/index.mjs`). Keeping the logic in
 * one `.mjs` file eliminates the prior duplication between the
 * canonicalize sync helper and the task module.
 *
 * Top-level Issue keys excluded from the canonical hash:
 * - `db_updated_at` (DX-547 Phase 2): the writer stamps this on every
 *   save. Including it would mean every re-save of identical content
 *   produces a new history row.
 */

import { createHash } from "node:crypto";

const HASH_EXCLUDED_TOP_KEYS = new Set(["db_updated_at"]);

function canonicalizeValue(value, isTopLevel = false) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => canonicalizeValue(v));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (isTopLevel && HASH_EXCLUDED_TOP_KEYS.has(key)) continue;
      out[key] = canonicalizeValue(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(canonicalizeValue(value, true));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function hashCanonical(value) {
  return sha256(canonicalize(value));
}
