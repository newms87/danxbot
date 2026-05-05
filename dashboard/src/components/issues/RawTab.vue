<script setup lang="ts">
import { computed } from "vue";
import type { IssueDetail } from "../../types";

const props = defineProps<{
  issue: IssueDetail;
}>();

const yaml = computed(() => {
  const i = props.issue;
  const lines: string[] = [];
  lines.push(`id: ${i.id}`);
  lines.push(`type: ${i.type}`);
  lines.push(`status: ${i.status}`);
  if (i.parent_id) lines.push(`parent_id: ${i.parent_id}`);
  if (i.children.length > 0) {
    lines.push(`children:`);
    for (const c of i.children) lines.push(`  - ${c}`);
  }
  lines.push(`title: ${JSON.stringify(i.title)}`);
  lines.push(`description: |`);
  for (const l of (i.description || "").split("\n")) lines.push(`  ${l}`);
  if (i.ac.length > 0) {
    lines.push(`ac:`);
    for (const a of i.ac) {
      lines.push(`  - { checked: ${a.checked}, title: ${JSON.stringify(a.title)} }`);
    }
  }
  if (i.phases.length > 0) {
    lines.push(`phases:`);
    for (const p of i.phases) {
      lines.push(`  - { status: ${p.status}, title: ${JSON.stringify(p.title)} }`);
    }
  }
  if (i.blocked) {
    lines.push(`blocked:`);
    lines.push(`  reason: ${JSON.stringify(i.blocked.reason)}`);
    lines.push(`  timestamp: ${i.blocked.timestamp}`);
    if (i.blocked.by.length > 0) {
      lines.push(`  by: [${i.blocked.by.join(", ")}]`);
    }
  }
  lines.push(`updated_at: ${new Date(i.updated_at).toISOString()}`);
  return lines.join("\n");
});
</script>

<template>
  <pre class="raw">{{ yaml }}</pre>
</template>

<style scoped>
.raw {
  margin: 0;
  padding: 16px 20px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: #cbd5e1;
  line-height: 1.55;
  background: #020617;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
