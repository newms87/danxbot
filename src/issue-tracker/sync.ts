import {
  DANXBOT_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
  findCommentByMarker,
} from "./markers.js";
import {
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssuePhase,
  type IssueRetro,
  type IssueTracker,
} from "./interface.js";

/**
 * Deterministic, idempotent worker-side sync.
 *
 * Diff strategy: we fetch the remote card ONCE (via `getCard`) at the top of
 * the sync, plus the remote comments (separately, because `getCard` already
 * returns a comments slice but `sync` needs a sortable, full list — keeping
 * the two reads explicit avoids API drift between trackers).
 *
 * We then diff local-vs-remote field by field and apply the minimum set of
 * mutations. `local` is the source of truth for everything except remote
 * comments (which can be appended by humans on the tracker UI).
 *
 * Idempotent: a second invocation on the returned `updatedLocal` issues zero
 * mutating calls (`remoteWriteCount === 0`).
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

export async function syncIssue(
  tracker: IssueTracker,
  local: Issue,
  options: { actionItemTitles?: ActionItemTitleResolver } = {},
): Promise<{ updatedLocal: Issue; remoteWriteCount: number }> {
  let writes = 0;

  // --- Step 1+2: merge remote comments into local. ---
  const remoteComments = await tracker.getComments(local.external_id);
  const localCommentIds = new Set(
    local.comments.map((c) => c.id).filter((id): id is string => !!id),
  );

  // Append any tracker-side comments we haven't seen locally yet.
  const newRemote = remoteComments.filter((c) => !localCommentIds.has(c.id));
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
  // The `blocked` flag pairs with the local YAML's `blocked` record:
  // non-null record → true → Blocked label applied. Trello stores no
  // structured blocked data, so `setLabels` is the entire on-tracker
  // surface. The local YAML remains source of truth for reason / by[].
  // Remote diff: there's no equivalent to read from `remoteCard.blocked`
  // (the field doesn't survive the round-trip on Trello), so we treat
  // the LABEL as the remote signal — `setLabels` is idempotent and the
  // managed-set filter strips the Blocked label when local goes back to
  // null.
  const localLabels = {
    type: local.type,
    needsHelp: local.status === "Needs Help",
    triaged: local.triaged.timestamp !== "",
    blocked: local.blocked !== null,
  };
  const remoteLabels = {
    type: remoteCard.type,
    needsHelp: remoteCard.status === "Needs Help",
    triaged: remoteCard.triaged.timestamp !== "",
    blocked: remoteCard.blocked !== null,
  };
  if (
    localLabels.type !== remoteLabels.type ||
    localLabels.needsHelp !== remoteLabels.needsHelp ||
    localLabels.triaged !== remoteLabels.triaged ||
    localLabels.blocked !== remoteLabels.blocked
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

  // 4e: Phases diff (parallel structure to AC).
  const phaseAdds: { itemRef: (typeof local.phases)[number]; idx: number }[] =
    [];
  const phaseUpdates: {
    checkItemId: string;
    patch: {
      title?: string;
      status?: (typeof local.phases)[number]["status"];
      notes?: string;
    };
  }[] = [];

  const remotePhasesById = new Map(
    remoteCard.phases.map((p) => [p.check_item_id, p] as const),
  );
  const stampedPhasesByOriginalIndex = new Map<number, IssuePhase>();

  for (let i = 0; i < local.phases.length; i++) {
    const item = local.phases[i];
    if (!item.check_item_id) {
      phaseAdds.push({ itemRef: item, idx: i });
      continue;
    }
    const remote = remotePhasesById.get(item.check_item_id);
    if (!remote) {
      phaseAdds.push({ itemRef: item, idx: i });
      continue;
    }
    const patch: {
      title?: string;
      status?: (typeof local.phases)[number]["status"];
      notes?: string;
    } = {};
    if (item.title !== remote.title) patch.title = item.title;
    if (item.status !== remote.status) patch.status = item.status;
    if (item.notes !== remote.notes) patch.notes = item.notes;
    if (
      patch.title !== undefined ||
      patch.status !== undefined ||
      patch.notes !== undefined
    ) {
      phaseUpdates.push({ checkItemId: item.check_item_id, patch });
    }
  }
  for (const u of phaseUpdates) {
    await tracker.updatePhaseItem(local.external_id, u.checkItemId, u.patch);
    writes++;
  }
  for (const add of phaseAdds) {
    const result = await tracker.addPhaseItem(local.external_id, {
      title: add.itemRef.title,
      status: add.itemRef.status,
      notes: add.itemRef.notes,
    });
    writes++;
    stampedPhasesByOriginalIndex.set(add.idx, {
      check_item_id: result.check_item_id,
      title: add.itemRef.title,
      status: add.itemRef.status,
      notes: add.itemRef.notes,
    });
  }
  const localPhaseIds = new Set(
    local.phases.map((p) => p.check_item_id).filter((id) => !!id),
  );
  for (const remote of remoteCard.phases) {
    if (!localPhaseIds.has(remote.check_item_id)) {
      await tracker.deletePhaseItem(local.external_id, remote.check_item_id);
      writes++;
    }
  }

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
  const finalPhases = local.phases.map((item, idx) => {
    const stamped = stampedPhasesByOriginalIndex.get(idx);
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
    phases: finalPhases,
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
