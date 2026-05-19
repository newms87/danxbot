import type {
  Issue,
  IssueCopyPayload,
  IssueDetail,
  IssueListItem,
  IssuePatch,
  ListType,
} from "../types";
import {
  fetchWithAuth,
  jsonRequest,
  labelRequest,
  readJsonError,
  toggleError,
} from "./_request";

export async function fetchIssues(
  repo: string,
  opts: { includeClosed?: "recent" | "all" } = {},
): Promise<IssueListItem[]> {
  const params = new URLSearchParams({ repo });
  if (opts.includeClosed) params.set("include_closed", opts.includeClosed);
  return labelRequest("fetchIssues", "GET", `/api/issues?${params.toString()}`);
}

export async function fetchIssueDetail(
  repo: string,
  id: string,
): Promise<IssueDetail> {
  return labelRequest(
    "fetchIssueDetail",
    "GET",
    `/api/issues/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
  );
}

/**
 * Issue mutation responses carry both the full Issue (drawer affordances)
 * and the projected list item (board optimistic refresh). Both come from
 * the same `projectIssue` projector that powers REST + SSE.
 */
export interface PatchIssueResult {
  issue: Issue;
  item: IssueListItem;
}

/**
 * DX-236. Allowlisted patch (`status` / `title` / `description` / `ac` /
 * `comments_append` / `requires_human` / `reopen`); 400 on
 * non-allowlisted fields or schema-invariant violations; 404 when the
 * YAML is missing in both `open/` and `closed/`.
 */
export async function patchIssue(
  repo: string,
  id: string,
  patch: IssuePatch,
): Promise<PatchIssueResult> {
  return jsonRequest(
    "PATCH",
    `/api/issues/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`,
    patch,
  );
}

/** DX-631 (Phase 5 of DX-626) — cascade endpoint body shape. */
export type CascadeAction =
  | { kind: "stay" }
  | { kind: "move_same_type" }
  | { kind: "move_to"; listType: ListType; listName: string };

export interface CascadeIssueListBody {
  epic_id: string;
  dest_list_name: string;
  overrides?: Record<string, CascadeAction>;
}

export interface CascadeIssueListResult {
  updated: string[];
  skipped: string[];
}

/**
 * Thrown on 409 `Unblock confirm required`. Carries the descendant ids
 * the operator must confirm before retrying. Other status codes surface
 * as plain `ToggleError`.
 */
export class CascadeUnblockRequiredError extends Error {
  constructor(public readonly blockedDescendants: string[]) {
    super("Unblock confirm required");
    this.name = "CascadeUnblockRequiredError";
  }
}

/**
 * DX-631 — cascade move spanning epic + descendants per the 5×5
 * `cascadeEpicMove` table. 409 → `CascadeUnblockRequiredError` so the
 * dialog can render per-row confirmation checkboxes.
 */
export async function patchIssueCascade(
  repo: string,
  body: CascadeIssueListBody,
): Promise<CascadeIssueListResult> {
  const res = await fetchWithAuth(
    `/api/issues/cascade?repo=${encodeURIComponent(repo)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 409) {
    let payload: { blocked_descendants?: unknown } = {};
    try {
      payload = (await res.json()) as { blocked_descendants?: unknown };
    } catch {
      /* fall through with empty payload */
    }
    const ids = Array.isArray(payload.blocked_descendants)
      ? payload.blocked_descendants.filter(
          (x): x is string => typeof x === "string",
        )
      : [];
    throw new CascadeUnblockRequiredError(ids);
  }
  if (!res.ok) throw toggleError(res.status, await readJsonError(res));
  return (await res.json()) as CascadeIssueListResult;
}

export interface DeleteIssueResult {
  removed: string[];
}

/**
 * Soft-delete: move YAML out of the watched tree → chokidar `unlink` →
 * tombstoned DB row → SSE `issue:updated` `removed: true`. Server-side
 * cascade default `true`; pass `false` to delete a single card + orphan
 * its descendants.
 */
export async function deleteIssue(
  repo: string,
  id: string,
  options: { cascade?: boolean } = {},
): Promise<DeleteIssueResult> {
  const params = new URLSearchParams({ repo });
  if (options.cascade === false) params.set("cascade", "false");
  return jsonRequest(
    "DELETE",
    `/api/issues/${encodeURIComponent(id)}?${params.toString()}`,
  );
}

/** DX-350 — narrowed subset of `IssueStatus` accepted by the create surface. */
export type IssueCreateStatus = Extract<Issue["status"], "Review" | "ToDo">;

export interface IssueCreateInput {
  title: string;
  description: string;
  status: IssueCreateStatus;
  type: Issue["type"];
  /** DX-544 — optional priority; server clamps to `[MIN, MAX]`, defaults to 3.0. */
  priority?: number;
}

/** DX-350 — human-driven create. Server allocates the next `<PREFIX>-N`. */
export async function createIssue(
  repo: string,
  input: IssueCreateInput,
): Promise<PatchIssueResult> {
  return jsonRequest(
    "POST",
    `/api/issues?repo=${encodeURIComponent(repo)}`,
    input,
  );
}

/**
 * DX-519. Reads root + every descendant, strips repo-specific bits
 * (external_id, tracker, dispatch, triage, history, assigned_agent,
 * comment ids, ac check_item_ids). 404 = missing root or incoherent
 * subtree.
 */
export async function getIssueSubtree(
  repo: string,
  id: string,
): Promise<IssueCopyPayload> {
  return jsonRequest(
    "GET",
    `/api/issues/${encodeURIComponent(id)}/subtree?repo=${encodeURIComponent(repo)}`,
  );
}

/**
 * DX-519 paste handler. Server allocates fresh ids for every issue,
 * rewrites every internal reference (`parent_id`, `children[]`,
 * `waiting_on.by[]`, `conflict_on[].id`, `retro.action_item_ids[]`), and
 * atomically writes every YAML or none.
 */
export async function importIssues(
  repo: string,
  payload: IssueCopyPayload,
): Promise<{ topId: string; issues: Issue[] }> {
  return jsonRequest(
    "POST",
    `/api/issues/import?repo=${encodeURIComponent(repo)}`,
    payload,
  );
}

/**
 * Operator-directed triage orchestrator dispatch. Forwards `{repo,
 * instructions?}` to the worker's `/api/triage`. `instructions`, when
 * present, becomes a `## Operator notes` block overriding scope/criteria.
 */
export async function triggerTriage(
  repo: string,
  instructions: string | null,
): Promise<{ jobId?: string; status?: string }> {
  const body: Record<string, unknown> = { repo };
  if (instructions !== null) body.instructions = instructions;
  const json = await jsonRequest<{ job_id?: string; status?: string }>(
    "POST",
    "/api/triage",
    body,
  );
  return { jobId: json.job_id, status: json.status };
}

/** DX-349 — fire-and-forget flesh-out after a stub-card create. */
export async function fleshOutIssue(
  repo: string,
  issueId: string,
): Promise<{ jobId?: string }> {
  return jsonRequest("POST", "/api/flesh-out", { repo, issue_id: issueId });
}
