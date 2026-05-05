import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";

export type IssueTypeFilter = "epic" | "bug" | "feature";

const VALID_TYPES: ReadonlyArray<IssueTypeFilter> = ["epic", "bug", "feature"];

function parseTypes(raw: string | null): IssueTypeFilter[] {
  if (!raw) return [];
  const seen = new Set<IssueTypeFilter>();
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (VALID_TYPES.includes(v as IssueTypeFilter)) {
      seen.add(v as IssueTypeFilter);
    }
  }
  return [...seen];
}

/**
 * URL-backed filter state for the Issues board. Mirrors `q` / `type` /
 * `blocked` / `closed` (and optional `repo`) onto `window.location.search`
 * via `history.replaceState` so refreshes + shared links keep state.
 *
 * `selectedRepo` is bidirectional when passed: the URL `repo=<name>` wins
 * on mount and `popstate`; subsequent ref changes get mirrored back.
 */
export function useIssueFilters(selectedRepo?: Ref<string>) {
  const q = ref<string>("");
  const types = ref<IssueTypeFilter[]>([]);
  const blockedOnly = ref<boolean>(false);
  const showClosed = ref<boolean>(false);

  function readFromUrl(): void {
    const p = new URLSearchParams(window.location.search);
    q.value = p.get("q") ?? "";
    types.value = parseTypes(p.get("type"));
    blockedOnly.value = p.get("blocked") === "1";
    showClosed.value = p.get("closed") === "1";
    if (selectedRepo) {
      const r = p.get("repo");
      if (r && r !== selectedRepo.value) selectedRepo.value = r;
    }
  }

  function writeToUrl(): void {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    if (q.value) p.set("q", q.value); else p.delete("q");
    if (types.value.length) p.set("type", [...types.value].sort().join(","));
    else p.delete("type");
    if (blockedOnly.value) p.set("blocked", "1"); else p.delete("blocked");
    if (showClosed.value) p.set("closed", "1"); else p.delete("closed");
    if (selectedRepo?.value) p.set("repo", selectedRepo.value);
    else if (selectedRepo) p.delete("repo");
    window.history.replaceState({}, "", url.toString());
  }

  function toggleType(t: IssueTypeFilter): void {
    types.value = types.value.includes(t)
      ? types.value.filter((x) => x !== t)
      : [...types.value, t];
  }

  function clearSearch(): void {
    q.value = "";
  }

  onMounted(() => {
    readFromUrl();
    window.addEventListener("popstate", readFromUrl);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("popstate", readFromUrl);
  });

  watch([q, types, blockedOnly, showClosed], writeToUrl);
  if (selectedRepo) watch(selectedRepo, writeToUrl);

  return { q, types, blockedOnly, showClosed, toggleType, clearSearch };
}
