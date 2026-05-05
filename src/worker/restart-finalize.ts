/**
 * Detached finalizer entry point for the worker self-restart flow
 * (ISS-71). Spawned by `restart-route.ts#defaultSpawnFinalizer` as a
 * detached child node process before the parent worker SIGTERMs
 * itself. Polls the new worker's `/health` until 200 (success) or
 * the deadline expires (health_timeout), then writes the
 * `worker_restarts` audit row's completion columns.
 *
 * Args (CLI):
 *   --restart-id <int>          worker_restarts.id to finalize
 *   --repo <string>             repo name (for logging only)
 *   --port <int>                worker port to poll
 *   --timeout-ms <int>          total budget for poll loop
 *   --reserved-respawn-ms <int> subtracted from timeout-ms
 *   --started-at <epoch-ms>     started_at of the restart row
 *
 * The finalizer does NOT spawn the new worker daemon — that lives
 * one layer up (host runtime: operator's supervisord / make rerun;
 * docker runtime is blocked at guard 4 so this file never runs in
 * docker). Its only job is the wait + audit completion.
 */

import { pathToFileURL } from "node:url";
import { closePool } from "../db/connection.js";
import { createLogger } from "../logger.js";
import { completeRestart } from "./worker-restarts-db.js";
import { pollHealth } from "./restart.js";
import { lsofPid } from "./lsof-pid.js";

const log = createLogger("worker-restart-finalize");

interface ParsedArgs {
  restartId: number;
  repo: string;
  port: number;
  timeoutMs: number;
  reservedRespawnMs: number;
  startedAt: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      map.set(arg.slice(2), next);
      i++;
    }
  }
  const required = (key: string): string => {
    const v = map.get(key);
    if (v === undefined) throw new Error(`Missing --${key}`);
    return v;
  };
  return {
    restartId: Number(required("restart-id")),
    repo: required("repo"),
    port: Number(required("port")),
    timeoutMs: Number(required("timeout-ms")),
    reservedRespawnMs: Number(required("reserved-respawn-ms")),
    startedAt: Number(required("started-at")),
  };
}

export interface MainDeps {
  resolveNewPid: (port: number) => number | null;
  fetch: (url: string) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultMainDeps: MainDeps = {
  resolveNewPid: lsofPid,
  fetch: async (url) => {
    const res = await fetch(url);
    return { ok: res.ok, status: res.status };
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function main(
  argv: string[],
  deps: MainDeps = defaultMainDeps,
): Promise<void> {
  const args = parseArgs(argv);
  const budget = Math.max(1, args.timeoutMs - args.reservedRespawnMs);
  const deadline = Date.now() + budget;

  log.info(
    `Finalizing restart ${args.restartId} for "${args.repo}" — polling ` +
      `port ${args.port} until ${new Date(deadline).toISOString()}`,
  );

  const ok = await pollHealth(args.port, deadline, {
    fetch: deps.fetch,
    now: deps.now,
    sleep: deps.sleep,
  });

  const completedAt = deps.now();
  if (ok) {
    const newPid = deps.resolveNewPid(args.port);
    await completeRestart({
      id: args.restartId,
      outcome: "success",
      newPid,
      completedAt,
    });
    log.info(
      `Restart ${args.restartId} success — new pid ${newPid ?? "unknown"}`,
    );
  } else {
    await completeRestart({
      id: args.restartId,
      outcome: "health_timeout",
      newPid: null,
      completedAt,
    });
    log.warn(
      `Restart ${args.restartId} health_timeout after ${budget}ms`,
    );
  }
}

// Only run when invoked directly (not when imported by a test).
const entry = process.argv[1];
const isDirectInvocation =
  !!entry && import.meta.url === pathToFileURL(entry).href;
if (isDirectInvocation) {
  main(process.argv.slice(2))
    .then(async () => {
      await closePool().catch(() => undefined);
      process.exit(0);
    })
    .catch(async (err) => {
      log.error("Finalizer failed", err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}

export { parseArgs, main };
