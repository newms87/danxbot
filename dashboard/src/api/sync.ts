import type { SyncRootStateEntry } from "../types";
import { fetchWithAuth, jsonRequest } from "./_request";

/**
 * DX-558 — initial-hydrate fetch for the root-clone sync banner. Empty
 * array when every root clone is in sync; subsequent updates flow over
 * SSE via `useRepoRootSync`.
 */
export async function fetchSyncRootStates(): Promise<SyncRootStateEntry[]> {
  const res = await fetchWithAuth("/api/sync-root");
  if (!res.ok) throw new Error(`fetchSyncRootStates failed: ${res.status}`);
  const body = (await res.json()) as { states: SyncRootStateEntry[] };
  return body.states;
}

/** DX-558 — "Retry now" button: kick a fresh sync against this repo's root clone. */
export async function retrySyncRoot(repoName: string): Promise<void> {
  const res = await fetchWithAuth(
    `/api/sync-root/${encodeURIComponent(repoName)}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `retrySyncRoot failed: ${res.status}${body ? ` — ${body}` : ""}`,
    );
  }
}

export interface ResetAllDataResult {
  tablesCleared: string[];
  rowsDeleted: number;
  perTable: Record<string, number>;
}

/**
 * Wipe operational data (dispatches, threads, events, health_check).
 * Users + api_tokens are preserved so the current session stays valid.
 * `{confirm: "RESET"}` sentinel is a defense-in-depth guard against
 * accidental POSTs (the SettingsPage dialog supplies it).
 *
 * Failures surface as a plain Error (no inline ToggleError affordance
 * for this admin path).
 */
export async function resetAllData(): Promise<ResetAllDataResult> {
  try {
    return await jsonRequest<ResetAllDataResult>(
      "POST",
      "/api/admin/reset",
      { confirm: "RESET" },
    );
  } catch (err) {
    const e = err as { serverMessage?: string; status?: number };
    if (e.serverMessage) throw new Error(e.serverMessage);
    throw new Error(`resetAllData failed: ${e.status ?? "unknown"}`);
  }
}
