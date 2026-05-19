import { watch } from "vue";
import type {
  Dispatch,
  DispatchDetail,
  DispatchFilters,
  JsonlBlock,
} from "../types";
import { useStream } from "../composables/useStream";
import { fetchWithAuth, jsonRequest } from "./_request";

function filtersToQuery(filters: DispatchFilters): string {
  const params = new URLSearchParams();
  if (filters.trigger) params.set("trigger", filters.trigger);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.status) params.set("status", filters.status);
  if (filters.since !== undefined) params.set("since", String(filters.since));
  if (filters.q) params.set("q", filters.q);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchDispatches(
  filters: DispatchFilters = {},
): Promise<Dispatch[]> {
  const res = await fetchWithAuth(`/api/dispatches${filtersToQuery(filters)}`);
  return res.json();
}

export async function fetchDispatchDetail(id: string): Promise<DispatchDetail> {
  const res = await fetchWithAuth(`/api/dispatches/${encodeURIComponent(id)}`);
  return res.json();
}

/** Cancel in-flight dispatch. Dual-auth proxy; SPA uses user bearer. */
export async function cancelDispatch(
  repo: string,
  jobId: string,
): Promise<void> {
  await jsonRequest<void>(
    "POST",
    `/api/cancel/${encodeURIComponent(jobId)}?repo=${encodeURIComponent(repo)}`,
  );
}

/**
 * Live-follow a dispatch via the multiplexed SSE stream. Each call spawns
 * its own `useStream()` instance — `disconnect()` on teardown affects
 * only this follow. `onError` fires at most once on the first
 * `connecting`/`connected` → `disconnected` transition; `useStream` then
 * reconnects on its own with exponential backoff.
 */
export function followDispatch(
  id: string,
  onBlock: (block: JsonlBlock) => void,
  onError: () => void,
): () => void {
  const stream = useStream();
  let errored = false;

  const unsub = stream.subscribe(`dispatch:jsonl:${id}`, (event) => {
    if (!Array.isArray(event.data)) {
      console.warn(
        `followDispatch(${id}): expected JsonlBlock[] payload, got`,
        event.data,
      );
      return;
    }
    for (const block of event.data as JsonlBlock[]) onBlock(block);
  });

  const stopWatch = watch(stream.connectionState, (state, prev) => {
    if (
      !errored &&
      state === "disconnected" &&
      (prev === "connecting" || prev === "connected")
    ) {
      errored = true;
      onError();
    }
  });

  return () => {
    stopWatch();
    unsub();
    stream.disconnect();
  };
}
