/**
 * SG-189 — dispatch-side glue for the template-hmr module.
 *
 * `dispatch/core.ts` calls `startTemplateHmrForDispatch` once after spawn
 * succeeds (inside `runResolved`'s onComplete chain wiring) and
 * `stopTemplateHmrForDispatch` once on dispatch terminal. Both calls are
 * best-effort — HMR is a developer affordance, not a dispatch-critical
 * path. A spawn failure logs + continues; the dispatch itself proceeds
 * regardless. Same for stop — releaseAllForDispatch silently no-ops on
 * a dispatch that never started any entries.
 */

import { createLogger } from "../logger.js";
import {
  acquireHmrServer,
  releaseAllForDispatch,
  type AcquireOverrides,
  type HmrServerInfo,
} from "./server.js";
import { extractTemplateIds } from "./extract-template-ids.js";

const log = createLogger("template-hmr-lifecycle");

export interface StartLifecycleOptions {
  dispatchId: string;
  stagedFilePaths: readonly string[];
  /** Test injection — passed through to every per-template acquire call. */
  acquireOverrides?: AcquireOverrides;
}

/**
 * For each template referenced in the dispatch's staged paths, acquire
 * (start-or-bump-ref) a Vite dev-server. Returns the list of started/bumped
 * entries — callers can ignore the return value; nothing in the dispatch
 * path depends on it. Failures are logged + swallowed; dispatch continues.
 */
export async function startTemplateHmrForDispatch(
  opts: StartLifecycleOptions,
): Promise<HmrServerInfo[]> {
  const templates = extractTemplateIds(opts.stagedFilePaths);
  if (templates.length === 0) return [];

  const started: HmrServerInfo[] = [];
  for (const t of templates) {
    try {
      const info = await acquireHmrServer({
        templateId: t.templateId,
        sourceDir: t.sourceDir,
        dispatchId: opts.dispatchId,
        ...opts.acquireOverrides,
      });
      started.push(info);
      log.info(
        `[dispatch ${opts.dispatchId}] HMR ready for template ${t.templateId} at ${info.url}`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(
        `[dispatch ${opts.dispatchId}] HMR start failed for template ${t.templateId}: ${reason}`,
      );
    }
  }
  return started;
}

/**
 * On dispatch terminal, drop every HMR entry this dispatch was holding
 * open. `releaseAllForDispatch` is idempotent — safe to call from the
 * spawn-failure path AND the onComplete chain for the same dispatch
 * without double-killing children. No error path: the underlying
 * release loop already swallows per-entry rm failures with debug logs.
 */
export async function stopTemplateHmrForDispatch(
  dispatchId: string,
): Promise<void> {
  await releaseAllForDispatch(dispatchId);
}
