/**
 * HTTP shell for `POST /api/restart/:dispatchId` (ISS-71).
 *
 * Thin wrapper over `restart.ts`. Lives in its own file so the route
 * registration in `server.ts` stays small and so the route's own
 * test file can mock `restartWorker` without dragging the orchestration
 * deps in.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoContext } from "../types.js";
import { config } from "../config.js";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import {
  parseRestartRequest,
  restartWorker,
  DEFAULT_COOLDOWN_MS,
  type SpawnFinalizerInput,
} from "./restart.js";
import { lsofPid } from "./lsof-pid.js";

const log = createLogger("worker-restart-route");

const FINALIZER_SCRIPT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "restart-finalize.js");
})();

/**
 * Default detached-finalizer spawner. The child process is `node`
 * running `restart-finalize.ts` (or its compiled `.js`); it polls
 * `/health` on the worker port and writes the audit-row completion.
 */
function defaultSpawnFinalizer(input: SpawnFinalizerInput): void {
  const child = spawn(
    process.execPath,
    [
      FINALIZER_SCRIPT,
      "--restart-id",
      String(input.restartId),
      "--repo",
      input.repo,
      "--port",
      String(input.port),
      "--timeout-ms",
      String(input.timeoutMs),
      "--reserved-respawn-ms",
      String(input.reservedRespawnMs),
      "--started-at",
      String(input.startedAt),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  child.unref();
}

function defaultKillSelf(): void {
  process.kill(process.pid, "SIGTERM");
}

export interface RestartRouteDeps {
  spawnFinalizer?: (input: SpawnFinalizerInput) => void;
  killSelf?: () => void;
  resolveOldPid?: (port: number) => number | null;
  now?: () => number;
}

export async function handleRestart(
  req: IncomingMessage,
  res: ServerResponse,
  dispatchId: string,
  repo: RepoContext,
  routeDeps: RestartRouteDeps = {},
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err) {
    json(res, 400, {
      error: err instanceof Error ? err.message : "Invalid body",
    });
    return;
  }

  // The URL path carries the requesting dispatch id; the body parser
  // owns repo + reason + optional fields. We inject the URL's
  // dispatch id into the request before forwarding so the audit row
  // matches the route the caller actually hit.
  const parsed = parseRestartRequest(body);
  if (!parsed.ok) {
    json(res, parsed.status, { error: parsed.error });
    return;
  }

  try {
    const result = await restartWorker(
      { ...parsed.value, requestingDispatchId: dispatchId },
      repo,
      {
        spawnFinalizer: routeDeps.spawnFinalizer ?? defaultSpawnFinalizer,
        killSelf: routeDeps.killSelf ?? defaultKillSelf,
        resolveOldPid: routeDeps.resolveOldPid ?? lsofPid,
        now: routeDeps.now ?? Date.now,
        runtime: config.runtime,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      },
    );

    if (!result.accepted) {
      json(res, result.status, result.body);
      return;
    }

    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body), () => {
      // Fire SIGTERM AFTER the body has hit the socket. setImmediate
      // adds an event-loop tick of safety in case Node hasn't yet
      // flushed the kernel buffer when the `end` callback fires.
      setImmediate(result.postFlush);
    });
  } catch (err) {
    log.error("restartWorker failed", err);
    json(res, 500, {
      error: err instanceof Error ? err.message : "Restart failed",
    });
  }
}
