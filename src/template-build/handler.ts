/**
 * POST /api/template-build — Phase 1 of the danxbot Vue SPA build feature
 * (DX-539, parent epic DX-538).
 *
 * Synchronous build endpoint. Accepts presigned S3 URLs for source +
 * destination; downloads the source tarball, runs vite build against the
 * matching shared-deps node_modules (provisioned by DX-540), tars the
 * dist, PUTs it back to S3, and returns a structured JSON response. Each
 * outcome is appended to an in-memory ring buffer (`recentBuilds`) for the
 * `/api/template-build/recent` debug endpoint.
 *
 * The handler is split into a route shell (`handleTemplateBuild`) and a
 * pure orchestrator (`runTemplateBuild`) so tests can drive the full
 * pipeline with injected dependencies (`fetchImpl`, `spawnImpl`,
 * `resolveDepsDir`, `scratchRoot`) without needing real S3 or vite.
 */

import { mkdtemp, mkdir, rm, symlink, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { spawn as nodeSpawn, type spawn as SpawnFn } from "child_process";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { createLogger } from "../logger.js";
import { json, parseBody } from "../http/helpers.js";
import {
  extractTarballToDir,
  createTarballBuffer,
  countTarballFiles,
} from "./tarball.js";
import {
  runViteBuild,
  writeDefaultViteConfig,
  writeDefaultIndexHtml,
  ViteBuildError,
} from "./vite-runner.js";

const log = createLogger("template-build");

export type TemplateBuildErrorCode =
  | "deps_missing"
  | "source_download_failed"
  | "vite_build_failed"
  | "dist_upload_failed";

export interface TemplateBuildInput {
  template_id: number;
  build_id: string;
  source_get_url: string;
  dist_put_url: string;
  shell_version: string;
}

export type TemplateBuildOutcome =
  | {
      ok: true;
      build_id: string;
      duration_ms: number;
      stderr: string;
      file_count: number;
    }
  | {
      ok: false;
      build_id: string;
      error: TemplateBuildErrorCode;
      stderr: string;
    };

export interface TemplateBuildDeps {
  fetchImpl?: typeof fetch;
  resolveDepsDir?: (shellVersion: string) => string;
  scratchRoot?: string;
  spawnImpl?: typeof SpawnFn;
}

const RECENT_CAP = 100;
const recentBuilds: TemplateBuildOutcome[] = [];

export function getRecentBuilds(): readonly TemplateBuildOutcome[] {
  return recentBuilds;
}

export function clearRecentBuilds(): void {
  recentBuilds.length = 0;
}

function pushRecent(outcome: TemplateBuildOutcome): void {
  recentBuilds.push(outcome);
  if (recentBuilds.length > RECENT_CAP) {
    recentBuilds.splice(0, recentBuilds.length - RECENT_CAP);
  }
}

export type ValidatedInput =
  | { ok: true; input: TemplateBuildInput }
  | { ok: false; error: string };

// build_id + shell_version flow into filesystem paths (scratch dir prefix,
// deps-dir resolution). Restrict to a safe character set so a malicious
// caller can't escape the scratch root or redirect deps to an arbitrary
// path. mkdtemp would catch most escapes via ENOENT anyway, but a
// front-line validator gives a 400 instead of a 500.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

// URLs are fetched server-side. Restrict to https: to block SSRF attempts
// at file://, http://169.254.169.254 (cloud metadata), and other
// loopback / internal schemes. Presigned S3 URLs are always https.
function isSafeFetchUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateBody(body: unknown): ValidatedInput {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const requiredString: (keyof TemplateBuildInput)[] = [
    "build_id",
    "source_get_url",
    "dist_put_url",
    "shell_version",
  ];
  for (const key of requiredString) {
    const v = b[key];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: `Missing or empty required field: ${key}` };
    }
  }

  const template_id = b.template_id;
  if (typeof template_id !== "number" || !Number.isFinite(template_id)) {
    return {
      ok: false,
      error: "Field template_id must be a finite number",
    };
  }

  const build_id = b.build_id as string;
  const shell_version = b.shell_version as string;
  if (!SAFE_ID_RE.test(build_id)) {
    return {
      ok: false,
      error: "build_id must match /^[A-Za-z0-9._-]+$/",
    };
  }
  if (!SAFE_ID_RE.test(shell_version)) {
    return {
      ok: false,
      error: "shell_version must match /^[A-Za-z0-9._-]+$/",
    };
  }

  const source_get_url = b.source_get_url as string;
  const dist_put_url = b.dist_put_url as string;
  if (!isSafeFetchUrl(source_get_url)) {
    return {
      ok: false,
      error: "source_get_url must be an https URL",
    };
  }
  if (!isSafeFetchUrl(dist_put_url)) {
    return {
      ok: false,
      error: "dist_put_url must be an https URL",
    };
  }

  return {
    ok: true,
    input: {
      template_id,
      build_id,
      source_get_url,
      dist_put_url,
      shell_version,
    },
  };
}

export type AuthCheck =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function checkAuth(
  authHeader: string | undefined,
  expectedToken: string | undefined,
): AuthCheck {
  if (!expectedToken) return { ok: true };

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing or malformed bearer token" };
  }
  const presented = authHeader.slice("Bearer ".length);

  const presentedBuf = Buffer.from(presented);
  const expectedBuf = Buffer.from(expectedToken);
  if (
    presentedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(presentedBuf, expectedBuf)
  ) {
    return { ok: false, status: 401, error: "Invalid bearer token" };
  }
  return { ok: true };
}

