import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { readFile, access } from "fs/promises";
import { lookup } from "node:dns/promises";
import { getHealthStatus } from "./health.js";
import { json } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { repos } from "../config.js";
import {
  handleListDispatches,
  handleGetDispatch,
  handleRawJsonl,
} from "./dispatches-routes.js";
import {
  handleCancelChatSession,
  handleChatStream,
  handleChatTimeline,
  handleListBoardChatSessions,
  handleListChatSessions,
  handleResumeChatSession,
  handleStartBoardChat,
} from "./chat-routes.js";
import { handleStream } from "./stream-routes.js";
import { startDbChangeDetector } from "./dispatch-stream.js";
import { startSelfRepairStream } from "./self-repair-stream.js";
import { startIssuesWatcher } from "./issues-watcher.js";
import { startAgentsWatcher } from "./agents-watcher.js";
import { startSyncRootWatcher } from "./sync-root-watcher.js";
import {
  handleListSyncRootStates,
  handleSyncRootRetryProxy,
  type SyncRootRouteDeps,
} from "./sync-root-routes.js";
import { eventBus } from "./event-bus.js";
import {
  handleLaunchProxy,
  handleResumeProxy,
  handleFleshOutProxy,
  handleTriageProxy,
  handleChatProxy,
  handleJobProxy,
  loadDispatchToken,
  makeResolveWorkerHost,
  type DispatchProxyDeps,
} from "./dispatch-proxy.js";
import {
  handlePlaywrightProxy,
  loadPlaywrightUrl,
  type PlaywrightProxyDeps,
} from "./playwright-proxy.js";
import { handleGetAgent, handleListAgents } from "./agents-list.js";
import {
  handleClearAgentBroken,
  handleClearAgentCriticalFailure,
  handleGetRoster,
  handlePatchToggle,
  handlePatchTrelloCredentials,
  handleReRunEvaluator,
} from "./agents-toggles.js";
import { handlePutIssuePrefix } from "./agents-prefix.js";
import { handlePatchEffortSettings } from "./agents-effort.js";
import {
  handleDeleteAgent,
  handlePatchAgent,
  handlePostAgent,
} from "./agents-crud.js";
import { handleGetAvatar, handlePostAvatar } from "./agents-avatar.js";
import {
  handleGetIssue,
  handleGetIssueHistory,
  handleListIssues,
} from "./issues-routes.js";
import {
  handleDeleteIssue,
  handlePatchIssue,
  handlePostIssue,
} from "./issue-write.js";
import {
  handleGetIssueSubtree,
  handleImportIssues,
} from "./issue-import.js";
import {
  handleCreateList,
  handleDeleteList,
  handleListLists,
  handleUpdateList,
} from "./lists-routes.js";
import { handleListSystemErrors } from "./system-errors-routes.js";
import {
  handleGetRepairError,
  handleListRepairErrors,
  handleMarkUnfixable,
  handleResetRepairError,
} from "./self-repair-routes.js";
import { getPool } from "../db/connection.js";
import {
  handleLogin,
  handleLogout,
  handleMe,
} from "./auth-routes.js";
import { handleAdminReset } from "./admin-routes.js";
import { requireUser } from "./auth-middleware.js";
import { optional } from "../env.js";
import { createWorktreeManager } from "../agent/worktree-manager.js";

const log = createLogger("dashboard");

const PORT = parseInt(optional("DASHBOARD_PORT", "5555"), 10);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

const distDir = new URL("../../dashboard/dist", import.meta.url);

interface JobProxyRoute {
  method: "GET" | "POST";
  pattern: RegExp;
  pathTemplate: string;
}

/**
 * Job-scoped proxy routes forwarded to `handleJobProxy`. The route() function
 * iterates this table instead of repeating the same match/decode/forward
 * block for each of status/cancel/stop.
 */
