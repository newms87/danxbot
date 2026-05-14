import { computed, type ComputedRef, type Ref } from "vue";
import { useDispatches } from "./useDispatches";
import type { Dispatch } from "../types";

/**
 * Active triage dispatch for the given repo. A triage dispatch is any
 * dispatch row whose `triggerMetadata.endpoint === "/api/triage"` and
 * whose `status` is non-terminal (queued / running). The dashboard
 * surfaces this so the Issues page can swap the Triage button for a
 * "Triage running" indicator and prevent a second dispatch landing
 * while one is in flight.
 *
 * Reactive to the global SSE `dispatch:created` / `dispatch:updated`
 * bus — the underlying composable owns the subscription. No polling.
 */
const NON_TERMINAL = new Set<Dispatch["status"]>(["queued", "running"]);

export function useActiveTriage(repo: Ref<string>): ComputedRef<Dispatch | null> {
  const { dispatches } = useDispatches();
  return computed<Dispatch | null>(() => {
    const name = repo.value;
    if (!name) return null;
    for (const d of dispatches.value) {
      if (d.repoName !== name) continue;
      if (!NON_TERMINAL.has(d.status)) continue;
      if (d.trigger !== "api") continue;
      const meta = d.triggerMetadata as { endpoint?: string };
      if (meta.endpoint !== "/api/triage") continue;
      return d;
    }
    return null;
  });
}
