import { watch } from "vue";
import type {
  AgentRecordWithName,
  AgentRosterResponse,
  AgentSchedule,
  AgentSnapshot,
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  Feature,
  Issue,
  IssueDetail,
  IssueListItem,
  IssuePatch,
  JsonlBlock,
  SystemError,
} from "./types";
import { useAuth } from "./composables/useAuth";
import { useStream } from "./composables/useStream";

export interface RepoInfo {
  name: string;
  url: string;
}

const AUTH_EXPIRED_EVENT = "auth:expired";

function emitAuthExpired(): void {
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/**
 * Inject the current user's bearer token on every dashboard API call.
 *
 * Contract: any 401 response dispatches the `auth:expired` window event
 * and returns the Response unchanged. App.vue listens for this and clears
 * local auth state, forcing a re-render to Login. The current auth model
 * is binary — authed or not — so 401 is the only failure mode. If
 * role-based authorization lands later, 403 will be the "authed but not
 * permitted" path and this function will need to distinguish; until
 * that requirement exists, keeping both collapsed to 401-only removes
 * a speculative branch.
 */
export async function fetchWithAuth(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const { token } = useAuth();
  const headers = new Headers(init.headers ?? {});
  if (token.value) headers.set("Authorization", `Bearer ${token.value}`);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) emitAuthExpired();
  return res;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
  const res = await fetchWithAuth("/api/repos");
  return res.json();
}

function filtersToQuery(filters: DispatchFilters): string {
  const params = new URLSearchParams();
  if (filters.trigger) params.set("trigger", filters.trigger);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.status) params.set("status", filters.status);
  if (filters.since !== undefined) params.set("since", String(filters.since));
  if (filters.q) params.set("q", filters.q);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchDispatches(
  filters: DispatchFilters = {},
): Promise<Dispatch[]> {
  const res = await fetchWithAuth(`/api/dispatches${filtersToQuery(filters)}`);
  return res.json();
}

export async function fetchDispatchDetail(id: string): Promise<DispatchDetail> {
  const res = await fetchWithAuth(
    `/api/dispatches/${encodeURIComponent(id)}`,
  );
  return res.json();
}

/**
 * Fetch the per-repo agent snapshot list rendered on the Agents tab.
 * Each entry combines settings, dispatch counts, and worker reachability
 * — see `src/dashboard/agents-list.ts` for the response shape.
 */
export async function fetchAgents(): Promise<AgentSnapshot[]> {
  const res = await fetchWithAuth("/api/agents");
  if (!res.ok) throw new Error(`fetchAgents failed: ${res.status}`);
  return res.json();
}

