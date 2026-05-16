/**
 * HTTP-shaped `WorktreeManager` for dashboard-container mode.
 *
 * Why: the dashboard container is on `danxbot-net` only. Running
 * `worktreeManager.bootstrap()` locally inside the dashboard hits
 * `provisionWorktreeDatabase` → `getaddrinfo ENOTFOUND pgsql` because
 * the consumer repo's Postgres lives on its own `sail` network the
 * dashboard never joins. The per-repo worker container IS joined to
 * `sail` and CAN reach `pgsql` by DNS.
 *
 * Solution: this shim implements the `WorktreeManager` interface but
 * speaks HTTP to the worker's `POST/DELETE /api/worktree-bootstrap`
 * route instead of running git/DB/compose calls locally. The dashboard
 * still owns settings record + response shape; only the provisioning
 * side-effect is forwarded.
 *
 * Limited surface: only `bootstrap` and `teardown` are wired (the only
 * methods `handlePostAgent` + `handleDeleteAgent` call). The other
 * `WorktreeManager` methods (`syncWorktree`, `fetchOrigin`,
 * `snapshotIfDirty`, `ensureProvisioned`) throw — they are called by
 * dispatch-side code that always runs IN the worker (where the local
 * manager is wired). Calling them via this shim would mean the
 * dashboard tries to drive dispatch, which is not a supported path.
 */

import { request } from "node:http";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { agentWorktreePath, type WorktreeManager } from "../agent/worktree-manager.js";

const log = createLogger("remote-worktree-manager");

export interface RemoteWorktreeManagerDeps {
  /** Resolves a repo name → worker hostname (same fn as dispatch-proxy uses). */
  resolveHost: (repoName: string) => string;
  workerPort: (repoName: string) => number;
  /** `DANXBOT_DISPATCH_TOKEN` value. */
  token: string;
}

class NotSupportedInDashboardError extends Error {
  constructor(method: string) {
    super(
      `${method} is not supported via RemoteWorktreeManager — this method runs on the worker, not the dashboard`,
    );
  }
}

interface HttpResult {
  status: number;
  body: string;
}

function doRequest(
  host: string,
  port: number,
  method: "POST" | "DELETE",
  path: string,
  token: string,
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        method,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
        // 5 min ceiling — image build + compose up on first run can
        // be slow; worker enforces its own ceilings per provisioner.
        timeout: 5 * 60 * 1000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Worker request timed out after 5 min`));
    });
    if (body) req.write(body);
    req.end();
  });
}

export function createRemoteWorktreeManager(
  deps: RemoteWorktreeManagerDeps,
): WorktreeManager {
  async function call(
    repoName: string,
    method: "POST" | "DELETE",
    path: string,
    body?: string,
  ): Promise<void> {
    const host = deps.resolveHost(repoName);
    const port = deps.workerPort(repoName);
    log.info(
      `${method} http://${host}:${port}${path} (repo=${repoName})`,
    );
    const result = await doRequest(host, port, method, path, deps.token, body);
    if (result.status === 204) return;
    let parsedError: string;
    try {
      const json = JSON.parse(result.body);
      parsedError =
        typeof json.error === "string" ? json.error : result.body;
    } catch {
      parsedError = result.body || `worker returned HTTP ${result.status}`;
    }
    throw new Error(parsedError);
  }

  return {
    worktreePath(ctx, agentName) {
      // Path derivation is pure — runs locally even when ops are remote.
      return agentWorktreePath(ctx.hostPath, agentName);
    },
    async bootstrap(ctx, agentName) {
      await call(
        ctx.name,
        "POST",
        "/api/worktree-bootstrap",
        JSON.stringify({ name: agentName }),
      );
    },
    async teardown(ctx, agentName) {
      await call(
        ctx.name,
        "DELETE",
        `/api/worktree-bootstrap/${encodeURIComponent(agentName)}`,
      );
    },
    async fetchOrigin() {
      throw new NotSupportedInDashboardError("fetchOrigin");
    },
    async syncWorktree() {
      throw new NotSupportedInDashboardError("syncWorktree");
    },
    async snapshotIfDirty() {
      throw new NotSupportedInDashboardError("snapshotIfDirty");
    },
    async ensureProvisioned() {
      throw new NotSupportedInDashboardError("ensureProvisioned");
    },
  };
}
