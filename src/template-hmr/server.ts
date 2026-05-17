/**
 * SG-189 — per-template Vite dev-server lifecycle for the schema-builder
 * dispatch flow.
 *
 * Why per-template (not per-dispatch): operator design (dan, 2026-05-17)
 * — "they should all run on their own unique port and get assigned by
 * template ID so we can route to the right one when trying to connect via
 * the URL externally for HMR loading." One Vite process per templateId,
 * port keyed by templateId. Two concurrent dispatches that share a
 * templateId share the same Vite server (HMR re-emits to every connected
 * iframe regardless of which dispatch wrote the source file) — the
 * `refDispatchIds` set just keeps the process alive until the last
 * referring dispatch terminates.
 *
 * Why spawn (not import Vite programmatically): danxbot has no `vite`
 * dependency; pulling it in would also pull `@vitejs/plugin-vue` + `vue`
 * + the danx-ui runtime. The SFC source dir already carries a
 * `package.json` that pins Vite for build (SG-187), and the shared deps
 * tree at `SFC_DEPS_BASE_DIR/<shell>/node_modules` provides the binary.
 * We spawn `node_modules/.bin/vite --port <picked> --strictPort` from the
 * source dir — same pattern `template-build/vite-runner.ts` uses for
 * `vite build`.
 *
 * Shim files (`index.html`, `vite.config.ts`, `node_modules` symlink) are
 * dropped into the source dir alongside the agent's SFC files. Each shim
 * carries a `danxbot HMR shim — do not edit` header so an agent reading
 * the dir knows the file is infrastructure, not card-scope work. Cleanup
 * on dispatch terminal removes only the shims this module wrote (tracked
 * per-entry); files the SFC source shipped natively (App.vue, main.ts,
 * etc.) are left alone — those are the dispatch's `stagedFilePaths` and
 * are owned by `agent-cleanup.ts`.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type spawn as SpawnFn,
} from "child_process";
import { existsSync } from "fs";
import { mkdir, rm, symlink, writeFile } from "fs/promises";
import { createServer as createNetServer } from "net";
import { join } from "path";
import { createLogger } from "../logger.js";

const log = createLogger("template-hmr");

/**
 * Per-call overrides — exported so `lifecycle.ts` can re-export the same
 * shape without picking individual keys (DRY: adding a new override key
 * here flows through automatically to the lifecycle caller).
 */
export interface AcquireOverrides {
  spawnImpl?: typeof SpawnFn;
  portPicker?: () => Promise<number>;
  depsBaseDir?: string;
  shellVersion?: string;
  publicHost?: string;
  readyTimeoutMs?: number;
}

export interface HmrServerInfo {
  templateId: string;
  sourceDir: string;
  port: number;
  url: string;
  /** Snapshot of the dispatch ids currently holding the entry open. */
  refDispatchIds: string[];
  startedAt: Date;
}

export interface AcquireHmrOptions extends AcquireOverrides {
  templateId: string;
  sourceDir: string;
  dispatchId: string;
}

interface InternalEntry {
  templateId: string;
  sourceDir: string;
  port: number;
  url: string;
  child: ChildProcess;
  /** Shim files THIS entry wrote — removed on stop. Native source files are left alone. */
  shimFiles: string[];
  /** Symlinks THIS entry created — removed on stop. */
  symlinks: string[];
  refDispatchIds: Set<string>;
  startedAt: Date;
  /** Set when shutdown begins so concurrent release calls don't re-kill. */
  closing: boolean;
}

// Singleton process-level state. NOT parallel-test-safe — vitest workers
// that share a process would see each other's entries. Tests reset via
// `clearHmrStateForTesting`; production workers each own a fresh process
// so the singleton is correct.
const entries = new Map<string, InternalEntry>();
// Per-template start serialization — two acquire calls for the same template
// race the spawn; without a lock we'd start two vite processes for one port.
const startLocks = new Map<string, Promise<InternalEntry>>();

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_SHELL_VERSION = "1.0.0";
const SHIM_HEADER_HTML =
  "<!-- danxbot HMR shim (SG-189) — do not edit. Removed on dispatch end. -->";
const SHIM_HEADER_JS =
  "/* danxbot HMR shim (SG-189) — do not edit. Removed on dispatch end. */";

export class HmrServerError extends Error {
  constructor(
    message: string,
    public readonly templateId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HmrServerError";
  }
}

