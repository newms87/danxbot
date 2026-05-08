import { computed, onBeforeUnmount, ref } from "vue";
import type { Ref } from "vue";
import { fetchSystemErrors } from "../api";
import {
  createHydrationBuffer,
  useStream,
  type HydrationBuffer,
  type StreamEvent,
  type UseStreamReturn,
} from "./useStream";
import type { SystemError } from "../types";

export interface UseSystemErrors {
  /** All known events newest-first, MINUS locally-dismissed ones. */
  visible: Ref<SystemError[]>;
  /** Total count of visible (non-dismissed) events — drives the banner badge. */
  count: Ref<number>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** Locally hide a single event by id. Does NOT round-trip to the server. */
  dismiss: (id: string) => void;
  /** Reset dismissals — useful when the banner is force-reopened. */
  resetDismissed: () => void;
  init: () => Promise<void>;
  destroy: () => void;
}

/** Cap on the buffer the banner displays. Matches the backend's hard cap. */
const CLIENT_LIMIT = 200;

function isSystemError(data: unknown): data is SystemError {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.timestamp === "string" &&
    typeof obj.source === "string" &&
    typeof obj.severity === "string" &&
    typeof obj.repo === "string" &&
    typeof obj.message === "string"
  );
}

/**
 * Reducer: prepend a live `system-errors` event to the existing list.
 * Newest-first ordering matches the REST seed; capacity cap matches the
 * backend ring buffer so a long-running session doesn't grow unbounded.
 * Idempotent on duplicate ids (same UUID → no change), which protects
 * against an SSE reconnect replaying an already-applied event.
 */
export function applySystemErrorEvent(
  state: SystemError[],
  event: SystemError,
): SystemError[] {
  if (state.some((e) => e.id === event.id)) return state;
  const next = [event, ...state];
  if (next.length > CLIENT_LIMIT) next.length = CLIENT_LIMIT;
  return next;
}

/**
 * Build the system-errors banner state: REST seed on init + `system-errors`
 * SSE subscription for live updates, with the same hydration-buffer race
 * shielding `useDispatches` and `useAgents` use. Dismissals are local UI
 * state only (per the card description's "click-to-dismiss is local UI
 * state only" out-of-scope note).
 */
export function useSystemErrors(): UseSystemErrors {
  const events = ref<SystemError[]>([]);
  const dismissed = ref<Set<string>>(new Set());
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  let stream: UseStreamReturn | null = null;
  let buffer: HydrationBuffer<SystemError[]> | null = null;
  let liveUnsub: (() => void) | null = null;

  function applyOne(state: SystemError[], event: StreamEvent): SystemError[] {
    if (event.topic !== "system-errors") return state;
    if (!isSystemError(event.data)) return state;
    return applySystemErrorEvent(state, event.data);
  }

  async function init(): Promise<void> {
    if (stream || buffer) return;
    loading.value = true;
    error.value = null;
    stream = useStream();
    buffer = createHydrationBuffer<SystemError[]>(stream, "system-errors");
    liveUnsub = buffer.onLiveEvent((event) => {
      events.value = applyOne(events.value, event);
    });
    try {
      events.value = await buffer.hydrate(
        () => fetchSystemErrors({ limit: CLIENT_LIMIT }),
        applyOne,
      );
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  function destroy(): void {
    liveUnsub?.();
    liveUnsub = null;
    buffer?.close();
    buffer = null;
    stream?.disconnect();
    stream = null;
  }

  function dismiss(id: string): void {
    if (dismissed.value.has(id)) return;
    const next = new Set(dismissed.value);
    next.add(id);
    dismissed.value = next;
  }

  function resetDismissed(): void {
    dismissed.value = new Set();
  }

  const visible = computed(() =>
    events.value.filter((e) => !dismissed.value.has(e.id)),
  );
  const count = computed(() => visible.value.length);

  onBeforeUnmount(() => {
    destroy();
  });

  return {
    visible,
    count,
    loading,
    error,
    dismiss,
    resetDismissed,
    init,
    destroy,
  };
}