export async function fetchSystemErrors(opts: {
  repo?: string;
  limit?: number;
} = {}): Promise<SystemError[]> {
  const params = new URLSearchParams();
  if (opts.repo) params.set("repo", opts.repo);
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetchWithAuth(
    `/api/system-errors${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) throw new Error(`fetchSystemErrors failed: ${res.status}`);
  const body = (await res.json()) as { events: SystemError[] };
  return body.events;
}

export async function fetchIssues(
  repo: string,
  opts: { includeClosed?: "recent" | "all" } = {},
): Promise<IssueListItem[]> {
  const params = new URLSearchParams({ repo });
  if (opts.includeClosed) params.set("include_closed", opts.includeClosed);
  const res = await fetchWithAuth(`/api/issues?${params.toString()}`);
  if (!res.ok) throw new Error(`fetchIssues failed: ${res.status}`);
  return res.json();
}

export async function fetchIssueDetail(
  repo: string,
  id: string,
): Promise<IssueDetail> {
  const params = new URLSearchParams({ repo });
  const res = await fetchWithAuth(
    `/api/issues/${encodeURIComponent(id)}?${params.toString()}`,
  );
  if (!res.ok) throw new Error(`fetchIssueDetail failed: ${res.status}`);
  return res.json();
}

/**
 * PATCH /api/issues/:id?repo=<name> — DX-236. Applies an allowlisted
 * patch (`status` / `title` / `description` / `ac` / `comments_append`
 * / `requires_human` / `reopen`) and returns the post-patch Issue.
 *
 * Errors surface as a `ToggleError` so callers can render the server's
 * `error` string inline (the dashboard write API uses the same
 * `{error: string}` shape as every other mutation route). 400 on
 * non-allowlisted fields, schema-invariant violations, or empty patch;
 * 404 when the YAML is missing in both `open/` and `closed/`.
 */
export async function patchIssue(
  repo: string,
  id: string,
  patch: IssuePatch,
): Promise<Issue> {
  const res = await fetchWithAuth(
    `/api/issues/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as { issue: Issue };
  return body.issue;
}

export async function fetchAgent(repo: string): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(`/api/agents/${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`fetchAgent failed: ${res.status}`);
  return res.json();
}

/**
 * GET /api/agents?repo=<name> — DX-159 Phase 1. Returns the empty
 * roster + agentDefaults.conflictCheckEnabled. The query-string variant
 * is the new shape; the path-style `/api/agents/:repo` continues to
 * return the per-repo aggregation snapshot consumed by the Settings
 * tab. Same path, two shapes — see `agents-toggles.ts#handleGetRoster` for rationale.
 */
export async function fetchAgentRoster(
  repo: string,
): Promise<AgentRosterResponse> {
  const res = await fetchWithAuth(
    `/api/agents?repo=${encodeURIComponent(repo)}`,
  );
  if (!res.ok) throw new Error(`fetchAgentRoster failed: ${res.status}`);
  return res.json();
}

// ── DX-160 Phase 2: Agent CRUD + avatar upload/serve ──────────────────

/**
 * Body shape for `createAgent` / `updateAgent`. PATCH allows any subset;
 * POST requires `name` plus all the non-optional fields. The server
 * stamps `type:"agent"` + timestamps, so callers never set those.
 */
export interface AgentCreateInput {
  name: string;
  bio: string;
  capabilities: string[];
  schedule: AgentSchedule;
  enabled: boolean;
  avatar_path?: string;
}

export type AgentUpdateInput = Partial<Omit<AgentCreateInput, "name">>;

async function readJsonError(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * POST /api/agents?repo=<name> — create one agent. Returns the new
 * record on 201; throws a `ToggleError` carrying the server message
 * for 4xx/5xx so the UI can render the error inline (e.g. 409 when
 * the 5-cap is reached or the name is duplicate).
 */
export async function createAgent(
  repo: string,
  input: AgentCreateInput,
): Promise<AgentRecordWithName> {
  const res = await fetchWithAuth(
    `/api/agents?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * PATCH /api/agents/:name?repo=<name> — partial update. `name` is
 * immutable on the server (400). Returns the refreshed record.
 */
export async function updateAgent(
  repo: string,
  name: string,
  input: AgentUpdateInput,
): Promise<AgentRecordWithName> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * DELETE /api/agents/:name?repo=<name>. 204 on success; 409 when a
 * non-terminal dispatch is in flight for the repo.
 */
export async function deleteAgent(
  repo: string,
  name: string,
): Promise<void> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
}

/**
 * POST /api/agents/:name/avatar?repo=<name> — raw binary upload. The
 * server validates MIME (png/jpeg/webp) and size (≤1 MB). Returns the
 * refreshed agent record carrying the new `avatar_path`.
 *
 * Note on the wire shape: the server accepts a raw body with the file's
 * MIME type in `Content-Type` (no multipart). The browser's `File`
 * object plugs in directly via `fetch(url, {body: file})` — `File.type`
 * carries the MIME and the bytes stream from the underlying blob.
 */
export async function uploadAgentAvatar(
  repo: string,
  name: string,
  file: File,
): Promise<AgentRecordWithName> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}/avatar?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * Fetch the avatar bytes via authed GET and return a `blob:` URL the
 * browser can render in `<img src>`. Returns `null` on 404 (no avatar
 * uploaded yet, or file missing on disk). Caller is responsible for
 * `URL.revokeObjectURL` on unmount to free memory.
 */
export async function fetchAgentAvatarUrl(
  repo: string,
  name: string,
): Promise<string | null> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}/avatar?repo=${encodeURIComponent(repo)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * PATCH /api/agents-settings?repo=<name> — toggle the per-repo
 * `agentDefaults.conflictCheckEnabled` flag. The Settings tab uses
 * this to expose the conflict-check switch alongside the env-feature
 * toggles. Returns the refreshed agentDefaults block. Errors surface
 * as a `ToggleError` for direct rendering.
 */
export async function patchAgentDefaults(
  repo: string,
  conflictCheckEnabled: boolean,
): Promise<{ settings: { conflictCheckEnabled: boolean } }> {
  const res = await fetchWithAuth(
    `/api/agents-settings?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conflictCheckEnabled }),
    },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

export interface ClearCriticalFailureResult {
  cleared: boolean;
}

/**
 * Clear the per-repo critical-failure flag. Delegates via the dashboard's
 * DELETE /api/agents/:repo/critical-failure proxy to the worker's
 * DELETE /api/poller/critical-failure. Idempotent: returns
 * `{cleared:true}` if the flag existed and was removed, `{cleared:false}`
 * if it was already absent. Caller should re-fetch the snapshot (via
 * `fetchAgent`) after a successful clear so the banner disappears.
 *
 * Auth: per-user bearer (NOT the dispatch token). Surfaces errors with
 * the same shape as `patchToggle` so the page can render them the same
 * way.
 */
export async function clearCriticalFailure(
  repo: string,
): Promise<ClearCriticalFailureResult> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/critical-failure`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

export interface ToggleError extends Error {
  status: number;
  serverMessage?: string;
}

function toggleError(status: number, serverMessage?: string): ToggleError {
  const err = new Error(
    serverMessage || `patchToggle failed: ${status}`,
  ) as ToggleError;
  err.status = status;
  err.serverMessage = serverMessage;
  return err;
}

/**
 * Toggle a feature on/off for a repo. `enabled` may be null to reset back
 * to the env default. Responds with the refreshed snapshot so the caller
 * can commit the optimistic update without a re-fetch. Auth flows through
 * `fetchWithAuth` — the PATCH route requires a user bearer token. A 401
 * fires the `auth:expired` event which App.vue handles by redirecting to
 * Login (see Phase 4 auth contract).
 */
export async function patchToggle(
  repo: string,
  feature: Feature,
  enabled: boolean | null,
): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/toggles`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature, enabled }),
    },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

