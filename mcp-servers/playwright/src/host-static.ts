/**
 * Static-file hosting for `playwright_host_static` + `vue_build_and_preview`.
 *
 * The MCP server agents spawn lives in their workspace process tree, so a
 * static HTTP server started here serves on the agent's host loopback —
 * which `playwright_screenshot` / `mcp__claude-in-chrome__navigate` can
 * reach when the Playwright runner is co-located on host (host-mode
 * dispatch). In docker-mode the playwright-screenshot container reaches
 * back via the docker bridge gateway; in either case the URL is
 * `127.0.0.1:<ephemeral>` and the caller (the agent) is responsible for
 * passing that exact URL to the navigation tool.
 *
 * Path-traversal contract: `dist_path` is `realpathSync`-resolved, then
 * required to be EQUAL TO or a descendant of the configured workspace
 * root. The workspace root is locked at module load (read-once from
 * `PLAYWRIGHT_WORKSPACE_ROOT` env var with `process.cwd()` fallback,
 * realpathed) so a later `process.chdir()` cannot widen the boundary.
 * Symlinks inside the dist are resolved at fetch time (Node's
 * createReadStream follows symlinks) — that's fine because the
 * server-root realpath check already proved the dist is inside the
 * workspace; any in-tree symlink pointing outside would have shifted
 * the realpath of the root dir itself, which we test once at start.
 *
 * LRU cap: 4 active hosted dirs per MCP session. Overflow evicts the
 * least-recently-started server. Cap mirrors the card's spec (DX-542).
 * Auto-teardown on process exit registers SIGINT/SIGTERM/exit handlers
 * once, on first start.
 */

import http from "node:http";
import { realpathSync, statSync, createReadStream, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";

/** LRU cap per the card spec. */
export const HOSTED_DIST_LRU_CAP = 4;

export interface HostedServer {
  server_id: string;
  url: string;
  /** Realpath of the directory being served. */
  dist_path: string;
  /** Monotonically-increasing counter for LRU ordering. Higher = newer. */
  started_at: number;
  /** Underlying Node http.Server — exposed for tests. */
  server: http.Server;
}

export interface HostStaticDeps {
  /** Absolute, realpath-resolved workspace boundary. */
  workspaceRoot: string;
}

/**
 * Resolve the workspace root once at module load. `PLAYWRIGHT_WORKSPACE_ROOT`
 * env var lets the dispatch overlay override `process.cwd()` (e.g. when
 * the MCP server was spawned with the working dir not yet set to the
 * agent's workspace). Fail loud if neither resolves to a real directory.
 */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLAYWRIGHT_WORKSPACE_ROOT ?? process.cwd();
  const resolved = realpathSync(raw);
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    throw new Error(
      `playwright-mcp-server: workspace root ${resolved} is not a directory`,
    );
  }
  return resolved;
}

/**
 * MIME types we hand back. Browsers tolerate `application/octet-stream`
 * for unknown types but Vite-built apps lean on `text/html`,
 * `application/javascript`, `text/css`, and the font/image bundles —
 * we ship a minimal table and default to octet-stream for anything
 * else.
 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".avif": "image/avif",
};

export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Resolve an incoming URL path against a server's dist root. Two
 * defenses against traversal: (1) reject any decoded segment containing
 * `..`, (2) realpath the joined path and require the result to start
 * with `distRoot`. The first catches obvious `../../etc/passwd`-shaped
 * URLs without touching the filesystem; the second catches symlinks
 * inside the dist that point outside.
 *
 * Returns the resolved absolute path on success, or null on any
 * defense trip (404 the request).
 */
/**
 * Resolve and stat in one step. The two operations MUST come back as a
 * pair: if the request handler re-stats the resolved path later, a
 * symlink swap inside the dist (the dist is agent-writable — they just
 * extracted a tarball into it) could substitute a target outside
 * `distRoot` between the two syscalls. Folding the stat into the
 * resolver closes that TOCTOU window — we hold the realpath and the
 * stat of the same inode, and the open + read of the file via
 * `createReadStream(real)` is the only filesystem access after this
 * point.
 */
export function resolveRequestPath(
  distRoot: string,
  urlPath: string,
): { path: string; stat: Stats } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  // Strip leading slash; treat empty / trailing-slash as index.html.
  let rel = decoded.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  // Pre-flight segment check — cheap rejection of obvious traversal.
  const segments = rel.split("/");
  if (segments.some((s) => s === "..")) return null;
  const joined = path.join(distRoot, rel);
  // path.join normalizes "./" but not symlinks. Realpath the candidate;
  // a non-existent path throws ENOENT and we 404.
  let real: string;
  let stat: Stats;
  try {
    real = realpathSync(joined);
    stat = statSync(real);
  } catch {
    return null;
  }
  // Require real path to be EQUAL TO distRoot or a strict descendant.
  // `${distRoot}${path.sep}` guard rejects `${distRoot}-evil` aliasing.
  if (real !== distRoot && !real.startsWith(distRoot + path.sep)) {
    return null;
  }
  // Directories never serve directly — the upstream `index.html` rewrite
  // handles `/` and `foo/` cases; anything else hitting a directory at
  // this stage is a malformed URL.
  if (stat.isDirectory()) return null;
  return { path: real, stat };
}

