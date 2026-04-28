/**
 * SSM parameter-path helpers — single source of truth for the layout
 * shared by the deploy push side (TS) and the instance-side materializer
 * (bash).
 *
 * Layout (read by `templates/materialize-secrets.sh`):
 *
 *   <prefix>/shared/<KEY>                  → /danxbot/.env
 *   <prefix>/repos/<repo>/<KEY>            → <repo>/.danxbot/.env
 *   <prefix>/repos/<repo>/REPO_ENV_<KEY>   → <repo>[/<subpath>]/.env
 *
 * The instance-side materializer can't import this module (it's bash), so
 * the matching layout is documented at the top of materialize-secrets.sh.
 * If you change the layout here, update the comment block there too.
 *
 * Helpers do NOT validate input — callers are trusted (`config.ts` already
 * regex-validates repo names, and SSM rejects malformed paths server-side).
 * Returning the literal joined string keeps a typo or trailing-slash bug
 * loud (a 4xx from SSM) rather than silent (a normalized path that doesn't
 * match what the materializer reads).
 */

export function sharedKeyPath(prefix: string, key: string): string {
  return `${prefix}/shared/${key}`;
}

export function repoKeyPath(
  prefix: string,
  repo: string,
  key: string,
): string {
  return `${prefix}/repos/${repo}/${key}`;
}

export function repoAppKeyPath(
  prefix: string,
  repo: string,
  key: string,
): string {
  return `${prefix}/repos/${repo}/REPO_ENV_${key}`;
}
