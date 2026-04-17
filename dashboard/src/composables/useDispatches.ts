import { ref, computed, watch } from "vue";
import { fetchDispatches } from "../api";
import type {
  Dispatch,
  DispatchFilters,
  DispatchStatus,
  TriggerType,
} from "../types";

const REFRESH_INTERVAL_MS = 5_000;

const dispatches = ref<Dispatch[]>([]);
const loading = ref(false);
const selectedRepo = ref<string>("");
const selectedTrigger = ref<TriggerType | "">("");
const selectedStatus = ref<DispatchStatus | "">("");
const searchQuery = ref<string>("");

const filters = computed<DispatchFilters>(() => ({
  ...(selectedRepo.value ? { repo: selectedRepo.value } : {}),
  ...(selectedTrigger.value ? { trigger: selectedTrigger.value } : {}),
  ...(selectedStatus.value ? { status: selectedStatus.value } : {}),
  ...(searchQuery.value ? { q: searchQuery.value } : {}),
}));

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    dispatches.value = await fetchDispatches(filters.value);
  } finally {
    loading.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopWatch: (() => void) | null = null;

function init(): void {
  refresh();
  pollTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  stopWatch = watch(filters, () => {
    refresh();
  });
}

function destroy(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  stopWatch?.();
  stopWatch = null;
}

export function useDispatches() {
  return {
    dispatches,
    loading,
    selectedRepo,
    selectedTrigger,
    selectedStatus,
    searchQuery,
    refresh,
    init,
    destroy,
  };
}
