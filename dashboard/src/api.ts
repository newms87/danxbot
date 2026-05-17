import { watch } from "vue";
import type {
  AgentRecordWithName,
  AgentRosterResponse,
  AgentSchedule,
  AgentSnapshot,
  ClassifiedTrelloMapping,
  CreateListInput,
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  EffortLevelMapping,
  EffortLevelName,
  Feature,
  Issue,
  IssueCopyPayload,
  IssueDetail,
  IssueListItem,
  IssuePatch,
  JsonlBlock,
  List,
  ListsFile,
  RepairErrorWithAttempts,
  SyncRootStateEntry,
  SystemError,
  TrelloListMap,
  TrelloListSummary,
  UpdateListInput,
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

/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair): typed fetchers for the
 * persistent `system_errors` table + per-attempt repair history the
 * Self-Repair tab renders. Distinct from `fetchSystemErrors` (DX-134),
 * which surfaces the ephemeral in-memory event ring used by the banner.
 */
export async function fetchRepairErrors(opts: {
  repo?: string;
  limit?: number;
} = {}): Promise<RepairErrorWithAttempts[]> {
  const params = new URLSearchParams();
  if (opts.repo) params.set("repo", opts.repo);
  if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetchWithAuth(
    `/api/self-repair/errors${qs ? `?${qs}` : ""}`,
  );
  if (!res.ok) throw new Error(`fetchRepairErrors failed: ${res.status}`);
  const body = (await res.json()) as { errors: RepairErrorWithAttempts[] };
  return body.errors;
}

export async function fetchRepairErrorDetail(
  id: number,
): Promise<RepairErrorWithAttempts> {
  const res = await fetchWithAuth(
    `/api/self-repair/errors/${encodeURIComponent(String(id))}`,
  );
  if (!res.ok) throw new Error(`fetchRepairErrorDetail failed: ${res.status}`);
  return res.json();
}

export async function resetRepairErrorById(
  id: number,
): Promise<{ row: RepairErrorWithAttempts["error"] }> {
  const res = await fetchWithAuth(
    `/api/self-repair/errors/${encodeURIComponent(String(id))}/reset`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`resetRepairError failed: ${res.status}`);
  return res.json();
}

