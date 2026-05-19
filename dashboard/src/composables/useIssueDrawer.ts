import { ref, type Ref } from "vue";
import type { Issue, IssueDetail } from "../types";

export interface UseIssueDrawerOptions {
  fetchDetail: (id: string) => Promise<IssueDetail>;
  applyIssueUpdate: (id: string) => void;
}

export interface UseIssueDrawerApi {
  selectedIssueId: Ref<string | null>;
  selectedDetail: Ref<IssueDetail | null>;
  detailLoading: Ref<boolean>;
  detailError: Ref<string | null>;
  openDrawer: (id: string) => Promise<void>;
  closeDrawer: () => void;
  mergeIssuePatch: (updated: Issue) => void;
  mergeIssueUpdateAndInvalidate: (updated: Issue) => void;
  readUrlIssue: () => string | null;
}

function readUrlIssueImpl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("issue");
}

function writeUrlIssue(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("issue", id);
  else url.searchParams.delete("issue");
  window.history.replaceState({}, "", url.toString());
}

/**
 * Owns the drawer's per-issue detail state machine: id selection,
 * IssueDetail fetch + loading/error refs, URL sync, and the two merge
 * paths (`mergeIssuePatch` from a PATCH response; `mergeIssueUpdateAndInvalidate`
 * from an inline edit that also re-fetches via `applyIssueUpdate`).
 */
export function useIssueDrawer(opts: UseIssueDrawerOptions): UseIssueDrawerApi {
  const selectedIssueId = ref<string | null>(null);
  const selectedDetail = ref<IssueDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref<string | null>(null);

  async function openDrawer(id: string): Promise<void> {
    selectedIssueId.value = id;
    writeUrlIssue(id);
    detailLoading.value = true;
    detailError.value = null;
    try {
      const detail = await opts.fetchDetail(id);
      if (selectedIssueId.value !== id) return;
      selectedDetail.value = detail;
    } catch (err) {
      if (selectedIssueId.value !== id) return;
      detailError.value = err instanceof Error ? err.message : String(err);
      selectedDetail.value = null;
    } finally {
      if (selectedIssueId.value === id) detailLoading.value = false;
    }
  }

  function closeDrawer(): void {
    selectedIssueId.value = null;
    selectedDetail.value = null;
    detailError.value = null;
    writeUrlIssue(null);
  }

  // DX-239 — `RequiresHumanPanel`'s PATCH returns the post-patch Issue.
  // Merge it into the open detail so indicators reflect the new state
  // without waiting for the chokidar mirror debounce (~5s) and a re-fetch.
  function mergeIssuePatch(updated: Issue): void {
    const current = selectedDetail.value;
    if (!current || current.id !== updated.id) return;
    selectedDetail.value = { ...current, ...updated };
  }

  // Inline-edit path: invalidate the cached list-row (SSE re-affirms via
  // `issue:updated`) AND optimistically merge onto the open detail. The
  // `updated_at` bump signals downstream that the local copy is fresher
  // than the last server tick.
  function mergeIssueUpdateAndInvalidate(updated: Issue): void {
    opts.applyIssueUpdate(updated.id);
    if (selectedDetail.value && selectedDetail.value.id === updated.id) {
      selectedDetail.value = {
        ...selectedDetail.value,
        ...updated,
        updated_at: Date.now(),
      };
    }
  }

  return {
    selectedIssueId,
    selectedDetail,
    detailLoading,
    detailError,
    openDrawer,
    closeDrawer,
    mergeIssuePatch,
    mergeIssueUpdateAndInvalidate,
    readUrlIssue: readUrlIssueImpl,
  };
}
