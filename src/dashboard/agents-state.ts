/**
 * DX-684 — runtime-state read route for the Agents tab.
 *
 *   GET /api/agents/:repo/state → { critical_failure, sync_state, runtime_settings }
 *
 * Aggregates the three worker-owned runtime files into one response so
 * the SPA can render the per-repo runtime panel without N round-trips.
 * Every path resolves through `runtimeVolumePath()` (DX-682) — the
 * dashboard reads the same on-disk files the worker writes (host:
 * `~/.local/share/danxbot/<repo>/`, docker: `/var/lib/danxbot/<repo>/`).
 *
 * The route is intentionally separate from `GET /api/agents/:repo`
 * (which returns the full `AgentSnapshot` with worker-health probe,
 * settings, dispatch counts, GitHub creds, etc.). The split lets the
 * SPA refresh the runtime panel on `repo-root-sync:error` / `repo-root-
 * sync:clear` / direct DELETE flows without re-probing the worker.
 *
 * Worker remains the sole writer of every file read here. The dashboard
 * NEVER mutates: clearing the critical-failure flag goes through the
 * existing `DELETE /api/agents/:repo/critical-failure` route which
 * proxies to the worker's `DELETE /api/poller/critical-failure`.
 */

import type { ServerResponse } from "http";
import { existsSync, readFileSync } from "node:fs";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  readFlagFromRepoName,
  type CriticalFailurePayload,
} from "../critical-failure.js";
import { runtimeVolumePath } from "../runtime-volume.js";
import { isRepoRootSyncError, type RepoRootSyncError } from "../worker/sync-root.js";
import type { SettingsDisplay, SettingsMeta } from "../settings-file.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("agents-state");

export interface DriftSnapshot {
  display: SettingsDisplay;
  meta: SettingsMeta;
}

export interface AgentRuntimeState {
  critical_failure: CriticalFailurePayload | null;
  sync_state: RepoRootSyncError | null;
  /**
   * Contents of `<runtime-volume>/<repo>/settings-runtime.json` — the
   * drift partition of `Settings` (`{display, meta}`). `null` when the
   * file is absent (worker has not stamped drift yet) or fails the
   * shape predicate (corrupt file degrades gracefully).
   */
  runtime_settings: DriftSnapshot | null;
}

/** Read + parse a JSON file under the runtime volume. Returns null on
 * absence or any parse failure — the dashboard renders an empty panel
 * rather than 500-ing the whole page on a transient I/O hiccup. */
function readRuntimeJson<T>(
  repoName: string,
  basename: string,
  validate: (parsed: unknown) => parsed is T,
): T | null {
  const path = runtimeVolumePath(repoName, basename);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!validate(parsed)) {
      log.warn(`Malformed ${basename} at ${path} — returning null`);
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn(`Failed to read ${basename} at ${path}`, err);
    return null;
  }
}

function isDriftShape(raw: unknown): raw is DriftSnapshot {
  // The drift file is owned by `src/settings-file.ts`: every legitimate
  // writer goes through `runWrite` which always stamps a fresh `meta`
  // block. Reject anything missing the contract shape so a corruption
  // falls through to null. Future field additions land transparently
  // since unknown extras are ignored — only the two required keys are
  // gated.
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.display === "object" &&
    r.display !== null &&
    typeof r.meta === "object" &&
    r.meta !== null
  );
}

export function buildRuntimeState(repoName: string): AgentRuntimeState {
  // Re-use the existing `readFlagFromRepoName` so the fail-CLOSED +
  // throttle auto-clear contract from `src/critical-failure.ts` applies
  // here identically. The dashboard MUST surface an unparseable flag
  // (not silently drop it) — the reader returns the synthetic
  // "unparseable" payload for that case, exactly what we want to render.
  const critical_failure = readFlagFromRepoName(repoName);
  const sync_state = readRuntimeJson(
    repoName,
    "sync-root-state.json",
    isRepoRootSyncError,
  );
  const runtime_settings = readRuntimeJson(
    repoName,
    "settings-runtime.json",
    isDriftShape,
  );
  return { critical_failure, sync_state, runtime_settings };
}

/**
 * GET /api/agents/:repo/state — auth gated by the blanket `/api/*`
 * bearer check in `server.ts`. Returns 404 when the repo is not
 * configured. Never throws — every readRuntimeJson failure mode lands
 * in a null field.
 */
export async function handleGetAgentRuntimeState(
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }
  json(res, 200, buildRuntimeState(repo.name));
}
