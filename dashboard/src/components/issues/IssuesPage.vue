<script setup lang="ts">
import { toRef } from "vue";
import { useIssues } from "../../composables/useIssues";
import IssueBoard from "./IssueBoard.vue";
import type { IssueListItem } from "../../types";

const props = defineProps<{
  selectedRepo: string;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
}>();

const { issues, loading, error, refresh } = useIssues(toRef(props, "selectedRepo"));
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
    <IssueBoard v-else :issues="issues" @select="(i) => emit('select', i)" />
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