/**
 * Reserve a free TCP port by binding `:0` and immediately closing. Race
 * window between close and vite's bind is real but tiny on a workstation;
 * we pass `--strictPort` downstream so vite fails loudly (rather than
 * silently incrementing) if a concurrent listener grabs it.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("failed to resolve listening address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}/`;
}

function writeShimFile(path: string, body: string): Promise<void> {
  return writeFile(path, body, "utf-8");
}

const VITE_CONFIG_BODY = `${SHIM_HEADER_JS}
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    cors: true,
    hmr: { overlay: false },
  },
  cacheDir: "./.vite-cache",
  clearScreen: false,
});
`;

const INDEX_HTML_BODY = `<!doctype html>
${SHIM_HEADER_HTML}
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Template HMR Preview</title>
</head>
<body>
<div id="app"></div>
<script type="module" src="./main.ts"></script>
</body>
</html>
`;

/**
 * Drop the shim files + node_modules symlink the source dir needs to
 * actually boot Vite. Returns the per-entry tracking lists so the
 * release path can undo exactly what this call did and nothing more.
 */
async function provisionShims(
  sourceDir: string,
  depsBaseDir: string,
  shellVersion: string,
): Promise<{ shimFiles: string[]; symlinks: string[] }> {
  const shimFiles: string[] = [];
  const symlinks: string[] = [];

  const indexPath = join(sourceDir, "index.html");
  if (!existsSync(indexPath)) {
    await writeShimFile(indexPath, INDEX_HTML_BODY);
    shimFiles.push(indexPath);
  }

  const configPath = join(sourceDir, "vite.config.ts");
  if (!existsSync(configPath)) {
    await writeShimFile(configPath, VITE_CONFIG_BODY);
    shimFiles.push(configPath);
  }

  const nodeModulesPath = join(sourceDir, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    const depsDir = join(depsBaseDir, shellVersion, "node_modules");
    if (!existsSync(depsDir)) {
      throw new HmrServerError(
        `Shared deps not found at ${depsDir} — set SFC_DEPS_BASE_DIR + provision the shared node_modules tree`,
        "(unknown)",
      );
    }
    await symlink(depsDir, nodeModulesPath, "dir");
    symlinks.push(nodeModulesPath);
  }

  return { shimFiles, symlinks };
}

// Vite ≥5 prints `VITE v… ready in <N> ms` on stdout when the dev-server
// starts listening. ANSI color escapes don't break the regex (the literal
// characters survive between escapes), but a future wording change would
// silently hang spawn until the readyTimeoutMs trips. The `Local:` URL
// line is a stable fallback — it always carries the bound port and only
// emits when the server is reachable. Either match resolves ready.
const VITE_READY_PATTERNS: readonly RegExp[] = [
  /ready in \d+\s*ms/i,
  /Local:\s+https?:\/\//i,
];

function looksReady(text: string): boolean {
  return VITE_READY_PATTERNS.some((re) => re.test(text));
}

interface SpawnedViteHandle {
  child: ChildProcess;
  ready: Promise<void>;
}

/**
 * Spawn the vite dev-server child, return a handle whose `ready` promise
 * resolves on first "ready in N ms" line. The child stays alive after
 * the promise resolves — caller owns the process from that point.
 */
function spawnViteChild(
  opts: {
    sourceDir: string;
    port: number;
    spawnImpl: typeof SpawnFn;
    readyTimeoutMs: number;
    templateId: string;
  },
): SpawnedViteHandle {
  const viteBin = join(opts.sourceDir, "node_modules", ".bin", "vite");
  const child = opts.spawnImpl(
    viteBin,
    ["--port", String(opts.port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: opts.sourceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new HmrServerError(
            `vite did not become ready within ${opts.readyTimeoutMs}ms`,
            opts.templateId,
          ),
        ),
      );
    }, opts.readyTimeoutMs);

    const checkOutput = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (looksReady(text)) {
        clearTimeout(timer);
        settle(resolve);
      }
    };

    child.stdout?.on("data", checkOutput);
    child.stderr?.on("data", checkOutput);

    child.once("error", (err) => {
      clearTimeout(timer);
      settle(() =>
        reject(
          new HmrServerError(
            `vite spawn failed: ${err.message}`,
            opts.templateId,
            err,
          ),
        ),
      );
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      settle(() =>
        reject(
          new HmrServerError(
            `vite exited before becoming ready (code ${code})`,
            opts.templateId,
          ),
        ),
      );
    });
  });

  return { child, ready };
}

