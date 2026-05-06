/**
 * Single-source-of-truth for tracker-comment "marker" constants and the
 * shared `findCommentByMarker` lookup helper.
 *
 * Every danxbot-managed tracker comment carries `DANXBOT_COMMENT_MARKER` so
 * the poller's `isUserResponse` filter ignores it. Specialized comments
 * (retro, dispatch lock) ALSO carry a per-shape marker so the worker can
 * deterministically locate its own managed comment for edit-in-place
 * idempotency.
 *
 * Defining all markers in one module is the only way to keep the
 * `<!-- danxbot... -->` literal in exactly one place — consumers import,
 * never redefine. The grep `<!-- danxbot` across `src/` should match this
 * file alone.
 */

/** Marker appended to every Danxbot-posted tracker comment. */
export const DANXBOT_COMMENT_MARKER = "<!-- danxbot -->";

/**
 * Idempotency marker for the worker-rendered retro comment. Pairs with
 * `DANXBOT_COMMENT_MARKER` on the same body so the user-response filter
 * still skips it.
 */
export const RETRO_COMMENT_MARKER = "<!-- danxbot-retro -->";

/** Marker line identifying a comment as the dispatch lock. */
export const LOCK_COMMENT_MARKER = "<!-- danxbot-lock -->";

/**
 * Locate the first comment whose `text` includes `marker` and whose
 * tracker-assigned `id` is non-empty. Returns the matched element verbatim
 * so callers can use whichever fields they need (id, text, timestamp,
 * author) without an intermediate copy.
 *
 * The `id` requirement excludes locally-staged comments that have not yet
 * been POSTed to the tracker — every consumer of this helper needs the
 * tracker-native id (to edit in place, parse, or report a duplicate).
 */
/**
 * True if a comment was authored by danxbot (carries the
 * `DANXBOT_COMMENT_MARKER` at the start of its body — every outbound
 * post in `syncIssue` prepends the marker on its own line, so anchored
 * `startsWith` is the precise inverse). Anchored match deliberately —
 * `includes` would also match a human reply that quoted a prior bot
 * comment in its body, suppressing legitimate inbound text.
 *
 * Used by the inbound merge in `syncIssue` to break echo loops where a
 * bot-mirrored comment whose `id` failed to land in the local YAML
 * would otherwise be re-imported as "human" on the next pull.
 */
export function isBotMirroredComment(comment: { text: string }): boolean {
  return comment.text.startsWith(DANXBOT_COMMENT_MARKER);
}

export function findCommentByMarker<T extends { text: string; id?: string }>(
  comments: readonly T[],
  marker: string,
): (T & { id: string }) | null {
  for (const c of comments) {
    if (!c.id) continue;
    if (c.text.includes(marker)) return c as T & { id: string };
  }
  return null;
}
