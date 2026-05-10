<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail, IssueListItem } from "../../types";
import IssueCard from "./IssueCard.vue";

const props = defineProps<{
  issue: IssueDetail;
  allIssues: IssueListItem[];
  /**
   * Active repo name. Threaded into `<IssueCard>` so the agent badge
   * (`<AgentBadge>`) on each child can fetch the right per-repo avatar.
   */
  repo: string;
}>();

const emit = defineEmits<{
  "jump-issue": [id: string];
}>();

// Preserve YAML order from `issue.children` (phase order for epics).
// Children loaded into `allIssues` may live in different status columns;
// the index lookup keeps the rendered order canonical.
const childCards = computed<IssueListItem[]>(() => {
  const byId = new Map(props.allIssues.map((i) => [i.id, i]));
  const out: IssueListItem[] = [];
  for (const id of props.issue.children) {
    const hit = byId.get(id);
    if (hit) out.push(hit);
  }
  return out;
});

const missingCount = computed(
  () => props.issue.children.length - childCards.value.length,
);
</script>

<template>
  <div class="children-tab">
    <div v-if="childCards.length === 0" class="empty">
      No children loaded for this issue.
    </div>
    <div v-else class="cards">
      <IssueCard
        v-for="child in childCards"
        :key="child.id"
        :issue="child"
        :repo="props.repo"
        show-status
        @select="(i) => emit('jump-issue', i.id)"
        @parent-click="(pid) => emit('jump-issue', pid)"
      />
    </div>
    <div v-if="missingCount > 0" class="missing">
      {{ missingCount }} child{{ missingCount === 1 ? "" : "ren" }} not in current view
    </div>
  </div>
</template>

<style scoped>
.children-tab {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 20px;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  color: #64748b;
  border: 1px dashed #1e293b;
  border-radius: 8px;
}
.missing {
  font-size: 11px;
  color: #64748b;
  text-align: center;
  padding: 4px;
}
</style>