function defaultResolveDepsDir(shellVersion: string): string {
  const base = process.env.SFC_DEPS_BASE_DIR ?? '/srv/sfc-deps';
  return `${base}/${shellVersion}/node_modules`;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function fail(
  buildId: string,
  error: TemplateBuildErrorCode,
  stderr: string,
): TemplateBuildOutcome {
  const outcome: TemplateBuildOutcome = {
    ok: false,
    build_id: buildId,
    error,
    stderr,
  };
  pushRecent(outcome);
  return outcome;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTemplateBuild(
  input: TemplateBuildInput,
  deps: TemplateBuildDeps = {},
): Promise<TemplateBuildOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveDepsDir = deps.resolveDepsDir ?? defaultResolveDepsDir;
  const scratchRoot = deps.scratchRoot ?? tmpdir();
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;

  // deps_missing check happens BEFORE any scratch IO so a misconfigured
  // shell_version is cheap to reject.
  const depsDir = resolveDepsDir(input.shell_version);
  if (!(await dirExists(depsDir))) {
    return fail(
      input.build_id,
      "deps_missing",
      `Shared deps not found at ${depsDir}`,
    );
  }

  // Scratch dir prefix matches the AC's `/tmp/sfc-build-*` pattern when
  // scratchRoot defaults to tmpdir(). validateBody already restricted
  // build_id to a safe charset.
  const scratchPrefix = join(scratchRoot, `sfc-build-${input.build_id}-`);
  await mkdir(scratchRoot, { recursive: true });
  const scratchDir = await mkdtemp(scratchPrefix);

  const started = Date.now();
  try {
    try {
      const res = await fetchImpl(input.source_get_url);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
      }
      const source = Readable.fromWeb(
        res.body as unknown as import("stream/web").ReadableStream<Uint8Array>,
      );
      await extractTarballToDir(source, scratchDir);
    } catch (err) {
      return fail(input.build_id, "source_download_failed", errMessage(err));
    }

    // Symlink the shared node_modules so vite resolves `vue`, danx-ui, etc.
    await symlink(depsDir, join(scratchDir, "node_modules"), "dir");

    // Write the default vite.config.ts if the source tarball did not ship one.
    await writeDefaultViteConfig(scratchDir);

    // Write the default index.html if the source tarball did not ship one
    // (SG-173 — without it vite emits only JS/CSS and gpt-manager's
    // SfcBuildTransport rejects the dist tarball as "invalid bundle").
    await writeDefaultIndexHtml(scratchDir);

    let buildStderr = "";
    try {
      const result = await runViteBuild({
        cwd: scratchDir,
        viteBin: join(scratchDir, "node_modules", ".bin", "vite"),
        spawnImpl,
      });
      buildStderr = result.stderr;
    } catch (err) {
      const stderr =
        err instanceof ViteBuildError ? err.stderr || err.message : errMessage(err);
      return fail(input.build_id, "vite_build_failed", stderr);
    }

    let distBuf: Buffer;
    let fileCount: number;
    try {
      distBuf = await createTarballBuffer(join(scratchDir, "dist"));
      fileCount = await countTarballFiles(distBuf);
    } catch (err) {
      // Packaging is a post-build step but its failure is symptomatic of
      // a broken build (missing dist dir, empty output). Reported as
      // vite_build_failed to keep the error enum stable for Phase 1.
      return fail(
        input.build_id,
        "vite_build_failed",
        `Failed to package dist: ${errMessage(err)}`,
      );
    }

    try {
      const uploadRes = await fetchImpl(input.dist_put_url, {
        method: "PUT",
        body: new Uint8Array(distBuf),
        headers: { "Content-Type": "application/gzip" },
      });
      if (!uploadRes.ok) {
        throw new Error(
          `HTTP ${uploadRes.status} ${uploadRes.statusText || ""}`.trim(),
        );
      }
    } catch (err) {
      return fail(input.build_id, "dist_upload_failed", errMessage(err));
    }

    const outcome: TemplateBuildOutcome = {
      ok: true,
      build_id: input.build_id,
      duration_ms: Date.now() - started,
      stderr: buildStderr,
      file_count: fileCount,
    };
    pushRecent(outcome);
    return outcome;
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function handleTemplateBuild(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const authCheck = checkAuth(
      req.headers.authorization,
      process.env.TEMPLATE_BUILD_TOKEN,
    );
    if (!authCheck.ok) {
      json(res, authCheck.status, { error: authCheck.error });
      return;
    }

    let body: unknown;
    try {
      body = await parseBody(req);
    } catch (err) {
      json(res, 400, { error: errMessage(err) });
      return;
    }

    const validated = validateBody(body);
    if (!validated.ok) {
      json(res, 400, { error: validated.error });
      return;
    }

    const outcome = await runTemplateBuild(validated.input);
    json(res, 200, outcome);
  } catch (err) {
    log.error("template-build handler crashed", err);
    json(res, 500, {
      error: errMessage(err),
    });
  }
}

/**
 * Debug endpoint — last 100 build outcomes. Gated by the same optional
 * `TEMPLATE_BUILD_TOKEN` as the write endpoint so an unauthenticated
 * caller cannot enumerate prior build IDs / stderr leakage.
 */
export function handleRecentBuilds(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const authCheck = checkAuth(
    req.headers.authorization,
    process.env.TEMPLATE_BUILD_TOKEN,
  );
  if (!authCheck.ok) {
    json(res, authCheck.status, { error: authCheck.error });
    return;
  }
  json(res, 200, { builds: getRecentBuilds() });
}