export async function markRepairErrorUnfixable(
  id: number,
): Promise<{ row: RepairErrorWithAttempts["error"] }> {
  const res = await fetchWithAuth(
    `/api/self-repair/errors/${encodeURIComponent(String(id))}/unfixable`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`markUnfixable failed: ${res.status}`);
  return res.json();
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
/**
 * PATCH response carries BOTH the post-patch Issue (used by the drawer's
 * inline edit affordances) AND the server-projected IssueListItem (used
 * by the board's optimistic list-row refresh). Both come from the same
 * `projectIssue` projector that powers REST + SSE, so the wire shape is
 * canonical across every code path.
 */
export interface PatchIssueResult {
  issue: Issue;
  item: IssueListItem;
}

export async function patchIssue(
  repo: string,
  id: string,
  patch: IssuePatch,
): Promise<PatchIssueResult> {
  const res = await fetchWithAuth(
    `/api/issues/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as PatchIssueResult;
  return body;
}

/**
 * DELETE /api/issues/:id?repo=<name>&cascade=<bool> — soft-delete a
 * card by moving its YAML out of the watched issues tree into
 * `/tmp/danxbot/<repo>/issues/`. Chokidar `unlink` flips the DB row to
 * tombstoned; SSE `issue:updated` `removed: true` drops the row from
 * every subscriber. Cascade defaults to `true` server-side — the SPA's
 * confirm dialog shows the descendant count, so an un-specified flag
 * means "operator confirmed the cascade." Pass `false` to delete a
 * single card and orphan its descendants.
 */
export interface DeleteIssueResult {
  removed: string[];
}

export async function deleteIssue(
  repo: string,
  id: string,
  options: { cascade?: boolean } = {},
): Promise<DeleteIssueResult> {
  const params = new URLSearchParams({ repo });
  if (options.cascade === false) params.set("cascade", "false");
  const res = await fetchWithAuth(
    `/api/issues/${encodeURIComponent(id)}?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as DeleteIssueResult;
}

/**
 * Statuses the human-driven create surface accepts (DX-350). A narrowed
 * subset of `IssueStatus` — Review (operator wants triage + flesh-out)
 * or ToDo (operator already knows the scope). Other statuses come from
 * the agent path or follow-up PATCH, not from create.
 */
export type IssueCreateStatus = Extract<Issue["status"], "Review" | "ToDo">;

/**
 * Body shape for `createIssue` / `POST /api/issues`. DX-350. Mirrors the
 * server-side `IssueCreateInput`. Status + type narrow to the canonical
 * `Issue` shape so a future server-side allowlist bump propagates here
 * without a second source-of-truth drift.
 */
export interface IssueCreateInput {
  title: string;
  description: string;
  status: IssueCreateStatus;
  type: Issue["type"];
  /**
   * Optional operator-chosen priority (DX-544). Finite number; clamped on
   * the server into `[PRIORITY_MIN, PRIORITY_MAX]`. Omitted → server falls
   * back to `PRIORITY_DEFAULT` (3.0).
   */
  priority?: number;
}

/**
 * POST /api/issues?repo=<name> — DX-350. Human-driven create surface for
 * the Create Card dialog. Server allocates the next `<PREFIX>-N`, writes
 * the YAML, publishes `issue:updated` SSE, and returns the parsed Issue.
 *
 * Errors surface as a `ToggleError` carrying the server's error string
 * — typically 400 (missing field, wrong status, wrong type) or 401
 * (auth expired).
 */
export async function createIssue(
  repo: string,
  input: IssueCreateInput,
): Promise<PatchIssueResult> {
  const res = await fetchWithAuth(
    `/api/issues?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as PatchIssueResult;
  return body;
}

/**
 * GET /api/issues/:id/subtree?repo=<name> — DX-519. Reads the root issue
 * plus every descendant in `children[]` recursively, strips repo-specific
 * bits (external_id, tracker, dispatch, triage, history, assigned_agent,
 * position, comment ids, ac check_item_ids), and returns the resulting
 * `IssueCopyPayload`. The Copy button in the drawer writes the JSON
 * response to the clipboard via `navigator.clipboard.writeText`.
 *
 * Errors surface as a `ToggleError`. 404 when the root id is missing or
 * a descendant is missing (incoherent subtree).
 */
export async function getIssueSubtree(
  repo: string,
  id: string,
): Promise<IssueCopyPayload> {
  const params = new URLSearchParams({ repo });
  const res = await fetchWithAuth(
    `/api/issues/${encodeURIComponent(id)}/subtree?${params.toString()}`,
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as IssueCopyPayload;
}

/**
 * POST /api/issues/import?repo=<name> — DX-519. Paste handler. The
 * server allocates fresh `<PREFIX>-N` ids for every issue in the
 * payload, rewrites every internal reference (`parent_id`, `children[]`,
 * `waiting_on.by[]`, `conflict_on[].id`, `retro.action_item_ids[]`) to
 * point at the new ids, and atomically writes every YAML or none.
 *
 * Returns `{topId, issues}` so the caller can open the drawer on the
 * new top-level card without waiting for the SSE round-trip.
 *
 * Errors surface as a `ToggleError`. 400 on payload shape failures
 * (missing schema_version, empty issues[], bad id shape) or
 * round-trip validation failure (e.g. invalid status enum after
 * rewrite); 401 on auth; 404 on unknown repo.
 */
export async function importIssues(
  repo: string,
  payload: IssueCopyPayload,
): Promise<{ topId: string; issues: Issue[] }> {
  const res = await fetchWithAuth(
    `/api/issues/import?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as { topId: string; issues: Issue[] };
}

/**
 * POST /api/triage — operator-directed triage orchestrator dispatch.
 * Forwards `{repo, instructions?}` to the dashboard's triage proxy, which
 * forwards to the worker's `/api/triage` route. The dispatched
 * orchestrator agent (`danxbot:danx-triage-orchestrator`) picks targets
 * from the Review list (default scope), then fans out per-card subagents
 * in parallel batches of 3 to apply the `danx-triage-card` decision
 * tree. `instructions`, when present, flow through as a `## Operator
 * notes` block that overrides scope / criteria for this pass.
 *
 * Returns the worker's dispatch metadata so the caller can correlate the
 * new dispatch row from the SSE bus when needed. Errors surface as a
 * `ToggleError` so the dialog can render the server's `error` string
 * inline (4xx from validation) or a generic retry hint (5xx).
 */
export async function triggerTriage(
  repo: string,
  instructions: string | null,
): Promise<{ jobId?: string; status?: string }> {
  const body: Record<string, unknown> = { repo };
  if (instructions !== null) body.instructions = instructions;
  const res = await fetchWithAuth("/api/triage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const json = (await res.json()) as { job_id?: string; status?: string };
  return { jobId: json.job_id, status: json.status };
}

/**
 * POST /api/cancel/:jobId?repo=<name> — cancel an in-flight dispatch.
 * Dual-auth proxy (per-user bearer or dispatch token); the SPA uses the
 * user bearer. Worker's cancel handler stops the agent process tree and
 * finalizes the row as `cancelled`. The SSE bus surfaces the status
 * change without a separate refetch.
 */
export async function cancelDispatch(
  repo: string,
  jobId: string,
): Promise<void> {
  const res = await fetchWithAuth(
    `/api/cancel/${encodeURIComponent(jobId)}?repo=${encodeURIComponent(repo)}`,
    { method: "POST" },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
}

/**
 * POST /api/flesh-out — DX-349. Fire-and-forget dispatch to flesh out a
 * freshly-created stub card. The dashboard fires this after a successful
 * `createIssue` so the agent rewrites the description, populates ac[],
 * and (if status: Review) ICE-scores the card. Returns the worker's
 * dispatch metadata. Callers ignore the response (the SSE-driven UI
 * surfaces the card's growth over the next ~30-60s).
 */
export async function fleshOutIssue(
  repo: string,
  issueId: string,
): Promise<{ jobId?: string }> {
  const res = await fetchWithAuth("/api/flesh-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, issue_id: issueId }),
  });
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as { jobId?: string };
}

export async function fetchAgent(repo: string): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(`/api/agents/${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`fetchAgent failed: ${res.status}`);
  return res.json();
}

/**
 * GET /api/agents?repo=<name> — DX-159 Phase 1. Returns the agent
 * roster for one repo. The query-string variant is the new shape; the
 * path-style `/api/agents/:repo` continues to return the per-repo
 * aggregation snapshot consumed by the Settings tab. Same path, two
 * shapes — see `agents-toggles.ts#handleGetRoster` for rationale.
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

export type AgentUpdateInput = Partial<Omit<AgentCreateInput, "name">> & {
  /**
   * DX-510 — operator-tunable per-agent effort label. Validated server-
   * side against the seven canonical names; `null` / absent preserves
   * the existing value (reader defaults to `"medium"`).
   */
  effortLevel?: EffortLevelName;
};

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
 * PATCH /api/agents/:name?repo=<name> with `{broken: null}` — DX-298
 * "Mark Resolved" clear path. The dashboard cannot SET broken (that's
 * the worker's prep verdict route); the only legal write here is the
 * null clear. Returns the refreshed agent record on 200.
 *
 * Pairs with the SSE `agent:updated` topic — after a successful clear,
 * every connected dashboard sees the agent return to the dispatchable
 * pool without a manual refetch.
 */
export async function clearAgentBroken(
  repo: string,
  name: string,
): Promise<AgentRecordWithName> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(name)}?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broken: null }),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * DX-369 (Phase 6 of DX-363) — POST /api/agents/:repo/unblock.
 * Operator-driven "Unblock + reset strikes" action surfaced on the
 * persistent broken-agents banner. Proxies to the worker's
 * `/api/clear-broken` (which clears `agent.broken = null`, zeros
 * `agent.strikes.count`, preserves `strikes.history` as audit). The
 * `agents-watcher` chokidar feed picks up the settings.json change
 * and fans out `agent:updated` on the SSE bus so the banner row
 * disappears in every connected tab.
 *
 * On error the server's `error` string surfaces via `ToggleError` so
 * the banner can render the message inline.
 */
export async function postAgentUnblock(
  repo: string,
  name: string,
): Promise<{
  status: "cleared";
  repo: string;
  agent: string;
  cleared_strikes: { count: number; history: unknown[] } | null;
}> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/unblock`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

/**
 * DX-369 — POST /api/agents/:repo/re-run-evaluator. Operator-driven
 * "Re-run evaluator" action on the broken-agents banner. Forwards to
 * the worker's `/api/re-run-evaluator` (DX-367), which flips
 * `broken.evaluator_status` back to `"pending"` and emits a fresh
 * `broken-transition` event so the system-evaluator dispatcher
 * re-spawns.
 */
export async function postAgentReRunEvaluator(
  repo: string,
  name: string,
): Promise<{
  status: "queued";
  repo: string;
  agent: string;
}> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/re-run-evaluator`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
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

export interface EffortSettingsPatch {
  effortLevels?: EffortLevelMapping[];
  effortAssignmentPrompt?: string;
}

/**
 * PATCH /api/agents/:repo/effort-settings — DX-510. Operator updates
 * to the effort ladder + the per-agent assignment prompt. Body MUST
 * carry at least one of `effortLevels` / `effortAssignmentPrompt`; the
 * server validates the array length + canonical name order and returns
 * the refreshed `AgentSnapshot` so the SPA can commit without a second
 * fetch. SSE `agent:updated` is published on the same write so other
 * tabs reconcile in real time.
 */
export async function patchEffortSettings(
  repo: string,
  patch: EffortSettingsPatch,
): Promise<AgentSnapshot> {
  const res = await fetchWithAuth(
    `/api/agents/${encodeURIComponent(repo)}/effort-settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return res.json();
}

// ── Lists CRUD (DX-602 routes, DX-603 consumer) ─────────────────────

/**
 * GET /api/lists?repo=<name> — DX-602. Returns the operator-owned per-repo
 * list taxonomy: the seven seeded lists + any operator additions. Wire
 * shape: `{file: ListsFile}` — the wrapper survives possible future
 * companions (e.g. `{file, computed: {...}}`) without breaking callers.
 *
 * Hot-path consumer is the `useListColors` composable; rare callers may
 * fetch directly when they need the full taxonomy outside the composable's
 * SSE pipeline. Auth: per-user bearer (same as the rest of the dashboard
 * write surface).
 */
export async function fetchLists(repo: string): Promise<ListsFile> {
  const res = await fetchWithAuth(
    `/api/lists?repo=${encodeURIComponent(repo)}`,
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as { file: ListsFile };
  return body.file;
}

/**
 * POST /api/lists?repo=<name> — DX-602. Append a new list. Server picks the
 * id + (optionally) the order; pass `is_default_for_type: true` to promote
 * the new list to the type's default (server demotes the prior default in
 * the same atomic write). Returns `{list, file}` so the caller can both
 * spotlight the new row AND replace its in-memory taxonomy snapshot
 * without a second fetch.
 */
export async function createList(
  repo: string,
  input: CreateListInput,
): Promise<{ list: List; file: ListsFile }> {
  const res = await fetchWithAuth(
    `/api/lists?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readListsError(res));
  return res.json();
}

/**
 * PATCH /api/lists/:id?repo=<name> — DX-602. Rename / promote-default /
 * recolor / reorder. `type` is intentionally not patchable on the server
 * (see `lists-file.ts#UpdateListInput`). Returns `{list, file}` so callers
 * can reconcile the affected row + the full taxonomy in one round-trip.
 */
export async function patchList(
  repo: string,
  id: string,
  patch: UpdateListInput,
): Promise<{ list: List; file: ListsFile }> {
  const res = await fetchWithAuth(
    `/api/lists/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readListsError(res));
  return res.json();
}

/**
 * POST /api/lists/swap-order?repo=<name> — DX-608. Atomically swap two
 * lists' `order` integers under the per-repo lock. Replaces the
 * client-side paired-PATCH dance whose transactional gap could leave
 * the taxonomy with two lists sharing one `order` if the second PATCH
 * raced. Returns the post-swap `ListsFile`; SSE reconciles in parallel.
 */
export async function swapListOrder(
  repo: string,
  aId: string,
  bId: string,
): Promise<ListsFile> {
  const res = await fetchWithAuth(
    `/api/lists/swap-order?repo=${encodeURIComponent(repo)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a_id: aId, b_id: bId }),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readListsError(res));
  const body = (await res.json()) as { file: ListsFile };
  return body.file;
}

export interface DeleteListResult {
  deleted: List;
  reassignTo: List;
  reassignedCount: number;
  file: ListsFile;
}

/**
 * DELETE /api/lists/:id?repo=<name> — DX-602. Server refuses last-of-type
 * with 409 (validator error string carries the explanation). On success
 * returns the deleted list, the list that orphaned cards reassigned to,
 * the number of card YAMLs rewritten, and the updated taxonomy.
 */
export async function deleteList(
  repo: string,
  id: string,
): Promise<DeleteListResult> {
  const res = await fetchWithAuth(
    `/api/lists/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw toggleError(res.status, await readListsError(res));
  return res.json();
}

/**
 * The lists routes return validation failures as `{errors: string[]}`
 * (one per invariant violation) instead of the dashboard's common
 * `{error: string}` shape. Join them for the inline-render path so the
 * operator sees every failed invariant at once (often "name must be
 * non-empty" + "color must be a hex color" land together on the same
 * POST).
 */
async function readListsError(res: Response): Promise<string | undefined> {
  try {
    const body = await res.json();
    if (Array.isArray(body?.errors)) {
      const joined = body.errors.filter((s: unknown) => typeof s === "string").join("; ");
      if (joined.length > 0) return joined;
    }
    if (typeof body?.error === "string") return body.error;
  } catch {
    /* ignore */
  }
  return undefined;
}

// ── DX-611 (Phase 8b.3) — Trello list mapping ───────────────────────

/**
 * Wire shape of `GET /api/trello/list-mapping?repo=<name>`. The Settings
 * UI reads ALL of it: `map` seeds the dropdown selections, `classification`
 * drives the per-row badges, `trello_available` toggles the transient
 * "Trello unreachable" banner, `board_configured` hides the whole panel
 * when the repo has no Trello board id wired up in `trello.yml`.
 */
export interface TrelloListMappingResponse {
  map: TrelloListMap;
  classification: Record<string, ClassifiedTrelloMapping>;
  trello_available: boolean;
  board_configured: boolean;
}

export interface TrelloBoardListsResponse {
  lists: TrelloListSummary[];
}

/**
 * GET /api/trello/list-mapping?repo=<name>. Returns the persisted map +
 * the live classification + the two SPA gates. 401 on auth, 400/404 on
 * repo, otherwise 200.
 */
export async function fetchTrelloListMapping(
  repo: string,
): Promise<TrelloListMappingResponse> {
  const res = await fetchWithAuth(
    `/api/trello/list-mapping?repo=${encodeURIComponent(repo)}`,
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as TrelloListMappingResponse;
}

/**
 * GET /api/trello/board-lists?repo=<name>&refresh=<0|1>. `refresh=true`
 * appends `refresh=1` so the route bypasses the server-side 30s cache —
 * the Settings UI's "Re-fetch board lists" button uses this to force a
 * fresh upstream call. Trello-unreachable / no-creds surfaces as a 502 /
 * 503 carrying `{error, trello_status?}` — the caller converts to a
 * `ToggleError` so the panel can render the upstream message inline.
 */
export async function fetchTrelloBoardLists(
  repo: string,
  options: { refresh?: boolean } = {},
): Promise<TrelloListSummary[]> {
  const params = new URLSearchParams({ repo });
  if (options.refresh) params.set("refresh", "1");
  const res = await fetchWithAuth(
    `/api/trello/board-lists?${params.toString()}`,
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as TrelloBoardListsResponse;
  return body.lists;
}

/**
 * PATCH /api/trello/list-mapping?repo=<name>. Server validates against
 * the known danxbot list ids + atomically writes the file under the
 * per-repo lock + publishes `trello-list-map:updated` on the SSE bus.
 * Returns the post-write map (round-trip lets the SPA reconcile without
 * waiting for SSE on the same tab).
 */
export async function patchTrelloListMapping(
  repo: string,
  map: TrelloListMap,
): Promise<TrelloListMap> {
  const res = await fetchWithAuth(
    `/api/trello/list-mapping?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ map }),
    },
  );
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  const body = (await res.json()) as { map: TrelloListMap };
  return body.map;
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
// ── Per-card chat (DX-352 Phase 4) ───────────────────────────────────
//
// Symmetric with the `POST /api/chat` worker route (DX-351 Phase 3).
// Independent of the DX-84 board-chat wrappers above: that path posts
// to `/api/chat/sessions/:jobId/resume` with a `jobId`; this one posts
// to `/api/chat` with `{repo, issue_id}` and lets the worker decide
// FRESH vs RESUME from the per-card `chat-sessions/<id>.json` cache.
// Per-card chat surfaces under the issue drawer's Chat tab and rides
// the stable `chat:<ISS-N>` SSE alias topic.
export async function sendChatMessage(
  repo: string,
  issueId: string,
  text: string,
): Promise<{ job_id: string; parent_job_id: string | null; status: string }> {
  const res = await fetchWithAuth("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, issue_id: issueId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `sendChatMessage failed: ${res.status}${body ? ` — ${body}` : ""}`,
    );
  }
  return res.json();
}

/**
 * DX-558 — initial-hydrate fetch for the root-clone sync banner.
 * Returns one entry per repo that is currently in error state; empty
 * array when every root clone is in sync. Subsequent updates flow
 * over the `/api/stream` SSE channel via `useRepoRootSync`.
 */
export async function fetchSyncRootStates(): Promise<SyncRootStateEntry[]> {
  const res = await fetchWithAuth("/api/sync-root");
  if (!res.ok) throw new Error(`fetchSyncRootStates failed: ${res.status}`);
  const body = (await res.json()) as { states: SyncRootStateEntry[] };
  return body.states;
}

/** DX-558 — "Retry now" button: kick a fresh sync against the named repo's root clone. */
export async function retrySyncRoot(repoName: string): Promise<void> {
  const res = await fetchWithAuth(
    `/api/sync-root/${encodeURIComponent(repoName)}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`retrySyncRoot failed: ${res.status}${body ? ` — ${body}` : ""}`);
  }
}

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
