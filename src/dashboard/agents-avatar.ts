/**
 * Avatar upload + serve for DX-160 Phase 2 — split off from
 * `agents-crud.ts` so both modules stay under the 300-line ceiling.
 *
 *   POST /api/agents/:name/avatar?repo=<name>  → handlePostAvatar
 *   GET  /api/agents/:name/avatar?repo=<name>  → handleGetAvatar
 *
 * The shared mutation primitives (`MutateError`, `authAndResolveRepo`)
 * are imported from `agents-crud.ts`; the FS guards
 * (`agentDir`, `assertWithinAgentsRoot`, `readBoundedBody`,
 * MIME tables) live in `agent-fs.ts`.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import {
  DASHBOARD_PREFIX,
  mutateAgents,
  readSettings,
  type AgentRecord,
  type Settings,
} from "../settings-file.js";
import { publishAgentSnapshot } from "./agents-list.js";
import {
  MutateError,
  authAndResolveRepo,
  namedRecord,
} from "./agents-crud.js";
import {
  agentDir,
  assertWithinAgentsRoot,
  readBoundedBody,
} from "./agent-fs.js";

const log = createLogger("agents-avatar");

/**
 * Avatars live at `<repo>/.danxbot/agents/<name>/avatar.<ext>`. The
 * extension mirrors the request's MIME type (png/jpeg/webp); only one
 * avatar per agent — uploading a new image overwrites the previous file
 * even when the extension differs (new file written first, previous-ext
 * file unlinked second). The `.danxbot/agents/` subtree is gitignored.
 */
const ALLOWED_AVATAR_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
]);

const AVATAR_EXTS: readonly string[] = ["png", "jpg", "jpeg", "webp"] as const;

const AVATAR_MAX_BYTES = 1_000_000; // 1 MB hard cap (DX-160 AC #11)

const AVATAR_MIME_FROM_EXT: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

/**
 * POST /api/agents/:name/avatar?repo=<name> — DX-160 Phase 2.
 *
 * Raw-body upload. The card spec mentioned "multipart upload" but the
 * implementation uses a raw binary POST instead — no multipart parser
 * is shipped with this repo, and the browser FormData API can stream a
 * `File` blob directly via `fetch(url, {method:'POST', body: file})`
 * with `Content-Type` taken from `file.type`. Same security posture,
 * fewer moving parts, no new dependency.
 *
 * Validation (in this order):
 *   - 415 unsupported media type — anything outside png/jpeg/webp.
 *   - 413 payload too large — body > 1 MB (cap enforced at stream time
 *     so we never buffer a multi-megabyte body).
 *   - 404 unknown agent.
 *
 * Side effects on success:
 *   - Writes `<repo.localPath>/.danxbot/agents/<name>/avatar.<ext>`.
 *   - Removes any prior-extension avatar files for the same agent (so
 *     png → jpg upgrade leaves only the new file behind).
 *   - Updates `agents.<name>.avatar_path` to the relative path.
 *   - Bumps `updated_at`.
 *
 * Returns 200 with the refreshed `{name, ...record}`.
 */
