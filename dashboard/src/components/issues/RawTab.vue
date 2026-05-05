<script setup lang="ts">
import type { IssueDetail } from "../../types";
import { CodeViewer } from "danx-ui";

defineProps<{
  issue: IssueDetail;
}>();
</script>

<template>
  <div class="raw-wrap">
    <div v-if="!issue.raw_yaml" class="empty">
      Raw YAML not available.
    </div>
    <CodeViewer
      v-else
      :model-value="issue.raw_yaml"
      format="yaml"
      theme="dark"
      hide-footer
    />
  </div>
</template>

<style scoped>
.raw-wrap {
  padding: 16px 20px;
}
.empty {
  padding: 24px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
</style>
