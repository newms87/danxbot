<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail } from "../../types";
import { relativeTime } from "../../utils/relativeTime";
import { MarkdownEditor } from "@thehammer/danx-ui";

const props = defineProps<{
  issue: IssueDetail;
}>();

interface RenderedComment {
  author: string;
  tsLabel: string;
  text: string;
  isDanxbot: boolean;
}

function tsLabel(s: string): string {
  const n = Date.parse(s);
  if (Number.isNaN(n)) return s || "(no timestamp)";
  return relativeTime(n);
}

const comments = computed<RenderedComment[]>(() =>
  props.issue.comments.map((c) => ({
    author: c.author,
    tsLabel: tsLabel(c.timestamp),
    text: c.text,
    isDanxbot: c.author === "danxbot",
  })),
);
</script>

<template>
  <div v-if="comments.length === 0" class="empty">
    No comments yet.
  </div>
  <div v-else class="comments">
    <div
      v-for="(c, i) in comments"
      :key="i"
      class="bubble"
      :class="{ danxbot: c.isDanxbot }"
    >
      <div class="head">
        <span class="author" :class="{ danxbot: c.isDanxbot }">{{ c.author }}</span>
        <span class="ts">{{ c.tsLabel }}</span>
      </div>
      <MarkdownEditor
        :model-value="c.text"
        readonly
        hide-footer
        class="text"
      />
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 40px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.comments {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bubble {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgb(15 23 42 / 0.6);
  border: 1px solid #1e293b;
}
.bubble.danxbot {
  background: rgb(30 27 75 / 0.4);
  border-color: rgb(99 102 241 / 0.25);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.author {
  font-size: 12px;
  font-weight: 600;
  color: #e2e8f0;
}
.author.danxbot {
  color: #a5b4fc;
}
.ts {
  font-size: 11px;
  color: #64748b;
}
.text {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.5;
}
</style>
