/**
 * Browser-safe slice of the sync-root contract: types + payload guard
 * used by both the worker (Node) and the dashboard SPA (Vite). Kept
 * separate from `sync-root.ts` so the SPA's runtime import of
 * `isRepoRootSyncError` does not pull `node:fs` into the browser
 * bundle and crash with the externalized-module error.
 */

export type RepoRootSyncReason = "dirty" | "rebase-conflict";

export interface RepoRootSyncError {
  reason: RepoRootSyncReason;
  detail: string;
  since: string;
  lastTriedAt: string;
}

export function isRepoRootSyncError(v: unknown): v is RepoRootSyncError {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.reason === "dirty" || r.reason === "rebase-conflict") &&
    typeof r.detail === "string" &&
    typeof r.since === "string" &&
    typeof r.lastTriedAt === "string"
  );
}