export interface TrelloCredentialPatch {
  apiKey?: string;
  apiToken?: string;
}

export interface TrelloCredentialResult {
  updated: Array<"apiKey" | "apiToken">;
  restartRequired: boolean;
}

/**
 * PATCH /api/agents/:repo/trello-credentials — DX-303. Rotates the
 * `DANX_TRELLO_API_KEY` / `DANX_TRELLO_API_TOKEN` entries in the repo's
 * `.danxbot/.env`. Body MUST carry at least one of `apiKey` / `apiToken`;
 * untouched fields are omitted so the request never accidentally
 * overwrites the other credential. The server returns the list of fields
 * actually rotated plus a `restartRequired` flag (the worker captures
 * the RepoContext at boot, so a live swap is not yet wired). Errors
 * surface as a `ToggleError` so the dashboard can render the server's
 * `error` string inline.
 */
export async function patchTrelloCredentials(
  repo: string,
  patch: TrelloCredentialPatch,
): Promise<TrelloCredentialResult> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/trello-credentials`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

export interface IssuePrefixResult {
  prefix: string;
  migratedFiles: number;
}

/**
 * PUT /api/agents/:repo/issue-prefix — DX-103. Operator flips a repo's
 * `issue_prefix`; backend runs the file-rename + content-rewrite
 * migration synchronously and returns `{prefix, migratedFiles}`. Errors
 * surface as a `ToggleError` with the server's `error` string for
 * direct rendering.
 */
export async function putIssuePrefix(
  repo: string,
  prefix: string,
): Promise<IssuePrefixResult> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/issue-prefix`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    },
  );
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw toggleError(res.status, message);
  }
  return res.json();
}

export interface ResetAllDataResult {
  tablesCleared: string[];
  rowsDeleted: number;
  perTable: Record<string, number>;
}

/**
 * Wipe operational data (dispatches, threads, events, health_check).
 * Users + api_tokens are preserved so the current session stays valid.
 * POST body must include the sentinel `{confirm:"RESET"}` — this is a
 * defense-in-depth guard against accidental POSTs. The dashboard's
 * SettingsPage supplies the sentinel after a DanxDialog confirm flow.
 */
export async function resetAllData(): Promise<ResetAllDataResult> {
  const res = await fetchWithAuth("/api/admin/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "RESET" }),
  });
  if (!res.ok) {
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message || `resetAllData failed: ${res.status}`);
  }
  return res.json();
}

// ── Agent Chat (DX-84) ───────────────────────────────────────────────

/**
 * Chat session summary returned by the chat list endpoints. Wire shape
 * matches `chat-routes.ts#ChatSessionSummary` — keep them in sync.
 */