const JOB_PROXY_ROUTES: readonly JobProxyRoute[] = [
  { method: "GET",  pattern: /^\/api\/status\/([^/]+)$/, pathTemplate: "/api/status/:jobId" },
  { method: "POST", pattern: /^\/api\/cancel\/([^/]+)$/, pathTemplate: "/api/cancel/:jobId" },
  { method: "POST", pattern: /^\/api\/stop\/([^/]+)$/,   pathTemplate: "/api/stop/:jobId" },
];

/**
 * Dispatch an incoming request. Returns true if the request was handled and
 * a response has been written. Returns false only when nothing matched —
 * the outer handler then emits 404 for any method.
 */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dispatchDeps: DispatchProxyDeps,
  playwrightDeps: PlaywrightProxyDeps,
  syncRootDeps: SyncRootRouteDeps,
): Promise<boolean> {
  const method = req.method?.toUpperCase() ?? "GET";

  // ── Always-open routes ──────────────────────────────────────────────
  // Health probes, login bootstrap, static assets, and the SPA shell
  // never require auth. The SPA itself decides whether to render Login
  // or the dashboard based on a subsequent /api/auth/me call.

  if (method === "GET" && url.pathname === "/health") {
    const health = await getHealthStatus();
    const statusCode = health.status === "ok" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    await handleLogin(req, res);
    return true;
  }

  if (method === "GET" && url.pathname.startsWith("/assets/")) {
    const filePath = new URL("." + url.pathname, distDir + "/");
    try {
      await access(filePath);
      const content = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": getMimeType(url.pathname),
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(content);
      return true;
    } catch {
      json(res, 404, { error: "Not found" });
      return true;
    }
  }

  // Only GET / serves the SPA shell. Any unknown path — even other GETs —
  // must 404 so the SPA's router can't pretend to own routes it doesn't.
  if (method === "GET" && url.pathname === "/") {
    const indexPath = new URL("./index.html", distDir + "/");
    try {
      const html = await readFile(indexPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Dashboard not built. Run: cd dashboard && npm run build");
    }
    return true;
  }

  // ── Dispatch proxy — authenticates internally with DANXBOT_DISPATCH_TOKEN.
  // These routes are called by external dispatchers (gpt-manager, etc.) and
  // MUST NOT be gated by requireUser. See .claude/rules/agent-dispatch.md.

  if (method === "POST" && url.pathname === "/api/launch") {
    await handleLaunchProxy(req, res, dispatchDeps);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/resume") {
    await handleResumeProxy(req, res, dispatchDeps);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/flesh-out") {
    await handleFleshOutProxy(req, res, dispatchDeps);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/triage") {
    await handleTriageProxy(req, res, dispatchDeps);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/chat") {
    await handleChatProxy(req, res, dispatchDeps);
    return true;
  }

  for (const job of JOB_PROXY_ROUTES) {
    const jobMatch = url.pathname.match(job.pattern);
    if (method === job.method && jobMatch) {
      await handleJobProxy(
        req,
        res,
        {
          method: job.method,
          pathTemplate: job.pathTemplate,
          jobId: decodeURIComponent(jobMatch[1]),
          repoName: url.searchParams.get("repo"),
        },
        dispatchDeps,
      );
      return true;
    }
  }

  // ── Playwright proxy — same dispatch-token auth band as above.
  // MUST match ahead of the blanket `/api/*` user-auth gate below so
  // external callers (gpt-manager, curl) with only a bearer token aren't
  // 401'd on the session check. Any method is accepted; the tail of the
  // path (incl. query string) is forwarded to the Playwright service.
  // See `playwright-proxy.ts` for the binary-safe forwarder — do NOT
  // reroute this through `handleJobProxy` / `proxyToWorker`; those are
  // JSON-only and corrupt PNG bytes.
  if (url.pathname.startsWith("/api/playwright/")) {
    const tailPath =
      url.pathname.slice("/api/playwright".length) + url.search;
    await handlePlaywrightProxy(req, res, tailPath, playwrightDeps);
    return true;
  }

  // ── PATCH /api/agents/:repo/toggles — user bearer required.
  // The route is intentionally matched HERE, ahead of the blanket
  // `/api/*` gate below, so the handler's own `requireUser` call
  // produces the 401 (and the handler can stamp
  // `meta.updatedBy = dashboard:<username>` on success). That makes the
  // three auth bands explicit: (1) open routes (health, login, SPA),
  // (2) dispatch-proxy routes (dispatch-token auth inside the proxy),
  // (3) user-gated routes (this block + the blanket gate below).
  // `DANXBOT_DISPATCH_TOKEN` is NOT accepted here — see
  // `.claude/rules/agent-dispatch.md`.

  const agentTogglesMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/toggles$/,
  );
  if (method === "PATCH" && agentTogglesMatch) {
    await handlePatchToggle(
      req,
      res,
      decodeURIComponent(agentTogglesMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // DELETE /api/agents/:repo/critical-failure — user bearer required.
  // Matched ahead of the blanket /api/* gate so the handler's own
  // `requireUser` call produces the 401. Forwards to the worker's
  // DELETE /api/poller/critical-failure which calls clearFlag.
  const agentCriticalFailureMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/critical-failure$/,
  );
  if (method === "DELETE" && agentCriticalFailureMatch) {
    await handleClearAgentCriticalFailure(
      req,
      res,
      decodeURIComponent(agentCriticalFailureMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // DX-558 — root-clone sync routes. Matched ahead of the generic
  // /api/* gate so the handler's own `requireUser` produces the 401.
  if (method === "GET" && url.pathname === "/api/sync-root") {
    await handleListSyncRootStates(req, res, syncRootDeps);
    return true;
  }
  const syncRootRetryMatch = url.pathname.match(/^\/api\/sync-root\/([^/]+)$/);
  if (method === "POST" && syncRootRetryMatch) {
    await handleSyncRootRetryProxy(
      req,
      res,
      decodeURIComponent(syncRootRetryMatch[1]),
      syncRootDeps,
    );
    return true;
  }

  // PATCH /api/agents/:repo/trello-credentials — user bearer required.
  // DX-303. Rotates DANX_TRELLO_API_KEY / DANX_TRELLO_API_TOKEN in the
  // repo's `.danxbot/.env`. Same auth band as the toggle route — the
  // handler's own `requireUser` call produces the 401; the dispatch
  // token is rejected (see `.claude/rules/agent-dispatch.md`).
  const agentTrelloCredentialsMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/trello-credentials$/,
  );
  if (method === "PATCH" && agentTrelloCredentialsMatch) {
    await handlePatchTrelloCredentials(
      req,
      res,
      decodeURIComponent(agentTrelloCredentialsMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // POST /api/agents/:repo/re-run-evaluator — DX-367 (Phase 4b of
  // DX-363). User-bearer auth required. Resets the named agent's
  // broken.evaluator_status to "pending" + emits a fresh
  // broken-transition so the worker re-dispatches the evaluator.
  const agentReRunEvaluatorMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/re-run-evaluator$/,
  );
  if (method === "POST" && agentReRunEvaluatorMatch) {
    await handleReRunEvaluator(
      req,
      res,
      decodeURIComponent(agentReRunEvaluatorMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // POST /api/agents/:repo/unblock — DX-369 (Phase 6 of DX-363).
  // User-bearer auth required. Clears `agent.broken = null` and zeroes
  // `agent.strikes.count` (history preserved as audit). Proxies to the
  // worker's `/api/clear-broken` so the write happens under the same
  // per-file lock as the picker's settings reads.
  const agentUnblockMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/unblock$/,
  );
  if (method === "POST" && agentUnblockMatch) {
    await handleClearAgentBroken(
      req,
      res,
      decodeURIComponent(agentUnblockMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // PUT /api/agents/:repo/issue-prefix — DX-103. Operator-driven prefix
  // flip + in-process migration. Matched ahead of the blanket /api/* gate
  // so the handler's own `requireUser` produces the 401 (mirrors the
  // PATCH/DELETE handlers above).
  const agentIssuePrefixMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/issue-prefix$/,
  );
  if (method === "PUT" && agentIssuePrefixMatch) {
    await handlePutIssuePrefix(
      req,
      res,
      decodeURIComponent(agentIssuePrefixMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // PATCH /api/agents/:repo/effort-settings — DX-510. Operator-driven
  // effort-level table + assignment prompt mutation. Same auth band as
  // the toggle route — handler's own `requireUser` produces the 401;
  // dispatch token rejected.
  const agentEffortSettingsMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/effort-settings$/,
  );
  if (method === "PATCH" && agentEffortSettingsMatch) {
    await handlePatchEffortSettings(
      req,
      res,
      decodeURIComponent(agentEffortSettingsMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // ── DX-160 Phase 2 — Agent CRUD + avatar upload.
  // All mutation routes match BEFORE the blanket `/api/*` gate so
  // each handler's own `requireUser` call produces the 401 (mirrors
  // the existing PATCH-toggle / DELETE-critical-failure / PUT-prefix
  // handlers). Avatar GET is below the gate (read-only, served via
  // the gate's user-auth check).
  //
  // Path/segment naming: `:name` here is the AGENT name from the path
  // segment; the REPO is supplied via `?repo=<name>` query string.
  // This is intentionally orthogonal to the existing `/api/agents/:repo`
  // GET (single repo snapshot) — methods differ, no collision.
  if (method === "POST" && url.pathname === "/api/agents") {
    await handlePostAgent(
      req,
      res,
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // /api/agents/:name/avatar — POST (upload). Match before the broader
  // /api/agents/:name pattern so the avatar segment doesn't get
  // swallowed.
  const agentAvatarMatch = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/avatar$/,
  );
  if (method === "POST" && agentAvatarMatch) {
    await handlePostAvatar(
      req,
      res,
      url.searchParams.get("repo"),
      decodeURIComponent(agentAvatarMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // /api/agents/:name — PATCH / DELETE. Order matters: must match AFTER
  // the more-specific subpath patterns (toggles, critical-failure,
  // issue-prefix, avatar) and BEFORE the blanket /api/* gate.
  const agentByNameMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (method === "PATCH" && agentByNameMatch) {
    await handlePatchAgent(
      req,
      res,
      url.searchParams.get("repo"),
      decodeURIComponent(agentByNameMatch[1]),
      dispatchDeps,
    );
    return true;
  }
  if (method === "DELETE" && agentByNameMatch) {
    await handleDeleteAgent(
      req,
      res,
      url.searchParams.get("repo"),
      decodeURIComponent(agentByNameMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  // PATCH /api/issues/:id?repo=<name> — DX-236. Dashboard human write
  // surface for issue YAMLs. Matched ahead of the blanket /api/* gate
  // so the handler's own `requireUser` call produces the 401 (mirrors
  // the PATCH/DELETE handlers above) — the handler also needs
  // `auth.user.username` to stamp `comments_append.author` server-side.
  const issuePatchMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (method === "PATCH" && issuePatchMatch) {
    await handlePatchIssue(
      req,
      res,
      decodeURIComponent(issuePatchMatch[1]),
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // DELETE /api/issues/:id?repo=<name>&cascade=<bool> — soft-delete
  // (moves YAML → /tmp/danxbot/<repo>/issues/). Auth-gated by the
  // handler's own `requireUser` call (same band as PATCH/POST).
  if (method === "DELETE" && issuePatchMatch) {
    await handleDeleteIssue(
      req,
      res,
      decodeURIComponent(issuePatchMatch[1]),
      url.searchParams.get("repo"),
      url.searchParams.get("cascade"),
      dispatchDeps,
    );
    return true;
  }

  // POST /api/issues?repo=<name> — DX-350. Dashboard human-driven create
  // surface (Create Card dialog). Same auth band as the PATCH counterpart
  // (user bearer required) — handler runs `requireUser` itself ahead of
  // the blanket gate.
  if (method === "POST" && url.pathname === "/api/issues") {
    await handlePostIssue(
      req,
      res,
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // POST /api/issues/import?repo=<name> — DX-519. Dashboard paste handler.
  // Accepts an `IssueCopyPayload` (root issue + every descendant),
  // allocates fresh `<PREFIX>-N` ids against the target repo's id space,
  // rewrites every internal reference to point at the new ids, and
  // atomically writes every YAML or none. Same user-bearer auth band as
  // the create / patch counterparts — handler's own `requireUser` produces
  // the 401. Path matched ahead of POST /api/issues so the more specific
  // suffix wins; matched ahead of the blanket gate so the handler controls
  // the 401 response.
  if (method === "POST" && url.pathname === "/api/issues/import") {
    await handleImportIssues(
      req,
      res,
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // GET /api/issues/:id/subtree?repo=<name> — DX-519. Dashboard Copy
  // handler. Walks `children[]` from the root id, strips repo-specific
  // bits, and returns an `IssueCopyPayload` the SPA writes to the
  // clipboard. Matched ahead of the blanket /api/* gate so the handler's
  // own `requireUser` produces the 401; matched ahead of the generic
  // `GET /api/issues/:id` route (in the authed-routes section below)
  // because the more-specific `/subtree` suffix would otherwise be
  // unreachable.
  const issueSubtreeMatch = url.pathname.match(
    /^\/api\/issues\/([^/]+)\/subtree$/,
  );
  if (method === "GET" && issueSubtreeMatch) {
    await handleGetIssueSubtree(
      req,
      res,
      decodeURIComponent(issueSubtreeMatch[1]),
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // DX-583 — Lists CRUD. Matched ahead of the blanket /api/* gate so
  // each handler's own `requireUser` produces the 401 (mirrors the
  // issues PATCH / POST handlers). The collection endpoints
  // (`/api/lists`) carry the repo in `?repo=`; mutation endpoints
  // (`/api/lists/:id`) carry the id in the path. Successful writes
  // publish `lists:updated` on the SSE bus.
  if (method === "GET" && url.pathname === "/api/lists") {
    await handleListLists(req, res, url.searchParams.get("repo"), dispatchDeps);
    return true;
  }
  if (method === "POST" && url.pathname === "/api/lists") {
    await handleCreateList(req, res, url.searchParams.get("repo"), dispatchDeps);
    return true;
  }
  const listDetailMatch = url.pathname.match(/^\/api\/lists\/([^/]+)$/);
  if (method === "PATCH" && listDetailMatch) {
    await handleUpdateList(
      req,
      res,
      decodeURIComponent(listDetailMatch[1]),
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }
  if (method === "DELETE" && listDetailMatch) {
    await handleDeleteList(
      req,
      res,
      decodeURIComponent(listDetailMatch[1]),
      url.searchParams.get("repo"),
      dispatchDeps,
    );
    return true;
  }

  // User-auth gate for every remaining /api/* route. Bearer lives only in
  // the Authorization header — SSE uses fetch+ReadableStream on the client
  // so query-string tokens (which would leak into access logs) are never
  // needed.
  if (url.pathname.startsWith("/api/")) {
    const auth = await requireUser(req);
    if (!auth.ok) {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }
  }

  // ── Authed user routes ──────────────────────────────────────────────

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    await handleLogout(req, res);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/auth/me") {
    await handleMe(req, res);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/repos") {
    json(
      res,
      200,
      repos.map((r) => ({ name: r.name, url: r.url })),
    );
    return true;
  }

  if (method === "GET" && url.pathname === "/api/stream") {
    await handleStream(req, res, url.searchParams);
    return true;
  }

  // ── Agent Chat (DX-84) ──────────────────────────────────────────────
  // Per-card and per-board chat surfaces. All routes sit under the
  // user-auth gate above; POST proxies forward to the matching worker
  // on `danxbot-net` directly (no DANXBOT_DISPATCH_TOKEN — the token is
  // the EXTERNAL gate, not the internal one). Order matters: specific
  // tail paths (`/board`, `/:id/timeline`, `/:id/resume`, `/:id/cancel`,
  // `/:id/stream`) must match before any generic `/:id` would.

  if (method === "GET" && url.pathname === "/api/chat/sessions") {
    await handleListChatSessions(res, url.searchParams);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/chat/sessions/board") {
    await handleListBoardChatSessions(res, url.searchParams);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/chat/sessions") {
    await handleStartBoardChat(req, res, dispatchDeps);
    return true;
  }

  const chatTimelineMatch = url.pathname.match(
    /^\/api\/chat\/sessions\/([^/]+)\/timeline$/,
  );
  if (method === "GET" && chatTimelineMatch) {
    await handleChatTimeline(res, decodeURIComponent(chatTimelineMatch[1]));
    return true;
  }

  const chatResumeMatch = url.pathname.match(
    /^\/api\/chat\/sessions\/([^/]+)\/resume$/,
  );
  if (method === "POST" && chatResumeMatch) {
    await handleResumeChatSession(
      req,
      res,
      decodeURIComponent(chatResumeMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  const chatCancelMatch = url.pathname.match(
    /^\/api\/chat\/sessions\/([^/]+)\/cancel$/,
  );
  if (method === "POST" && chatCancelMatch) {
    await handleCancelChatSession(
      req,
      res,
      decodeURIComponent(chatCancelMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  const chatStreamMatch = url.pathname.match(
    /^\/api\/chat\/sessions\/([^/]+)\/stream$/,
  );
  if (method === "GET" && chatStreamMatch) {
    await handleChatStream(
      req,
      res,
      decodeURIComponent(chatStreamMatch[1]),
    );
    return true;
  }

  if (method === "GET" && url.pathname === "/api/dispatches") {
    await handleListDispatches(res, url.searchParams);
    return true;
  }

  const detailMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)$/);
  if (method === "GET" && detailMatch) {
    await handleGetDispatch(res, decodeURIComponent(detailMatch[1]));
    return true;
  }

  const rawMatch = url.pathname.match(/^\/api\/dispatches\/([^/]+)\/raw$/);
  if (method === "GET" && rawMatch) {
    await handleRawJsonl(res, decodeURIComponent(rawMatch[1]));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/agents") {
    // DX-159 Phase 1: ?repo=<name> returns the roster shape
    // ({agents: AgentRecordWithName[]}) for the new Agents tab.
    // Without the query param, the legacy unparameterized variant
    // returns the per-repo aggregation array consumed by the Settings
    // tab. Same path, two shapes — see `agents-toggles.ts#handleGetRoster`
    // for the rationale.
    const rosterRepo = url.searchParams.get("repo");
    if (rosterRepo) {
      await handleGetRoster(res, rosterRepo, dispatchDeps);
    } else {
      await handleListAgents(res, dispatchDeps);
    }
    return true;
  }

  // GET /api/agents/:name/avatar — DX-160 Phase 2. Matched BEFORE the
  // single-segment `/api/agents/:repo` snapshot route so the avatar
  // tail isn't swallowed. The handler returns the bytes with the
  // correct Content-Type (png/jpeg/webp).
  const agentAvatarGet = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/avatar$/,
  );
  if (method === "GET" && agentAvatarGet) {
    await handleGetAvatar(
      res,
      url.searchParams.get("repo"),
      decodeURIComponent(agentAvatarGet[1]),
      dispatchDeps,
    );
    return true;
  }

  const agentDetailMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (method === "GET" && agentDetailMatch) {
    await handleGetAgent(
      res,
      decodeURIComponent(agentDetailMatch[1]),
      dispatchDeps,
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/api/admin/reset") {
    await handleAdminReset(req, res);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/system-errors") {
    handleListSystemErrors(res, url.searchParams);
    return true;
  }

  // DX-565 (Phase 5 of DX-560) — Self-Repair tab REST surface. The
  // DB-backed `system_errors` + `system_error_repairs` tables Phases 1-4
  // populate. Auth is enforced by the blanket /api/* gate above.
  if (method === "GET" && url.pathname === "/api/self-repair/errors") {
    await handleListRepairErrors(res, url.searchParams, { db: getPool() });
    return true;
  }
  {
    const detailMatch = url.pathname.match(/^\/api\/self-repair\/errors\/(\d+)$/);
    if (method === "GET" && detailMatch) {
      await handleGetRepairError(res, detailMatch[1], { db: getPool() });
      return true;
    }
    const resetMatch = url.pathname.match(
      /^\/api\/self-repair\/errors\/(\d+)\/reset$/,
    );
    if (method === "POST" && resetMatch) {
      await handleResetRepairError(req, res, resetMatch[1], { db: getPool() });
      return true;
    }
    const unfixMatch = url.pathname.match(
      /^\/api\/self-repair\/errors\/(\d+)\/unfixable$/,
    );
    if (method === "POST" && unfixMatch) {
      await handleMarkUnfixable(req, res, unfixMatch[1], { db: getPool() });
      return true;
    }
  }

  if (method === "GET" && url.pathname === "/api/issues") {
    await handleListIssues(
      res,
      {
        repo: url.searchParams.get("repo"),
        includeClosed: url.searchParams.get("include_closed"),
      },
      dispatchDeps,
    );
    return true;
  }

  // History route MUST come before the generic /api/issues/:id route —
  // otherwise `:id` greedily matches "history" and the history endpoint
  // is unreachable.
  const issueHistoryMatch = url.pathname.match(/^\/api\/issues\/history\/([^/]+)$/);
  if (method === "GET" && issueHistoryMatch) {
    await handleGetIssueHistory(
      res,
      decodeURIComponent(issueHistoryMatch[1]),
      {
        repo: url.searchParams.get("repo"),
        limit: url.searchParams.get("limit"),
      },
      dispatchDeps,
    );
    return true;
  }

  const issueDetailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (method === "GET" && issueDetailMatch) {
    await handleGetIssue(
      res,
      decodeURIComponent(issueDetailMatch[1]),
      { repo: url.searchParams.get("repo") },
      dispatchDeps,
    );
    return true;
  }

  return false;
}

/**
 * Verify that each repo's worker hostname resolves via DNS at startup. Logs
 * a warning for any that don't — catches the common misconfiguration where a
 * connected repo's compose `container_name` doesn't match `workerHost(name)`
 * (the source of silent 502s at proxy request time otherwise).
 *
 * Does not block startup: DNS may not be ready when the dashboard boots in
 * docker-compose ordering, and the proxy's upstream error already returns a
 * clear 502 when the hostname fails to resolve. This is a best-effort alert
 * for operators.
 */
async function checkWorkerHostResolution(
  configuredRepos: typeof repos,
  resolveHost: (name: string) => string,
): Promise<void> {
  for (const repo of configuredRepos) {
    if (!repo.workerPort) continue;
    const host = resolveHost(repo.name);
    try {
      await lookup(host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `Worker hostname "${host}" for repo "${repo.name}" did not resolve: ${msg}. External /api/launch for this repo will 502 until the worker container is running with matching container_name.`,
      );
    }
  }
}

export async function startDashboard(): Promise<void> {
  const token = loadDispatchToken();
  if (!token) {
    log.warn(
      "DANXBOT_DISPATCH_TOKEN not set — external /api/launch proxy will reject with 500 until configured",
    );
  }

  // Build proxy deps once per dashboard process — token, repos, and the
  // worker-host resolver are all constant across requests. The handler below
  // closes over this object instead of allocating a new one per request.
  // The resolver consults each repo's `workerHost` override (set via
  // `worker_host:` in deploy/targets/<TARGET>.yml) and falls back to
  // the default `danxbot-worker-<name>` for repos without one.
  const resolveHost = makeResolveWorkerHost(repos);
  // DX-161: per-agent worktree manager. One process-wide instance shared
  // across every POST/DELETE /api/agents call. Tests opt in via mocked
  // deps; production always wires the real default.
  const worktreeManager = createWorktreeManager();
  const dispatchDeps: DispatchProxyDeps = {
    token,
    repos,
    resolveHost,
    worktreeManager,
  };

  // Playwright proxy shares the DANXBOT_DISPATCH_TOKEN with dispatchDeps —
  // same bearer, different upstream. The upstream URL is resolved once at
  // boot from env (default `http://playwright:3000` on danxbot-net).
  const playwrightDeps: PlaywrightProxyDeps = {
    token,
    upstreamUrl: loadPlaywrightUrl(),
  };

  await checkWorkerHostResolution(repos, resolveHost);

  // Start the DB change detector that publishes dispatch:created and
  // dispatch:updated events to the EventBus for SSE subscribers.
  startDbChangeDetector();

  // DX-569 — dashboard-side bridge for worker-side `system_errors` writes.
  // The worker process emits `system-repair-error:updated` on its own
  // in-process eventBus, but those events never cross the process
  // boundary into the dashboard's SSE subscribers. Poll the table from
  // here, diff against a snapshot, and re-emit so the Self-Repair tab
  // live-updates when `recordError` fires on the worker.
  startSelfRepairStream();

  // DX-226 — per-repo chokidar watcher on `.danxbot/issues/{open,closed}/`.
  // Drives the Issues tab's `issue:updated` SSE feed so the SPA composable
  // no longer polls every 30s. The shutdown handler (`src/shutdown.ts`)
  // drains active watchers via `stopAllIssuesWatchers()` on SIGTERM.
  await startIssuesWatcher(repos, eventBus);

  // DX-369 (Phase 6 of DX-363) — per-repo chokidar watcher on
  // `.danxbot/settings.json`. Fans out worker-side `agent.broken` /
  // `agent.strikes` mutations (strike accumulator, evaluator dispatcher,
  // worker's clear-broken + re-run-evaluator routes) onto the
  // `agent:updated` SSE topic so the persistent broken-agents banner
  // appears / clears live across every connected dashboard tab without
  // waiting for the next REST hydrate. Dashboard mutations call
  // `publishAgentSnapshot` directly; this watcher covers everything
  // outside the dashboard process.
  await startAgentsWatcher(repos, { resolveHost });

  // DX-558 — per-repo chokidar watcher on
  // `<repoRoot>/.danxbot/sync-root-state.json`. The worker writes the
  // file on every root-clone sync state transition; this watcher
  // republishes the change as `repo-root-sync:error` / `:clear` SSE
  // events so the dashboard banner appears / clears live.
  const syncRootWatcher = await startSyncRootWatcher(repos);
  const workerPortByRepo = new Map(repos.map((r) => [r.name, r.workerPort]));
  const syncRootDeps: SyncRootRouteDeps = {
    repos: repos.map((r) => ({ name: r.name })),
    watcher: syncRootWatcher,
    proxy: dispatchDeps,
    resolveWorkerPort: (name) => workerPortByRepo.get(name) ?? null,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      const handled = await route(
        req,
        res,
        url,
        dispatchDeps,
        playwrightDeps,
        syncRootDeps,
      );
      if (!handled) {
        json(res, 404, { error: "Not found" });
      }
    } catch (err) {
      log.error(`Unhandled error for ${req.method} ${url.pathname}`, err);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      } else {
        res.end();
      }
    }
  });

  server.listen(PORT, () => {
    log.info(`Dashboard running at http://localhost:${PORT}`);
  });
}
