/**
 * HTTP shell for `POST /api/restage/:dispatchId` (gpt-manager ISS-102 / Phase 5c).
 *
 * Phase 5c of the optimistic-concurrency epic: when an external writer
 * (dashboard human, runtime worker, another dispatch on a different SD
 * touching a shared row) mutates a row materialized into an active
 * schema-builder dispatch's workspace, gpt-manager's saved-event subscriber
 * POSTs the regenerated content here. The worker re-runs the same
 * `prepareStagedFiles + writeStagedFiles` chain that produced the original
 * staged files at launch time — single source of truth for the disk-write
 * contract. The dispatched agent's next `Read` of the staged path returns
 * fresh bytes; Claude Code's Read-before-Edit harness sees the content
 * change and forces a re-read before the next Edit.
 *
 * Body shape mirrors `/api/launch`'s `staged_files[]` exactly:
 *
 *   { staged_files: [{ path: "/tmp/schemas/${SCHEMA_DEFINITION_ID}/...",
 *                      content: "..." }] }
 *
 * Validation reuses the launch-path's `prepareStagedFiles` (allowlist +
 * placeholder substitution) so a payload that wouldn't have been accepted
 * at launch time is also rejected here.
 *
 * Authentication: this endpoint is callable from any process that can
 * reach the worker port. The worker is bound to localhost in dev and to
 * the dashboard's overlay network in prod — gpt-manager Laravel reaches
 * it through the same DanxbotClient bearer token used by the launch flow.
 *
 * Status semantics:
 *   - 200 — payload validated, files written.
 *   - 400 — caller body bug (validation error, malformed staged_files).
 *   - 404 — dispatch not found, terminal, or has no restage context
 *           (workspace omits `staging-paths`).
 *   - 500 — disk write / fetch failure (worker IO).
 *
 * @see ../dispatch/staged-files.ts Reused validation + write functions
 * @see ../agent/agent-types.ts AgentJob.restageContext (preserved overlay + allowlist)
 */

import type { IncomingMessage, ServerResponse } from "http";

import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { getActiveJob } from "./dispatch.js";
import {
  prepareStagedFiles,
  writeStagedFiles,
  StagedFilesError,
} from "../dispatch/staged-files.js";

const log = createLogger("worker-restage-route");

export async function handleRestage(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
): Promise<void> {
  try {
    const job = getActiveJob(dispatchId);

    if (!job) {
      json(res, 404, {
        error: `No active dispatch with id ${dispatchId}`,
      });
      return;
    }

    if (job.status !== "running") {
      // Terminal dispatches must not accept restage writes — the agent
      // process is gone (or in shutdown) and the staging dir is being
      // cleaned up. Returning 404 mirrors how getActiveJob would behave
      // post-TTL eviction so the caller's retry semantics stay uniform.
      json(res, 404, {
        error: `Dispatch ${dispatchId} is not running (status: ${job.status})`,
      });
      return;
    }

    if (!job.restageContext) {
      json(res, 404, {
        error: `Dispatch ${dispatchId} has no restage context — workspace declares no staging-paths allowlist`,
      });
      return;
    }

    const body = await parseBody(req);
    const stagedFiles = body?.staged_files;

    if (!Array.isArray(stagedFiles)) {
      json(res, 400, {
        error: "Missing or non-array `staged_files` field in request body",
      });
      return;
    }

    if (stagedFiles.length === 0) {
      // Empty payload is a no-op success — saves a network round trip
      // for the caller when the saved-event resolver's filter excluded
      // every entry (e.g. self-write). Symmetric with /api/launch's
      // empty-stagedFiles handling.
      json(res, 200, { restaged: 0 });
      return;
    }

    const prepared = prepareStagedFiles({
      stagedFiles,
      stagingPaths: job.restageContext.stagingPaths,
      overlay: job.restageContext.overlay,
    });

    const written = await writeStagedFiles(prepared);

    json(res, 200, { restaged: written.length, paths: written });
  } catch (err) {
    if (err instanceof StagedFilesError) {
      // validation = caller body bug → 400; write = worker IO → 500.
      // Either branch leaves no files on disk thanks to the all-or-
      // nothing rollback inside writeStagedFiles.
      json(res, err.kind === "validation" ? 400 : 500, {
        error: err.message,
      });
      return;
    }

    log.error(`Restage failed for dispatch ${dispatchId}`, err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Restage failed",
    });
  }
}
