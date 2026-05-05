<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { useIssues } from "../../composables/useIssues";
import IssueBoard from "./IssueBoard.vue";
import IssueDrawer from "./IssueDrawer.vue";
import type { IssueDetail, IssueListItem } from "../../types";

const props = defineProps<{
  selectedRepo: string;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
}>();

const { issues, loading, error, refresh, fetchDetail } = useIssues(
  toRef(props, "selectedRepo"),
);

const selectedIssueId = ref<string | null>(null);
const selectedDetail = ref<IssueDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

function readUrlIssue(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("issue");
}

function writeUrlIssue(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set("issue", id);
  } else {
    url.searchParams.delete("issue");
  }
  window.history.replaceState({}, "", url.toString());
}

async function openDrawer(id: string): Promise<void> {
  selectedIssueId.value = id;
  writeUrlIssue(id);
  detailLoading.value = true;
  detailError.value = null;
  try {
    const detail = await fetchDetail(id);
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

function onSelect(issue: IssueListItem): void {
  emit("select", issue);
  void openDrawer(issue.id);
}

function onJumpIssue(id: string): void {
  void openDrawer(id);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && selectedIssueId.value) closeDrawer();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  const initial = readUrlIssue();
  if (initial) void openDrawer(initial);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

// On repo switch, drop selection — different repo's issue ids don't apply.
watch(
  () => props.selectedRepo,
  () => {
    if (selectedIssueId.value) closeDrawer();
  },
);
</script>

<template>
  <section>
    <div v-if="error" class="error-banner">
      {{ error }}
      <button type="button" class="retry" @click="refresh">retry</button>
    </div>

    <div v-if="!selectedRepo" class="placeholder">Select a repo to see issues</div>
    <div v-else-if="loading && issues.length === 0" class="placeholder">Loading issues…</div>
    <div v-else-if="issues.length === 0" class="placeholder">No issues yet</div>
    <IssueBoard v-else :issues="issues" @select="onSelect" />

    <IssueDrawer
      v-if="selectedIssueId"
      :issue="selectedDetail"
      :loading="detailLoading"
      :all-issues="issues"
      @close="closeDrawer"
      @jump-issue="onJumpIssue"
    />
    <div v-if="detailError" class="error-banner detail-err">
      {{ detailError }}
    </div>
  </section>
</template>

<style scoped>
.error-banner {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgb(239 68 68 / 0.4);
  background: rgb(239 68 68 / 0.1);
  color: #fca5a5;
  font-size: 12px;
}
.detail-err {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 60;
  max-width: 360px;
}
.retry {
  margin-left: 8px;
  text-decoration: underline;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
}
.placeholder {
  padding: 40px 16px;
  text-align: center;
  font-size: 12px;
  color: #64748b;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
</style>
