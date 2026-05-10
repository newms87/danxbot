import { existsSync, readFileSync } from "node:fs";
import {
  DANXBOT_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
  findCommentByMarker,
  isBotMirroredComment,
} from "./markers.js";
import {
  isTriaged,
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssueRetro,
  type IssueTracker,
} from "./interface.js";
import { issuePath } from "./paths.js";
import { IssueParseError, issueToCreateInput, parseIssue } from "./yaml.js";
import { createLogger, type Logger } from "../logger.js";

const log = createLogger("sync");

/**
 * Project an Issue body into the `CreateCardInput` payload for
 * `tracker.createCard()`. Used by both the fresh-create flow (in the MCP
 * `createIssue` handler) and the orphan-recovery branch at the top of
 * `syncIssue`, so the two paths produce identical tracker inputs by
 * construction.
 *
 * Re-exported from `yaml.ts#issueToCreateInput` — single canonical
 * implementation; sync + worker + poller all funnel through it.
 */
export const toCreateCardInput = issueToCreateInput;

/**
 * Stamp tracker-assigned ids back onto the local Issue. After a successful
 * `tracker.createCard()`, the tracker has allocated an `external_id` for the
 * card and a `check_item_id` for every AC item; this function returns a NEW
 * Issue mirroring those ids so the caller can persist the bidirectional
 * binding without mutating the input.
 */
export function stampTrackerIds(
  issue: Issue,
  created: {
    external_id: string;
    ac: { check_item_id: string }[];
  },
): Issue {
  return {
    ...issue,
    external_id: created.external_id,
    ac: issue.ac.map((item, i) => ({
      ...item,
      check_item_id: created.ac[i]?.check_item_id ?? item.check_item_id,
    })),
  };
}

/**
 * Deterministic, idempotent worker-side sync.
 *
 * Diff strategy: we fetch the remote card ONCE (via `getCard` — which
 * also surfaces the projected `Issue.labels` so the outbound label diff
 * needs no second round-trip) plus the remote comments separately
 * (`getCard` already returns a comments slice but `sync` needs a
 * sortable, full list). The two reads are explicit so tracker
 * implementations can answer them efficiently without API drift.
 *
 * We then diff local-vs-remote field by field and apply the minimum set of
 * mutations. `local` is the source of truth for everything except remote
 * comments (which can be appended by humans on the tracker UI).
 *
 * Idempotent: a second invocation on the returned `updatedLocal` issues zero
 * mutating calls (`remoteWriteCount === 0`).
 *
 * Outbound mirror — full-fidelity audit (ISS-88, Slice C). Every field on
 * the `Issue` type either reaches the tracker via one of the writes below
 * or is intentionally local-only:
 *
 *   id            → encoded into the title prefix (`#<id>: <title>`) by
 *                   tracker implementations during `createCard` /
 *                   `updateCard`. Diffed via `local.title` vs
 *                   `remoteCard.title` (semantic title, prefix stripped).
 *   external_id   → tracker primary key. Created by `createCard` (orphan
 *                   recovery branch above) and `pushOrphans`.
 *   parent_id     → LOCAL-ONLY. Trackers expose no native parent concept;
 *                   `parent_id` references the parent's INTERNAL `ISS-N`
 *                   id, not its `external_id`. Sync passes through verbatim.
 *   children      → LOCAL-ONLY. Reverse linkage to `parent_id`; same
 *                   reasoning. Maintained by the `danx-epic-link` skill and
 *                   the `danx_issue_create` flow.
 *   dispatch      → LOCAL-ONLY. Poller-managed metadata (PID, host, kind).
 *   status        → list move via `moveToStatus` (Step 4b).
 *   type          → managed label via `setLabels` (Step 4c).
 *   title         → `updateCard({title})` (Step 4a).
 *   description   → `updateCard({description})` (Step 4a).
 *   triage        → managed label via `setLabels` (Step 4c). The label is
 *                   the entire tracker-side surface; the structured
 *                   record (`expires_at`, `last_status`, `last_explain`,
 *                   `ice`, `history`) stays local-only.
 *   ac            → `addAcItem` / `updateAcItem` / `deleteAcItem` (Step 4d).
 *   comments      → bot-authored comments POSTed via `addComment` with the
 *                   danxbot marker prefix (Step 4f). Human-authored
 *                   tracker comments flow inbound (Step 1+2).
 *   retro         → ONE rendered comment via `addComment` /
 *                   `editComment` on terminal status (Step 6).
 *   blocked       → managed label via `setLabels` (Step 4c). Same shape as
 *                   `triage`: label-only on the tracker; structured
 *                   record (`reason`, `timestamp`, `by[]`) stays local.
 *
 * The label diff (Step 4c) compares local-derived intent against
 * `remoteCard.labels` (a projection trackers populate inside `getCard`)
 * rather than re-deriving from `remoteCard`'s data fields, because
 * `triaged` and `blocked` (and on Trello, `type`) do not round-trip
 * through their data-field counterparts. Reading the label set directly
 * closes the diff loop and keeps `setLabels` writes idempotent.
 */
