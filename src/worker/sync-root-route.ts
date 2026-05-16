/**
 * DX-558 — operator-driven retry for the root-clone sync. The Vue
 * banner's "Retry now" button calls the dashboard's
 * `POST /api/sync-root/:repo`, which proxies to this worker route.
 *
 * Idempotent — calling repeatedly is safe. Returns the post-sync state
 * verbatim so the SPA could project optimistically; in practice the
 * SSE feed re-asserts the same state via the state-file chokidar
 * pass, which is good enough.
 *
 * No body parsing — the operator's repo identity is already encoded
 * in the worker's per-repo `RepoContext`, and the only operation is
 * "kick the sync now."
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { syncRepoRoot, type SyncRepoRootResult } from "./sync-root.js";
import { createLogger } from "../logger.js";
import type { RepoContext } from "../types.js";

const log = createLogger("sync-root-route");

export async function handleSyncRootRetry(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
  try {
    const result: SyncRepoRootResult = await syncRepoRoot({
      repoName: repo.name,
      repoLocalPath: repo.localPath,
    });
    log.info(`[${repo.name}] Manual sync-root retry → status=${result.status}`);
    json(res, 200, result);
  } catch (err) {
    // `syncRepoRoot` is documented as never-throws; if we reach here,
    // it is a bug worth surfacing rather than swallowing.
    log.error(`[${repo.name}] Manual sync-root retry threw unexpectedly`, err);
    json(res, 500, {
      error:
        err instanceof Error ? err.message : "sync-root retry failed",
    });
  }
}
