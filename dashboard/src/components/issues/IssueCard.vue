<script setup lang="ts">
import { computed } from "vue";
import type { IssueListItem } from "../../types";
import TypeBadge from "./TypeBadge.vue";
import { relativeTime } from "../../utils/relativeTime";

const props = defineProps<{
  issue: IssueListItem;
}>();

const emit = defineEmits<{
  select: [issue: IssueListItem];
}>();

const updatedLabel = computed(() => relativeTime(props.issue.updated_at));
</script>

<template>
  <button class="issue-card" type="button" @click="emit('select', issue)">
    <div class="card-header">
      <span class="id-chip">{{ issue.id }}</span>
      <TypeBadge :type="issue.type" compact />
    </div>

    <div class="title">{{ issue.title }}</div>

    <div class="footer">
      <!-- Parent epic id rendered as plain label until scope-to-epic ships in a later phase. -->
      <span v-if="issue.parent_id" class="parent-chip" :title="`Parent epic ${issue.parent_id}`">
        ↑ {{ issue.parent_id }}
      </span>
      <span v-if="issue.comments_count > 0" class="comments">
        <span class="emoji">💬</span>{{ issue.comments_count }}
      </span>
      <span v-if="issue.has_retro" class="retro">retro</span>
      <span class="updated">{{ updatedLabel }}</span>
    </div>
  </button>
</template>

<style scoped>
.issue-card {
  text-align: left;
  width: 100%;
  display: block;
  background: rgb(15 23 42 / 0.7);
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-family: inherit;
  box-shadow: 0 1px 0 rgb(0 0 0 / 0.2);
  transition: background-color 150ms, transform 100ms;
}
.issue-card:hover {
  transform: translateY(-1px);
}
.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.id-chip {
  font-size: 10px;
  font-weight: 600;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.title {
  font-size: 13px;
  font-weight: 500;
  color: #e2e8f0;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11px;
  color: #64748b;
}
.parent-chip {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  color: #a5b4fc;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.25);
}
.comments {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.comments .emoji {
  font-size: 10px;
}
.retro {
  color: #86efac;
  font-size: 10px;
}
.updated {
  margin-left: auto;
  font-size: 10px;
}
</style>