/**
 * Optional ID-to-title resolver for rendering `retro.action_item_ids` in
 * the structured retro comment. Caller (worker / poller) reads each linked
 * action-item card's local YAML and supplies its title. IDs missing from
 * the map render as `<ISS-N: unknown>` so a typo or stale reference is
 * loud, not silent. Absent map → every id renders as unknown.
 *
 * Single canonical shape (Map). Earlier prototypes accepted both Map and
 * Record; the worker only ever produces a Map, so the second form was
 * dead generality. Keep this type narrow.
 */
export type ActionItemTitleResolver = Map<string, string>;

/**
 * Resolve `retro.action_item_ids[]` to a `{id → title}` map by reading
 * each linked YAML from the local repo. IDs missing on disk are simply
 * absent from the map; the renderer surfaces them as `<ISS-N: unknown>`
 * so a typo / stale reference is loud, not silent. Returns an empty
 * map when there are no ids to resolve, avoiding pointless filesystem
 * walks on the common no-action-items case.
 *
 * Single canonical helper used by both the worker (`runSync` /
 * `syncTrackedIssueOnComplete`) and the poller's retry-queue drain
 * (`drainRetries`). Lives next to `syncIssue` because both paths feed
 * the result into `syncIssue`'s `actionItemTitles` option for the
 * structured retro renderer.
 */
export function loadActionItemTitles(
  repoLocalPath: string,
  ids: readonly string[],
  prefix: string,
  logger: Logger = log,
): ActionItemTitleResolver {
  const out = new Map<string, string>();
  for (const id of ids) {
    const open = issuePath(repoLocalPath, id, "open");
    const closed = issuePath(repoLocalPath, id, "closed");
    const path = existsSync(open) ? open : existsSync(closed) ? closed : null;
    if (!path) continue;
    try {
      // Don't kill the parent sync over a malformed linked YAML — leave
      // the id absent from the map so the renderer flags it as unknown.
      const linked = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: prefix,
      });
      out.set(id, linked.title);
    } catch (err) {
      const msg = err instanceof IssueParseError ? err.message : String(err);
      logger.warn(`loadActionItemTitles: failed to parse ${path}: ${msg}`);
    }
  }
  return out;
}

