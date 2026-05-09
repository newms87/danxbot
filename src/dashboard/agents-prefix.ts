/**
 * Issue-prefix migration route — Phase 4 of DX-99.
 *
 *   PUT /api/agents/:repo/issue-prefix
 *
 * Operator-driven flip of a connected repo's `issue_prefix` field plus
 * the full file-rename + content-rewrite migration via `runMigration`.
 *
 * The 409 gate on active dispatches lives here too: the migration
 * mutates filenames the dispatched agent may currently hold open via
 * `Edit` / `Write`. We probe the worker's `/api/jobs` endpoint with a
 * tight 2s timeout and refuse to migrate if any active job exists.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { request as httpRequest } from "node:http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import { eventBus } from "./event-bus.js";
import { ISSUE_PREFIX_SHAPE } from "../issue-tracker/yaml.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";
import { runMigration } from "../../scripts/migrate-issue-prefix.js";

const log = createLogger("agents-prefix");

/**
 * Probe the worker's `/api/jobs` endpoint to determine whether any
 * dispatch is currently active for the named repo. Returns `false` on
 * any probe failure (worker down / timeout / parse error) — a stuck
 * worker should not block prefix migration; the migration is itself
 * filesystem-only and the worker will reload on its next restart anyway.
 */
async function workerHasActiveDispatch(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = httpRequest(
      {
        host,
        port,
        path: "/api/jobs",
        method: "GET",
        timeout: 2_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolveProbe(false);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
            const activeStates = new Set([
              "running",
              "queued",
              "starting",
              "spawning",
            ]);
            const active = jobs.some((j: { status?: unknown }) => {
              const status =
                typeof j?.status === "string" ? j.status : "running";
              return activeStates.has(status);
            });
            resolveProbe(active);
          } catch {
            resolveProbe(false);
          }
        });
      },
    );
    req.on("error", () => resolveProbe(false));
    req.on("timeout", () => {
      req.destroy();
      resolveProbe(false);
    });
    req.end();
  });
}

/**
 * `PUT /api/agents/:repo/issue-prefix` — Phase 4 of DX-99.
 *
 * Body: `{prefix: string}` — must match `ISSUE_PREFIX_SHAPE`
 * (`/^[A-Z]{2,4}$/`).
 *
 * Response: `{prefix, migratedFiles}`. `migratedFiles` is the count
 * across both `open/` and `closed/` (renames + content rewrites
 * collapsed to one number per the AC contract).
 *
 * Errors:
 * - 400 — bad regex on `prefix`, missing body, or new prefix equals
 *   current prefix (no-op rejected to keep the SSE side-effect honest).
 * - 401 — no/invalid bearer.
 * - 404 — unknown repo.
 * - 409 — an active dispatch holds a YAML lock for this repo. The
 *   migration would race the agent's write. Operator must wait or
 *   cancel the dispatch via `/api/cancel/<jobId>` first.
 * - 500 — migration encountered an error and rolled back. Body carries
 *   the per-repo `errors[]` from `runMigration` for diagnosis.
 *
 * Side effects on success:
 * - `<repo>/.danxbot/config/config.yml#issue_prefix` is rewritten via
 *   `setConfigPrefix` (called inside `runMigration`).
 * - Every YAML under `<repo>/.danxbot/issues/{open,closed}/` is renamed
 *   from `<old>-N.yml` to `<new>-N.yml` and its content rewritten.
 * - `eventBus.publish({topic: "agent:updated", ...})` fires so the SPA
 *   can refresh the Issues tab with the new prefix's chips.
 *
 * Note: the dashboard process and the worker process both cache
 * `RepoContext.issuePrefix` at startup. After this route succeeds the
 * file system is consistent, but the worker keeps the OLD prefix in
 * memory until its container restarts. The Issues tab refreshes via
 * SSE — issue lookups go through the new YAML filenames + the new
 * config.yml, so the SPA renders correctly without a worker bounce.
 * Agents dispatched between the prefix flip and the next worker
 * restart will see the new prefix on every fresh `loadIssuePrefix`
 * call (which is invoked at dispatch time, not cached at boot for
 * the dispatched-agent path).
 */
export async function handlePutIssuePrefix(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const rawPrefix = body["prefix"];
  if (typeof rawPrefix !== "string" || !ISSUE_PREFIX_SHAPE.test(rawPrefix)) {
    json(res, 400, {
      error: `prefix must match ${ISSUE_PREFIX_SHAPE} (2-4 uppercase ASCII letters)`,
    });
    return;
  }
  const newPrefix = rawPrefix;

  let currentPrefix: string;
  try {
    currentPrefix = loadIssuePrefix(repo.localPath);
  } catch (err) {
    json(res, 500, {
      error:
        err instanceof Error
          ? `Failed to read current issue_prefix: ${err.message}`
          : "Failed to read current issue_prefix",
    });
    return;
  }

  if (currentPrefix === newPrefix) {
    json(res, 400, {
      error: `prefix is already "${newPrefix}" — no-op rejected`,
    });
    return;
  }

  const host = deps.resolveHost(repo.name);
  const active = await workerHasActiveDispatch(host, repo.workerPort);
  if (active) {
    json(res, 409, {
      error:
        "Active dispatch holds a YAML lock for this repo; wait for it to complete or cancel via /api/cancel/<jobId>",
    });
    return;
  }

  let migrationResult;
  try {
    migrationResult = runMigration({
      repos: [
        {
          repoRoot: repo.localPath,
          oldPrefix: currentPrefix,
          newPrefix,
        },
      ],
      log: (msg) => log.info(`[issue-prefix:${repo.name}] ${msg}`),
    });
  } catch (err) {
    log.error(
      `handlePutIssuePrefix(${repo.name}): runMigration threw`,
      err,
    );
    json(res, 500, {
      error:
        err instanceof Error
          ? `Migration threw: ${err.message}`
          : "Migration threw",
    });
    return;
  }

  const repoResult = migrationResult.perRepo[0];
  if (!repoResult || repoResult.errors.length > 0 || repoResult.rolledBack) {
    log.error(
      `handlePutIssuePrefix(${repo.name}): migration rolled back`,
      repoResult,
    );
    json(res, 500, {
      error: "Migration failed and was rolled back",
      details: repoResult?.errors ?? ["unknown migration error"],
      rolledBack: repoResult?.rolledBack ?? false,
    });
    return;
  }

  const migratedFiles = repoResult.filesRenamed + repoResult.filesRewritten;

  // Broadcast so the Issues tab + Agents tab refresh without a poll.
  eventBus.publish({
    topic: "issue-prefix:changed",
    data: {
      repo: repo.name,
      oldPrefix: currentPrefix,
      newPrefix,
      migratedFiles,
    },
  });

  json(res, 200, { prefix: newPrefix, migratedFiles });
}
