import { DANXBOT_COMMENT_MARKER } from "../poller/constants.js";
import {
  type Issue,
  type IssueAcItem,
  type IssueComment,
  type IssuePhase,
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
export async function syncIssue(
  tracker: IssueTracker,
  local: Issue,
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
  const cardPatch: { title?: string; description?: string } = {};
  if (local.title !== remoteCard.title) cardPatch.title = local.title;
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
  const localLabels = {
    type: local.type,
    needsHelp: local.status === "Needs Help",
    triaged: local.triaged.timestamp !== "",
  };
  const remoteLabels = {
    type: remoteCard.type,
    needsHelp: remoteCard.status === "Needs Help",
    triaged: remoteCard.triaged.timestamp !== "",
  };
  if (
    localLabels.type !== remoteLabels.type ||
    localLabels.needsHelp !== remoteLabels.needsHelp ||
    localLabels.triaged !== remoteLabels.triaged
  ) {
    await tracker.setLabels(local.external_id, localLabels);
    writes++;
  }

  // 4d: AC items diff
  const acAdds: { itemRef: typeof local.ac[number]; idx: number }[] = [];
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
  const phaseAdds: { itemRef: typeof local.phases[number]; idx: number }[] = [];
  const phaseUpdates: {
    checkItemId: string;
    patch: { title?: string; status?: typeof local.phases[number]["status"]; notes?: string };
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
      status?: typeof local.phases[number]["status"];
      notes?: string;
    } = {};
    if (item.title !== remote.title) patch.title = item.title;
    if (item.status !== remote.status) patch.status = item.status;
    if (item.notes !== remote.notes) patch.notes = item.notes;
    if (patch.title !== undefined || patch.status !== undefined || patch.notes !== undefined) {
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
    return stamped ?? { ...c };
  });

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