/**
 * Wire process-shutdown handlers to a registry. Production callers
 * (the MCP entrypoint in `index.ts`) call this once at boot for the
 * one registry that lives the lifetime of the process. Tests skip
 * it — each test owns a fresh registry and calls `stopAll()` in
 * `afterEach`.
 */
export function installTeardownHandlers(registry: HostedDistRegistry): void {
  const cleanup = () => {
    void registry.stopAll();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/** Test-only no-op kept for source compatibility with earlier test files. */
export function _resetTeardownForTests(): void {
  /* registry no longer installs its own handlers; this is a no-op. */
}

/**
 * Registry of active hosted dirs. One instance per MCP server process.
 * Exposed (not a module singleton) so tests can spin up isolated
 * registries.
 */
export class HostedDistRegistry {
  private active = new Map<string, HostedServer>();
  private counter = 0;
  /**
   * Per-registry serial mutex. `start()` is async (it `listen()`s the
   * server) so without serialization two concurrent calls can both
   * observe `active.size === CAP - 1`, both insert, and end with
   * `CAP + 1` entries — the LRU invariant is broken. Chaining onto
   * `mutex` and reassigning before the await isolates each start.
   */
  private mutex: Promise<void> = Promise.resolve();

  constructor(private deps: HostStaticDeps) {}

  size(): number {
    return this.active.size;
  }

  get(serverId: string): HostedServer | undefined {
    return this.active.get(serverId);
  }

  /** Snapshot — for assertions and the LRU eviction policy. */
  list(): HostedServer[] {
    return [...this.active.values()];
  }

  async start(rawDistPath: string): Promise<{ server_id: string; url: string }> {
    // Serialize: chain onto the mutex BEFORE doing any work, replace
    // the mutex with this call's completion, then await our turn.
    let release!: () => void;
    const ours = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.mutex;
    this.mutex = ours;
    await prev;
    try {
      return await this._startUnchecked(rawDistPath);
    } finally {
      release();
    }
  }

  private async _startUnchecked(
    rawDistPath: string,
  ): Promise<{ server_id: string; url: string }> {
    if (typeof rawDistPath !== "string" || rawDistPath.trim() === "") {
      throw new Error("playwright_host_static: dist_path must be a non-empty string");
    }
    if (!path.isAbsolute(rawDistPath)) {
      throw new Error(
        `playwright_host_static: dist_path must be absolute (got "${rawDistPath}")`,
      );
    }
    // Realpath first — symlinks pointing outside the workspace would
    // otherwise pass a prefix check on the symlink path itself.
    let distPath: string;
    try {
      distPath = realpathSync(rawDistPath);
    } catch (err) {
      throw new Error(
        `playwright_host_static: dist_path does not exist or is unreadable (${rawDistPath})`,
      );
    }
    const st = statSync(distPath);
    if (!st.isDirectory()) {
      throw new Error(
        `playwright_host_static: dist_path must be a directory (${distPath})`,
      );
    }
    const root = this.deps.workspaceRoot;
    if (distPath !== root && !distPath.startsWith(root + path.sep)) {
      throw new Error(
        `playwright_host_static: dist_path ${distPath} is outside workspace root ${root}`,
      );
    }

    // Evict LRU if we'd exceed cap with a new entry. `<` not `<=` so
    // the new entry fits after eviction.
    while (this.active.size >= HOSTED_DIST_LRU_CAP) {
      const oldest = [...this.active.values()].sort(
        (a, b) => a.started_at - b.started_at,
      )[0];
      if (!oldest) break;
      await this.stop(oldest.server_id);
    }

    const server = http.createServer((req, res) => {
      const urlPath = req.url ?? "/";
      const resolved = resolveRequestPath(distPath, urlPath);
      if (resolved === null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      // resolveRequestPath returns the stat alongside the realpath so
      // the open below cannot race a swapped symlink (M1 — TOCTOU fix).
      res.writeHead(200, {
        "content-type": mimeFor(resolved.path),
        "content-length": String(resolved.stat.size),
        "cache-control": "no-store",
      });
      const stream = createReadStream(resolved.path);
      stream.on("error", () => {
        // If the file vanished between stat and open, the headers are
        // already written — there's nothing meaningful to send the
        // client beyond a forced socket close.
        res.destroy();
      });
      stream.pipe(res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo | null;
    if (!addr || typeof addr === "string") {
      server.close();
      throw new Error("playwright_host_static: failed to bind ephemeral port");
    }
    const server_id = randomUUID();
    const url = `http://127.0.0.1:${addr.port}`;
    const entry: HostedServer = {
      server_id,
      url,
      dist_path: distPath,
      started_at: ++this.counter,
      server,
    };
    this.active.set(server_id, entry);
    return { server_id, url };
  }

  async stop(server_id: string): Promise<boolean> {
    if (typeof server_id !== "string" || server_id.trim() === "") {
      throw new Error("playwright_host_static_stop: server_id must be a non-empty string");
    }
    const entry = this.active.get(server_id);
    if (!entry) return false;
    this.active.delete(server_id);
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      // Force-close any keep-alive sockets so close() resolves promptly
      // even if a screenshot agent left a fetch dangling.
      entry.server.closeAllConnections?.();
    });
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.active.keys()];
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch {
        // Best-effort during shutdown.
      }
    }
  }
}