export async function syncIssue(
  tracker: IssueTracker,
  local: Issue,
  options: { actionItemTitles?: ActionItemTitleResolver } = {},
): Promise<{ updatedLocal: Issue; remoteWriteCount: number }> {
  // --- Step 0: orphan guard. ---
  //
  // A YAML with `external_id: ""` has never reached the tracker. The diff
  // path below calls `getCard` / `getComments` on the empty id, which Trello
  // rejects with 400 (`GET /cards//actions`). Route these through
  // `createCard`, stamp tracker-assigned ids back, and return — the
  // reconciler is the wrong primitive for first-time push. Any future
  // consumer of `syncIssue` (worker poller, dashboard, MCP handlers) gets
  // the same protection without reinventing the branch.
  if (local.external_id === "") {
    const created = await tracker.createCard(toCreateCardInput(local));
    return { updatedLocal: stampTrackerIds(local, created), remoteWriteCount: 1 };
  }

  let writes = 0;

  // --- Step 1+2: merge remote comments into local. ---
  //
  // Inbound channel from the tracker is intentionally narrow. Per the
  // Source-of-Truth contract (`~/.claude/rules/issues.md` "Source of
  // Truth"), only TWO things flow tracker → YAML:
  //
  //   1. NEW CARDS — a tracker card with no matching local YAML gets
  //      hydrated by `bulkSyncMissingYamls` (see
  //      `src/poller/yaml-lifecycle.ts#hydrateFromRemote`). NOT this
  //      block — `syncIssue` only runs against an already-hydrated
  //      Issue.
  //   2. NEW COMMENTS — human-authored tracker comments are appended
  //      to local `comments[]` here. Bot-mirrored comments (any text
  //      containing `DANXBOT_COMMENT_MARKER`) are skipped to prevent
  //      echo loops where the bot re-imports its own outbound posts.
  //
  // EVERYTHING ELSE inbound is ignored. Title / description / status /
  // AC / labels / blocked on the tracker do NOT propagate back to the
  // YAML — Step 4 below re-asserts the local values onto the tracker
  // every tick. A human dragging a card or ticking a checkbox on the
  // tracker has no effect on the YAML; the next tick reverts it.
  const remoteComments = await tracker.getComments(local.external_id);
  const localCommentIds = new Set(
    local.comments.map((c) => c.id).filter((id): id is string => !!id),
  );

  // Append any tracker-side comments we haven't seen locally yet, then
  // strip bot-marked comments via `isBotMirroredComment` (anchored
  // `startsWith` — see markers.ts). Belt-and-suspenders against the
  // echo loop: if the same deployment already stamped the id, dedup
  // wins; if a different bot stamped it (or the id stamping failed),
  // the anchored marker check still catches it.
  const newRemote = remoteComments.filter(
    (c) => !localCommentIds.has(c.id) && !isBotMirroredComment(c),
  );
  const updatedComments: IssueComment[] = [
    ...local.comments,
    ...newRemote.map((c) => ({
      id: c.id,
      author: c.author,
      timestamp: c.timestamp,
      text: c.text,
    })),
  ];

  // --- Step 3: fetch remote card for diffing the rest. ---
  const remoteCard = await tracker.getCard(local.external_id);

  // --- Step 4: apply local-as-truth diff. ---

  // 4a: title / description
  // We compare against the SEMANTIC title (without `#<id>: ` prefix) so
  // tracker implementations that prefix titles don't loop forever
  // patching themselves back to their formatted form.
  const cardPatch: { title?: string; description?: string; id?: string } = {};
  if (local.title !== remoteCard.title) {
    cardPatch.title = local.title;
    if (local.id) cardPatch.id = local.id;
  }
  if (local.description !== remoteCard.description)
    cardPatch.description = local.description;
  if (cardPatch.title !== undefined || cardPatch.description !== undefined) {
    await tracker.updateCard(local.external_id, cardPatch);
    writes++;
  }

  // 4b: status
  if (local.status !== remoteCard.status) {
    await tracker.moveToStatus(local.external_id, local.status);
    writes++;
  }

  // 4c: labels
  //
  // The four managed labels — type, blocked, requires_human, triaged —
  // are derived from local YAML data (`status`, `type`,
  // `triage.last_status` / `triage.history`, `requires_human`). On Trello,
  // NONE of those source fields round-trip through `getCard`'s data shape
  // — `triage` and `requires_human` have no native column, and `type`
  // itself is derived from labels. So the remote-side diff MUST come from
  // the actual label state.
  //
  // `blocked` mirrors `status === "Blocked"`. The `Issue.blocked` FIELD
  // carries the reason, but the label is keyed off status alone — status
  // is the index lookup, the field is the reason cache, and the worker
  // enforces the field/status invariant.
  //
  // `requires_human` mirrors `Issue.requires_human != null`. DX-231
  // replaced the legacy `needsApproval` derive (driven by the retired
  // `"Needs Approval"` status) with this orthogonal indicator. The setup
  // skill provisions the matching Trello label in Phase 3 of the epic.
  //
  // `waiting_on` is NOT a managed label. Cards waiting on dep-chains stay
  // visually `ToDo`; their state is captured in the YAML and rendered by
  // the dashboard. No tracker label is auto-applied for waiting_on.
  if (!remoteCard.labels) {
    throw new Error(
      `tracker.getCard returned no labels projection for ${local.external_id} — every IssueTracker implementation must populate Issue.labels`,
    );
  }
  const localLabels = {
    type: local.type,
    blocked: local.status === "Blocked",
    // DX-231 Phase 3 (DX-234) reinstates `requires_human` in the diff
    // predicate. Phase 1 (DX-232) intentionally omitted it because the
    // Trello label id was not yet provisioned — every flagged card
    // would have triggered ~2880 no-op `setLabels` PUTs/day. With the
    // label id wired through `TrelloConfig.requiresHumanLabelId` and
    // projected in `trello.ts#projectLabels`, the diff is now
    // meaningful: a remote mismatch fires exactly one `setLabels` to
    // apply or strip the label. On legacy boards where the operator
    // has not yet provisioned the label (`requiresHumanLabelId ===
    // ""`), the projection returns `false` so this clause still fires
    // `setLabels`, but the Trello tracker's `setLabels` short-circuits
    // on content-identity (the resolveLabelIds + managed-set filter
    // collapse `next` back to the existing idLabels because the empty
    // id is a no-op at every layer) — so the actual API PUT does NOT
    // fire. Sync's `remoteWriteCount` still increments per call intent
    // (it counts mutations sync ASKED for, not mutations the tracker
    // actually issued); the API quota is preserved.
    requires_human: local.requires_human !== null,
    // The "triaged" label flips on as soon as the triage agent has made
    // any decision on the card — `last_status` is non-empty after the
    // first triage. `expires_at` is unsuitable here because the migration
    // backfills `""` to force re-triage on rollout, but the label should
    // STILL be on (the card was triaged in the legacy world; we just
    // re-triage soon).
    triaged: isTriaged(local.triage),
  };
  const remoteLabels = remoteCard.labels;
  if (
    localLabels.type !== remoteLabels.type ||
    localLabels.blocked !== remoteLabels.blocked ||
    localLabels.requires_human !== remoteLabels.requires_human ||
    localLabels.triaged !== remoteLabels.triaged
  ) {
    await tracker.setLabels(local.external_id, localLabels);
    writes++;
  }

  // 4d: AC items diff
  const acAdds: { itemRef: (typeof local.ac)[number]; idx: number }[] = [];
  const acUpdates: {
    checkItemId: string;
    patch: { title?: string; checked?: boolean };
  }[] = [];

  const remoteAcById = new Map(
    remoteCard.ac.map((a) => [a.check_item_id, a] as const),
  );
  const stampedAcByOriginalIndex = new Map<number, IssueAcItem>();

  for (let i = 0; i < local.ac.length; i++) {
    const item = local.ac[i];
    if (!item.check_item_id) {
      acAdds.push({ itemRef: item, idx: i });
      continue;
    }
    const remote = remoteAcById.get(item.check_item_id);
    if (!remote) {
      // Local references a check_item_id the remote doesn't have — treat as
      // add (the check_item_id will be replaced by the tracker-assigned id).
      acAdds.push({ itemRef: item, idx: i });
      continue;
    }
    const patch: { title?: string; checked?: boolean } = {};
    if (item.title !== remote.title) patch.title = item.title;
    if (item.checked !== remote.checked) patch.checked = item.checked;
    if (patch.title !== undefined || patch.checked !== undefined) {
      acUpdates.push({ checkItemId: item.check_item_id, patch });
    }
  }
  for (const u of acUpdates) {
    await tracker.updateAcItem(local.external_id, u.checkItemId, u.patch);
    writes++;
  }
  for (const add of acAdds) {
    const result = await tracker.addAcItem(local.external_id, {
      title: add.itemRef.title,
      checked: add.itemRef.checked,
    });
    writes++;
    stampedAcByOriginalIndex.set(add.idx, {
      check_item_id: result.check_item_id,
      title: add.itemRef.title,
      checked: add.itemRef.checked,
    });
  }
  // AC items present on remote but absent in local → delete.
  const localAcIds = new Set(
    local.ac.map((a) => a.check_item_id).filter((id) => !!id),
  );
  for (const remote of remoteCard.ac) {
    if (!localAcIds.has(remote.check_item_id)) {
      await tracker.deleteAcItem(local.external_id, remote.check_item_id);
      writes++;
    }
  }

  // 4e: (removed) Phases diff. The `phases[]` field was retired in ISS-81 —
  // unified into `children[]`. There is no in-card phase checklist to diff
  // anymore; child cards are independent issues that sync via their own
  // YAMLs.

  // 4f: Local comments without `id` are new — POST them, prepending the
  // danxbot marker so the poller's user-response detector ignores them.
  const stampedCommentsByOriginalIndex = new Map<number, IssueComment>();
  for (let i = 0; i < updatedComments.length; i++) {
    const c = updatedComments[i];
    if (c.id) continue;
    const text = c.text.includes(DANXBOT_COMMENT_MARKER)
      ? c.text
      : `${DANXBOT_COMMENT_MARKER}\n\n${c.text}`;
    const result = await tracker.addComment(local.external_id, text);
    writes++;
    stampedCommentsByOriginalIndex.set(i, {
      id: result.id,
      author: c.author,
      timestamp: result.timestamp,
      text,
    });
  }

  // Collects in-place comment edits issued below (the retro renderer)
  // keyed by tracker comment id, so the `finalComments` mapping at the end
  // can reflect new bodies in the local snapshot. The next sync's identity
  // check then sees matching text and short-circuits to zero writes.
  // Adding a future edit-source is one `editedCommentTexts.set(id, text)`
  // line — no new variable pair, no extra branch in the finalize block.
  const editedCommentTexts = new Map<string, string>();

  // --- Step 5: (removed) terminal-status action-items spawning. ---
  //
  // The legacy spawn loop is gone. Action items are now full issues that
  // the agent creates ahead of time via `danx_issue_create` and references
  // by `ISS-N` in `retro.action_item_ids[]`. The retro renderer below
  // resolves those ids → titles via `options.actionItemTitles` and renders
  // them as bullets in the structured retro comment. No tracker writes are
  // issued for action items themselves — the cards already exist.

  // --- Step 6: terminal-status retro renderer. ---
  //
  // When the saved status is Done or Cancelled and the local retro carries
  // any non-empty field, post (or edit-in-place, or skip) the structured
  // retro comment. ONE retro comment per card lifetime — re-syncing the
  // same retro is a no-op; modifying retro fields edits the existing
  // comment rather than appending a duplicate.
  //
  // Runs AFTER the comments-without-id POST loop above so `updatedComments`
  // already includes any fresh comments stamped this round, AND so the
  // retro detector below sees both already-posted retros pulled from the
  // remote merge step (1+2) and any locally-stamped ones.
  const isTerminal = local.status === "Done" || local.status === "Cancelled";
  const retroNonEmpty = isRetroNonEmpty(local.retro);

  // Refresh local snapshot of all known comments (remote-merged + freshly
  // POSTed this round) so retro detection sees stamped variants too.
  const knownCommentsForRetro: IssueComment[] = updatedComments.map(
    (c, idx) => {
      const stamped = stampedCommentsByOriginalIndex.get(idx);
      return stamped ?? c;
    },
  );

  let retroAppendedComment: IssueComment | null = null;
  if (isTerminal && retroNonEmpty) {
    const desiredText = renderRetroComment(
      local.retro,
      options.actionItemTitles,
    );
    const managed = findCommentByMarker(
      knownCommentsForRetro,
      RETRO_COMMENT_MARKER,
    );
    if (managed) {
      // Already worker-managed — only write if body changed.
      if (managed.text !== desiredText) {
        await tracker.editComment(local.external_id, managed.id, desiredText);
        writes++;
        editedCommentTexts.set(managed.id, desiredText);
      }
    } else if (hasLegacyRetroComment(knownCommentsForRetro)) {
      // Mid-flight Phase 4 dispatch already appended a manual `## Retro`
      // comment without our marker — don't post a duplicate. Leaving the
      // legacy shape in place is per spec (Out of scope: migrating
      // already-Done cards' legacy retro comments).
    } else {
      const result = await tracker.addComment(local.external_id, desiredText);
      writes++;
      retroAppendedComment = {
        id: result.id,
        author: "danxbot",
        timestamp: result.timestamp,
        text: desiredText,
      };
    }
  }

  // Finalize updatedLocal.
  const finalAc = local.ac.map((item, idx) => {
    const stamped = stampedAcByOriginalIndex.get(idx);
    if (stamped) return stamped;
    return { ...item };
  });
  const finalComments = updatedComments.map((c, idx) => {
    const stamped = stampedCommentsByOriginalIndex.get(idx);
    const base = stamped ?? { ...c };
    // If any in-place comment edit issued above (retro renderer or any
    // future edit-source) targeted this exact comment id, reflect the new
    // body in the local snapshot so the next sync's identity check sees
    // matching text and short-circuits to zero writes.
    if (base.id) {
      const editedText = editedCommentTexts.get(base.id);
      if (editedText !== undefined) {
        return { ...base, text: editedText };
      }
    }
    return base;
  });
  // Stamp newly-POSTed retro comment into local so next sync's read-side
  // merge skips it.
  if (retroAppendedComment) finalComments.push(retroAppendedComment);

  // `parent_id` and `dispatch_id` are local-only metadata managed by the
  // poller (Phase 2) and the danx_issue_create flow (Phase 3). The tracker
  // abstraction has no place to store them, so sync passes them through
  // verbatim via `...local`. Reconciling them is intentionally NOT a sync
  // responsibility.
  const updatedLocal: Issue = {
    ...local,
    ac: finalAc,
    comments: finalComments,
  };

  return { updatedLocal, remoteWriteCount: writes };
}

