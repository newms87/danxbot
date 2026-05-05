<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail } from "../../types";
import { MarkdownEditor } from "danx-ui";

const props = defineProps<{
  issue: IssueDetail;
}>();

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0);
}

const good = computed(() => splitLines(props.issue.retro.good));
const bad = computed(() => splitLines(props.issue.retro.bad));
const actionItems = computed(() => props.issue.retro.action_item_ids);
const commits = computed(() => props.issue.retro.commits);

const hasContent = computed(
  () =>
    good.value.length > 0 ||
    bad.value.length > 0 ||
    actionItems.value.length > 0 ||
    commits.value.length > 0,
);
</script>

<template>
  <div v-if="!hasContent" class="empty">
    No retro for this issue.
    <div class="empty-hint">Retros are auto-generated when an issue is marked done.</div>
  </div>
  <div v-else class="retro">
    <section v-if="good.length > 0">
      <div class="head good">What went well</div>
      <div class="md-list">
        <MarkdownEditor
          v-for="(x, i) in good"
          :key="`g${i}`"
          :model-value="x"
          readonly
          hide-footer
          class="md-item"
        />
      </div>
    </section>
    <section v-if="bad.length > 0">
      <div class="head bad">What didn't</div>
      <div class="md-list">
        <MarkdownEditor
          v-for="(x, i) in bad"
          :key="`b${i}`"
          :model-value="x"
          readonly
          hide-footer
          class="md-item"
        />
      </div>
    </section>
    <section v-if="actionItems.length > 0">
      <div class="head action">Action items</div>
      <ul>
        <li v-for="(x, i) in actionItems" :key="i">{{ x }}</li>
      </ul>
    </section>
    <section v-if="commits.length > 0">
      <div class="head commits">Commits</div>
      <div class="commit-row">
        <span v-for="c in commits" :key="c" class="commit-chip">{{ c }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.empty {
  padding: 40px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.empty-hint {
  margin-top: 6px;
  font-size: 11px;
}
.retro {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.head {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.head.good { color: #6ee7b7; }
.head.bad { color: #fca5a5; }
.head.action { color: #fcd34d; }
.head.commits { color: #94a3b8; }
.md-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.md-item {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.6;
}
.commit-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.commit-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgb(15 23 42 / 0.8);
  color: #94a3b8;
  border: 1px solid #1e293b;
}
</style>