export interface ChatSessionSummary {
  job_id: string;
  parent_job_id: string | null;
  issue_id: string | null;
  repo: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  summary: string | null;
  started_at: number;
  completed_at: number | null;
  tokens_total: number;
  tool_call_count: number;
  subagent_count: number;
}

export interface ChatTimelinePayload {
  blocks: JsonlBlock[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheWrite: number;
    tokensTotal: number;
    toolCallCount: number;
  };
  chain: string[];
}

export async function listChatSessions(
  issueId: string,
): Promise<ChatSessionSummary[]> {
  const res = await fetchWithAuth(
    `/api/chat/sessions?issue_id=${encodeURIComponent(issueId)}`,
  );
  if (!res.ok) throw new Error(`listChatSessions failed: ${res.status}`);
  return res.json();
}

export async function listBoardChatSessions(
  repo: string,
): Promise<ChatSessionSummary[]> {
  const res = await fetchWithAuth(
    `/api/chat/sessions/board?repo=${encodeURIComponent(repo)}`,
  );
  if (!res.ok) throw new Error(`listBoardChatSessions failed: ${res.status}`);
  return res.json();
}

export async function fetchChatTimeline(
  jobId: string,
): Promise<ChatTimelinePayload> {
  const res = await fetchWithAuth(
    `/api/chat/sessions/${encodeURIComponent(jobId)}/timeline`,
  );
  if (!res.ok) throw new Error(`fetchChatTimeline failed: ${res.status}`);
  return res.json();
}

export async function startBoardChat(
  repo: string,
  task: string,
): Promise<{ job_id: string; status: string }> {
  const res = await fetchWithAuth("/api/chat/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, task }),
  });
  if (!res.ok) throw new Error(`startBoardChat failed: ${res.status}`);
  return res.json();
}

export async function postChatMessage(
  jobId: string,
  task: string,
): Promise<{ job_id: string; parent_job_id: string; status: string }> {
  const res = await fetchWithAuth(
    `/api/chat/sessions/${encodeURIComponent(jobId)}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    },
  );
  if (!res.ok) throw new Error(`postChatMessage failed: ${res.status}`);
  return res.json();
}

export async function cancelChatSession(
  jobId: string,
): Promise<{ status: string }> {
  const res = await fetchWithAuth(
    `/api/chat/sessions/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`cancelChatSession failed: ${res.status}`);
  return res.json();
}

/**
 * Live-follow a chat session via the same multiplexed SSE stream that
 * powers `followDispatch`. The chat session route
 * `/api/chat/sessions/:id/stream` is a thin alias — using the typed
 * follow function below keeps the auth + reconnect contract identical
 * (the SPA's `useStream` composable is the single SSE consumer).
 */
export function followChatSession(
  jobId: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  return followDispatch(jobId, onBlock, onError);
}

/**
 * Live-follow a dispatch via the multiplexed SSE stream. Subscribes to the
 * `dispatch:jsonl:<id>` topic and invokes `onBlock` once per parsed
 * `JsonlBlock` in each batch the backend publishes.
 *
 * Each call spawns its own `useStream()` instance — `disconnect()` on
 * teardown affects only this follow, not any sibling composable (useAgents,
 * useDispatches) that also talks to `/api/stream`.
 *
 * `onError` is invoked at most once, on the first transition from
 * `connecting`/`connected` back to `disconnected`. `useStream` will then
 * reconnect on its own with exponential backoff — this mirrors the original
 * "called once when stream terminates" contract from the pre-Phase-6
 * dedicated follow-route implementation so the existing `DispatchDetail.vue`
 * caller (which passes a no-op `onError`) stays unchanged.
 */
export function followDispatch(
  id: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  const stream = useStream();
  let errored = false;

  const unsub = stream.subscribe(`dispatch:jsonl:${id}`, (event) => {
    if (!Array.isArray(event.data)) {
      console.warn(
        `followDispatch(${id}): expected JsonlBlock[] payload, got`,
        event.data,
      );
      return;
    }
    for (const block of event.data as JsonlBlock[]) onBlock(block);
  });

  const stopWatch = watch(stream.connectionState, (state, prev) => {
    if (
      !errored &&
      state === "disconnected" &&
      (prev === "connecting" || prev === "connected")
    ) {
      errored = true;
      onError();
    }
  });

  return () => {
    stopWatch();
    unsub();
    stream.disconnect();
  };
}