function snapshot(entry: InternalEntry): HmrServerInfo {
  return {
    templateId: entry.templateId,
    sourceDir: entry.sourceDir,
    port: entry.port,
    url: entry.url,
    refDispatchIds: [...entry.refDispatchIds],
    startedAt: entry.startedAt,
  };
}

/**
 * Acquire — start a new Vite for `templateId` if none is running, or
 * refcount-bump the existing one. Two concurrent calls for the same id
 * funnel through `startLocks` so only one spawn fires; the second call
 * awaits the in-flight promise and gets the same entry back.
 */
export async function acquireHmrServer(
  opts: AcquireHmrOptions,
): Promise<HmrServerInfo> {
  const existing = entries.get(opts.templateId);
  if (existing && !existing.closing) {
    existing.refDispatchIds.add(opts.dispatchId);
    return snapshot(existing);
  }

  const pending = startLocks.get(opts.templateId);
  if (pending) {
    const entry = await pending;
    entry.refDispatchIds.add(opts.dispatchId);
    return snapshot(entry);
  }

  const startPromise = startEntry(opts).finally(() => {
    startLocks.delete(opts.templateId);
  });
  startLocks.set(opts.templateId, startPromise);

  const entry = await startPromise;
  // Seeded inside startEntry before the `entries.set` so the entry is never
  // observable with an empty ref set — guards against a sibling
  // releaseAllForDispatch racing the activation tick.
  return snapshot(entry);
}

async function startEntry(opts: AcquireHmrOptions): Promise<InternalEntry> {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const portPicker = opts.portPicker ?? pickFreePort;
  const depsBaseDir = opts.depsBaseDir ?? process.env.SFC_DEPS_BASE_DIR;
  const shellVersion =
    opts.shellVersion ??
    process.env.SFC_DEPS_SHELL_VERSION ??
    DEFAULT_SHELL_VERSION;
  const publicHost =
    opts.publicHost ?? process.env.HMR_PUBLIC_HOST ?? "localhost";
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  if (!depsBaseDir) {
    throw new HmrServerError(
      "SFC_DEPS_BASE_DIR is not set — HMR cannot resolve a vite binary",
      opts.templateId,
    );
  }

  await mkdir(opts.sourceDir, { recursive: true });

  const { shimFiles, symlinks } = await provisionShims(
    opts.sourceDir,
    depsBaseDir,
    shellVersion,
  );

  const port = await portPicker();
  const handle = spawnViteChild({
    sourceDir: opts.sourceDir,
    port,
    spawnImpl,
    readyTimeoutMs,
    templateId: opts.templateId,
  });

  try {
    await handle.ready;
  } catch (err) {
    // ready failed — kill the child if it's still around, then unwind shims.
    try {
      handle.child.kill("SIGTERM");
    } catch (killErr) {
      log.debug(
        `[template-hmr ${opts.templateId}] SIGTERM during ready-failure cleanup threw: ${
          killErr instanceof Error ? killErr.message : String(killErr)
        }`,
      );
    }
    await unwindShims(shimFiles, symlinks);
    throw err;
  }

  const url = buildUrl(publicHost, port);
  const entry: InternalEntry = {
    templateId: opts.templateId,
    sourceDir: opts.sourceDir,
    port,
    url,
    child: handle.child,
    shimFiles,
    symlinks,
    // Seed the first dispatch's ref BEFORE the entry is published in the
    // `entries` map so no sibling caller can observe it with an empty ref
    // set (which would otherwise look "abandoned" to a concurrent
    // releaseAllForDispatch).
    refDispatchIds: new Set([opts.dispatchId]),
    startedAt: new Date(),
    closing: false,
  };
  entries.set(opts.templateId, entry);

  // Drop the entry if vite dies under us — a future acquire respawns. We
  // mark the entry `closing` BEFORE deleting + clearing refs so a parallel
  // releaseAllForDispatch on an old dispatchId finds the entry in a
  // consistent "shutting down" state instead of racing the unwind.
  handle.child.once("exit", (code) => {
    const current = entries.get(opts.templateId);
    if (current !== entry) return;
    log.warn(
      `[template-hmr ${opts.templateId}] vite exited (code ${code}); dropping entry`,
    );
    entry.closing = true;
    entry.refDispatchIds.clear();
    entries.delete(opts.templateId);
    void unwindShims(entry.shimFiles, entry.symlinks);
  });

  return entry;
}

