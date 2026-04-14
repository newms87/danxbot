import { ref, computed, watch } from "vue";
import type { MessageEvent, AnalyticsSummary } from "../types";
import { fetchEvents, fetchAnalytics, fetchRepos, connectSSE } from "../api";
import type { RepoInfo } from "../api";

const events = ref<MessageEvent[]>([]);
const analytics = ref<AnalyticsSummary>({
  totalMessages: 0,
  completedMessages: 0,
  routerOnlyMessages: 0,
  agentMessages: 0,
  avgRouterTimeMs: 0,
  avgAgentTimeMs: 0,
  avgTotalTimeMs: 0,
  totalSubscriptionCostUsd: 0,
  totalApiCostUsd: 0,
  totalCombinedCostUsd: 0,
  errorCount: 0,
  feedbackPositive: 0,
  feedbackNegative: 0,
  feedbackRate: 0,
});
const repos = ref<RepoInfo[]>([]);
const selectedRepo = ref<string>("");
const selectedEvent = ref<MessageEvent | null>(null);
const connected = ref(false);
const searchQuery = ref("");
const statusFilter = ref("all");

let cleanup: (() => void) | null = null;

const filteredEvents = computed(() => {
  let filtered = events.value;
  // Repo filtering is done server-side, but also filter SSE events client-side
  if (selectedRepo.value) {
    filtered = filtered.filter((e) => e.repoName === selectedRepo.value);
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    filtered = filtered.filter((e) => e.text.toLowerCase().includes(q));
  }
  if (statusFilter.value !== "all") {
    if (statusFilter.value === "router_only") {
      filtered = filtered.filter(
        (e) => e.status === "complete" && e.agentResponseAt === null,
      );
    } else {
      filtered = filtered.filter((e) => e.status === statusFilter.value);
    }
  }
  return filtered;
});

async function fetchAll() {
  const repo = selectedRepo.value || undefined;
  const [evts, stats] = await Promise.all([fetchEvents(repo), fetchAnalytics(repo)]);
  events.value = evts;
  analytics.value = stats;
}

function selectEvent(event: MessageEvent) {
  selectedEvent.value = event;
}

function clearSelection() {
  selectedEvent.value = null;
}

function init() {
  // Load available repos
  fetchRepos().then((r) => {
    repos.value = r;
  });

  fetchAll();
  cleanup = connectSSE(
    (updated) => {
      const idx = events.value.findIndex((ev) => ev.id === updated.id);
      if (idx >= 0) {
        events.value[idx] = updated;
      } else {
        events.value.unshift(updated);
      }
      if (selectedEvent.value?.id === updated.id) {
        selectedEvent.value = updated;
      }
      const repo = selectedRepo.value || undefined;
      fetchAnalytics(repo).then((data) => (analytics.value = data));
    },
    () => (connected.value = true),
    () => (connected.value = false),
  );

  // Re-fetch when repo filter changes
  watch(selectedRepo, () => {
    fetchAll();
  });
}

function destroy() {
  cleanup?.();
  cleanup = null;
}

export function useEvents() {
  return {
    events,
    analytics,
    repos,
    selectedRepo,
    selectedEvent,
    connected,
    searchQuery,
    statusFilter,
    filteredEvents,
    fetchAll,
    selectEvent,
    clearSelection,
    init,
    destroy,
  };
}