export async function handlePostAvatar(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  // MIME validation FIRST so an oversized but unsupported MIME 415s
  // without us reading 1 MB into memory.
  const rawCt = req.headers["content-type"] ?? "";
  const ct = (typeof rawCt === "string" ? rawCt : "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED_AVATAR_MIME.get(ct);
  if (!ext) {
    json(res, 415, {
      error: `unsupported media type "${ct}" — allowed: ${Array.from(ALLOWED_AVATAR_MIME.keys()).join(", ")}`,
    });
    // Drain the body so the client doesn't see a connection reset.
    req.resume();
    return;
  }

  // Read body with a hard cap. We can't trust Content-Length blindly
  // (clients can lie), so enforce at chunk-arrival time too.
  const collect = await readBoundedBody(req, AVATAR_MAX_BYTES);
  if ("tooLarge" in collect) {
    json(res, 413, {
      error: `payload too large — avatar must be ≤ ${AVATAR_MAX_BYTES} bytes`,
    });
    return;
  }
  if ("error" in collect) {
    json(res, 400, { error: `failed to read body: ${collect.error}` });
    return;
  }

  // Probe the agent's existence before writing bytes — a missing
  // record means the bytes would land orphaned on disk. The probe is
  // outside the lock; a delete that lands between the probe and the
  // write would leave the bytes orphaned (gitignored, benign — the
  // next delete or upload cleans them up).
  const probe = readSettings(repo.localPath).agents?.[agentName];
  if (!probe) {
    json(res, 404, { error: `agent "${agentName}" not found` });
    return;
  }

  const dir = agentDir(repo, agentName);
  const escape = assertWithinAgentsRoot(repo, dir);
  if (escape) {
    log.error(`handlePostAvatar(${repo.name}, ${agentName}): ${escape}`);
    json(res, 500, { error: "internal path error" });
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    // Remove any previous avatar files (different extension).
    for (const otherExt of AVATAR_EXTS) {
      if (otherExt === ext) continue;
      const stale = resolvePath(dir, `avatar.${otherExt}`);
      if (existsSync(stale)) {
        try {
          unlinkSync(stale);
        } catch (err) {
          log.warn(
            `handlePostAvatar(${repo.name}, ${agentName}): failed to unlink stale ${stale}`,
            err,
          );
        }
      }
    }
    const target = resolvePath(dir, `avatar.${ext}`);
    writeFileSync(target, collect.buffer);
  } catch (err) {
    log.error(`handlePostAvatar(${repo.name}, ${agentName}): write failed`, err);
    json(res, 500, { error: "Failed to persist avatar" });
    return;
  }

  let saved: AgentRecord | null = null;
  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        const updated: AgentRecord = {
          ...record,
          avatar_path: `agents/${agentName}/avatar.${ext}`,
          updated_at: new Date().toISOString(),
        };
        current[agentName] = updated;
        saved = updated;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(
      `handlePostAvatar(${repo.name}, ${agentName}): mutateAgents threw`,
      err,
    );
    json(res, 500, { error: "Failed to persist avatar metadata" });
    return;
  }

  // mutateAgents either runs the callback (which assigns saved) or throws.
  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 200, namedRecord(agentName, saved!));
}

/**
 * GET /api/agents/:name/avatar?repo=<name> — DX-160 Phase 2.
 *
 * Serves the bytes from `<repo.localPath>/.danxbot/agents/<name>/avatar.<ext>`
 * with the Content-Type derived from the stored extension. 404 when the
 * agent record carries no `avatar_path`, when the file is missing on
 * disk, or when the agent itself doesn't exist.
 *
 * The handler runs under the dashboard's blanket `/api/*` user-auth gate
 * — no per-handler `requireUser` call needed (the gate produces the
 * 401 BEFORE this code runs).
 */
export async function handleGetAvatar(
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!repoName) {
    json(res, 400, { error: "Missing required query param: repo" });
    return;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let settings: Settings;
  try {
    settings = readSettings(repo.localPath);
  } catch (err) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): readSettings threw`, err);
    json(res, 500, { error: "Failed to read settings" });
    return;
  }
  const record = settings.agents?.[agentName];
  if (!record) {
    json(res, 404, { error: `agent "${agentName}" not found` });
    return;
  }
  if (!record.avatar_path) {
    json(res, 404, { error: `agent "${agentName}" has no avatar` });
    return;
  }
  // avatar_path is relative to <repo.localPath>/.danxbot/. Resolve and
  // verify the result is contained within the repo's `.danxbot/agents/`
  // root before reading.
  const danxbotRoot = resolvePath(repo.localPath, ".danxbot");
  const file = resolvePath(danxbotRoot, record.avatar_path);
  const escape = assertWithinAgentsRoot(repo, file);
  if (escape) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): ${escape}`);
    json(res, 404, { error: "avatar not found" });
    return;
  }
  if (!existsSync(file)) {
    json(res, 404, { error: "avatar file missing on disk" });
    return;
  }
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const mime = AVATAR_MIME_FROM_EXT.get(ext) ?? "application/octet-stream";
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    log.error(`handleGetAvatar(${repo.name}, ${agentName}): read failed`, err);
    json(res, 500, { error: "Failed to read avatar" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "private, max-age=60",
  });
  res.end(bytes);
}
