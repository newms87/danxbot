import { jsonRequest } from "./_request";

// ── Trello credentials (DX-303) ─────────────────────────────────────

export interface TrelloCredentialPatch {
  apiKey?: string;
  apiToken?: string;
}

export interface TrelloCredentialResult {
  updated: Array<"apiKey" | "apiToken">;
  restartRequired: boolean;
}

/**
 * Rotates `DANX_TRELLO_API_KEY` / `DANX_TRELLO_API_TOKEN` in
 * `<repo>/.danxbot/.env`. Body MUST carry at least one of the two;
 * untouched fields are omitted so the other credential is never
 * accidentally overwritten.
 */
export async function patchTrelloCredentials(
  repo: string,
  patch: TrelloCredentialPatch,
): Promise<TrelloCredentialResult> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(repo)}/trello-credentials`,
    patch,
  );
}

// ── GitHub credentials (DX-648 / DX-649 / DX-661) ───────────────────

/**
 * Mirror of backend `GithubCredentialsSnapshot`. Full token never reaches
 * the SPA — only masked prefix/suffix, validation metadata, and the
 * `/user` probe result.
 */
export interface GithubCredentialsSnapshot {
  registered: boolean;
  token_shape_valid: boolean;
  last_validated_at: string | null;
  last_validation_error: string | null;
  /** DX-661 masked display — derived server-side. */
  token_prefix: string;
  token_suffix: string;
  /**
   * Parsed from GitHub's `github-authentication-token-expiration` header
   * (`YYYY-MM-DD HH:MM:SS UTC`). `null` for classic PATs without expiry
   * AND when the probe has not run yet.
   */
  token_expires_at: string | null;
  /** GitHub `/user` login from the probe response body; `null` when absent. */
  token_user_login: string | null;
}

export async function getGithubCredentials(
  repo: string,
): Promise<GithubCredentialsSnapshot> {
  return jsonRequest(
    "GET",
    `/api/agents/${encodeURIComponent(repo)}/github-credentials`,
  );
}

/**
 * Rotates `DANX_GITHUB_TOKEN`. Server shape-validates + probes
 * `api.github.com/user`; only writes on probe 2xx. 422 surfaces shape /
 * probe rejections inline; 200 returns the fresh snapshot.
 */
export async function patchGithubCredentials(
  repo: string,
  token: string,
): Promise<GithubCredentialsSnapshot> {
  return jsonRequest(
    "PATCH",
    `/api/agents/${encodeURIComponent(repo)}/github-credentials`,
    { token },
  );
}

// ── Issue prefix (DX-103) ───────────────────────────────────────────

export interface IssuePrefixResult {
  prefix: string;
  migratedFiles: number;
}

/**
 * Flips a repo's `issue_prefix`; backend runs file-rename +
 * content-rewrite migration synchronously and returns
 * `{prefix, migratedFiles}`.
 */
export async function putIssuePrefix(
  repo: string,
  prefix: string,
): Promise<IssuePrefixResult> {
  return jsonRequest(
    "PUT",
    `/api/agents/${encodeURIComponent(repo)}/issue-prefix`,
    { prefix },
  );
}