// ---------- retro rendering helpers (exported for tests) ----------

export function isRetroNonEmpty(retro: IssueRetro): boolean {
  return (
    retro.good !== "" ||
    retro.bad !== "" ||
    retro.action_item_ids.length > 0 ||
    retro.commits.length > 0
  );
}

/**
 * Format the structured retro markdown body, prefixed with both the
 * standard `<!-- danxbot -->` marker (so the poller's `isUserResponse`
 * filter skips it) and the `<!-- danxbot-retro -->` idempotency marker
 * (so re-sync recognizes our managed comment).
 *
 * The format is byte-stable: identical retro inputs (with the same title
 * resolver) produce identical output, so the round-trip identity check
 * (`managed.text === desiredText`) yields zero remote writes on a no-op
 * re-sync.
 *
 * Action items render as `- {title} ({ISS-N})` resolving each id through
 * `actionItemTitles`. Unknown ids surface as `- <ISS-N: unknown>` so a
 * stale or typo'd reference is loud, not silent.
 */
export function renderRetroComment(
  retro: IssueRetro,
  actionItemTitles?: ActionItemTitleResolver,
): string {
  const goodLine = retro.good === "" ? "—" : retro.good;
  const badLine = retro.bad === "" ? "—" : retro.bad;
  const lookup = (id: string): string | undefined => actionItemTitles?.get(id);
  const actionItemsBlock =
    retro.action_item_ids.length === 0
      ? " Nothing"
      : `\n${retro.action_item_ids
          .map((id) => {
            const title = lookup(id);
            return title === undefined
              ? `- <${id}: unknown>`
              : `- ${title} (${id})`;
          })
          .join("\n")}`;
  const commitsLine =
    retro.commits.length === 0 ? "—" : retro.commits.join(", ");
  const body = `## Retro

**What went well:** ${goodLine}
**What went wrong:** ${badLine}
**Action items:**${actionItemsBlock}
**Commits:** ${commitsLine}`;
  return `${DANXBOT_COMMENT_MARKER}\n${RETRO_COMMENT_MARKER}\n\n${body}`;
}

/**
 * Detect a Phase-4-shape manually-appended retro comment — a danxbot-
 * authored comment (carries `DANXBOT_COMMENT_MARKER`) with a `## Retro`
 * heading but no `RETRO_COMMENT_MARKER`. Phase 4 dispatches wrote this
 * shape; Phase 5 leaves them in place rather than posting a duplicate.
 *
 * Both markers are required so a user-authored comment that happens to
 * QUOTE a legacy `## Retro` block (e.g. an agent paste-back) cannot
 * silently suppress the worker's freshly-rendered retro post.
 */
function hasLegacyRetroComment(comments: IssueComment[]): boolean {
  for (const c of comments) {
    if (!c.id) continue;
    if (c.text.includes(RETRO_COMMENT_MARKER)) continue;
    if (!c.text.includes(DANXBOT_COMMENT_MARKER)) continue;
    if (/(^|\n)## Retro\b/.test(c.text)) return true;
  }
  return false;
}