async function unwindShims(
  shimFiles: readonly string[],
  symlinks: readonly string[],
): Promise<void> {
  for (const path of shimFiles) {
    try {
      await rm(path, { force: true });
    } catch (err) {
      log.warn(
        `[template-hmr] failed to remove shim ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  for (const path of symlinks) {
    try {
      await rm(path, { force: true });
    } catch (err) {
      log.warn(
        `[template-hmr] failed to remove symlink ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Release — drop one dispatchId's claim on the template. When the ref
 * set hits zero, SIGTERM the vite child, await its exit, and unwind
 * the shim files this entry wrote. Idempotent: double-release with the
 * same dispatchId is a no-op (the Set.delete on a missing key); releasing
 * a never-acquired template is also a no-op.
 */
export async function releaseHmrServer(
  templateId: string,
  dispatchId: string,
): Promise<void> {
  const entry = entries.get(templateId);
  if (!entry) return;

  entry.refDispatchIds.delete(dispatchId);
  if (entry.refDispatchIds.size > 0) return;
  if (entry.closing) return;
  entry.closing = true;
  entries.delete(templateId);

  await stopChild(entry.child);
  await unwindShims(entry.shimFiles, entry.symlinks);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", settle);
    try {
      child.kill("SIGTERM");
    } catch (killErr) {
      log.debug(
        `[template-hmr] SIGTERM threw on already-dead child: ${
          killErr instanceof Error ? killErr.message : String(killErr)
        }`,
      );
      settle();
    }
    // SIGTERM grace — if vite ignores it, escalate to SIGKILL after 5s.
    setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch (killErr) {
        log.debug(
          `[template-hmr] SIGKILL threw on already-dead child: ${
            killErr instanceof Error ? killErr.message : String(killErr)
          }`,
        );
      }
      // SIGKILL fires `exit` synchronously enough that the once-handler
      // resolves shortly. A second timeout drops us out so a stuck child
      // can't block dispatch teardown forever.
      setTimeout(settle, 1_000);
    }, 5_000);
  });
}

/** Release every entry currently referencing `dispatchId`. */
export async function releaseAllForDispatch(
  dispatchId: string,
): Promise<void> {
  const owned = [...entries.values()].filter((e) =>
    e.refDispatchIds.has(dispatchId),
  );
  await Promise.all(
    owned.map((entry) => releaseHmrServer(entry.templateId, dispatchId)),
  );
}

/**
 * Lookup the live entry for a templateId, or null if none is running.
 *
 * Health-checks the child before returning — a vite that died microseconds
 * after `ready` resolved would otherwise hand a stale URL to the iframe.
 * The exit handler will eventually drop the entry on the event loop tick,
 * but `getActiveHmr` callers see correctness immediately. Dead-entry
 * cleanup happens lazily here too — caller observes a 404 rather than a
 * URL pointing at a dead process.
 */
export function getActiveHmr(templateId: string): HmrServerInfo | null {
  const entry = entries.get(templateId);
  if (!entry) return null;
  if (entry.closing) return null;
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    // The exit handler may not have fired yet — drop the entry now so the
    // route returns 404 instead of a URL that points at a dead process.
    entry.closing = true;
    entry.refDispatchIds.clear();
    entries.delete(templateId);
    void unwindShims(entry.shimFiles, entry.symlinks);
    return null;
  }
  return snapshot(entry);
}

/** Snapshot every live entry — for `/api/template-hmr/active` listing + diagnostics. */
export function listActiveHmr(): HmrServerInfo[] {
  return [...entries.values()].map(snapshot);
}

/**
 * Worker shutdown / boot — tear down every live entry. Used by the worker
 * server's SIGTERM handler so a graceful shutdown does not leak Vite
 * children, and by the test suite to drain state between cases.
 */
export async function shutdownAllHmr(): Promise<void> {
  const ids = [...entries.keys()];
  await Promise.all(
    ids.map(async (templateId) => {
      const entry = entries.get(templateId);
      if (!entry) return;
      entry.refDispatchIds.clear();
      if (entry.closing) return;
      entry.closing = true;
      entries.delete(templateId);
      await stopChild(entry.child);
      await unwindShims(entry.shimFiles, entry.symlinks);
    }),
  );
}

/** Test hook — clear in-memory state without trying to kill anything. */
export function clearHmrStateForTesting(): void {
  entries.clear();
  startLocks.clear();
}
