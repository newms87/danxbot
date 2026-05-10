import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Ref } from "vue";

export type IssueTypeFilter = "epic" | "bug" | "feature" | "chore";
export type ScopeMode = "highlight" | "filter";

const VALID_TYPES: ReadonlyArray<IssueTypeFilter> = ["epic", "bug", "feature", "chore"];
const VALID_SCOPE_MODES: ReadonlyArray<ScopeMode> = ["highlight", "filter"];

/**
 * Single source of truth for the epic-scope predicate. An issue is in
 * scope when no scope is active, or when its id matches the scoped epic,
 * or when its parent_id points at the scoped epic. Importers must not
 * inline this — both `IssuesPage` (filter pipeline) and `IssueBoard`
 * (dim/scoped class) consume it.
 */
export function isInScope(
  i: { id: string; parent_id: string | null },
  scopedEpicId: string | null,
): boolean {
  if (!scopedEpicId) return true;
  return i.id === scopedEpicId || i.parent_id === scopedEpicId;
}

function readBoolPref(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeBoolPref(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    /* localStorage disabled — silently no-op */
  }
}

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
  const showClosed = ref<boolean>(readBoolPref("issues.showClosed"));
  const scopedEpicId = ref<string | null>(null);
  const scopeMode = ref<ScopeMode>("highlight");
  const showEpicChildren = ref<boolean>(readBoolPref("issues.showEpicChildren"));

  function readFromUrl(): void {
    const p = new URLSearchParams(window.location.search);
    q.value = p.get("q") ?? "";
    types.value = parseTypes(p.get("type"));
    blockedOnly.value = p.get("blocked") === "1";
    const epic = p.get("epic");
    scopedEpicId.value = epic && epic.length > 0 ? epic : null;
    const m = p.get("mode");
    scopeMode.value = VALID_SCOPE_MODES.includes(m as ScopeMode)
      ? (m as ScopeMode)
      : "highlight";
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
    // showClosed + showEpicChildren persist via localStorage, never URL.
    p.delete("closed");
    p.delete("kids");
    if (scopedEpicId.value) {
      p.set("epic", scopedEpicId.value);
      // mode only meaningful when scoped; default "highlight" stays implicit
      if (scopeMode.value !== "highlight") p.set("mode", scopeMode.value);
      else p.delete("mode");
    } else {
      p.delete("epic");
      p.delete("mode");
    }
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

  watch(
    [q, types, blockedOnly, showClosed, scopedEpicId, scopeMode, showEpicChildren],
    writeToUrl,
  );
  if (selectedRepo) watch(selectedRepo, writeToUrl);
  watch(showClosed, (v) => writeBoolPref("issues.showClosed", v));
  watch(showEpicChildren, (v) => writeBoolPref("issues.showEpicChildren", v));

  return {
    q,
    types,
    blockedOnly,
    showClosed,
    scopedEpicId,
    scopeMode,
    showEpicChildren,
    toggleType,
    clearSearch,
  };
}
