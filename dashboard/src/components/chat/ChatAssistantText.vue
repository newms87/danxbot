<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<template>
  <div class="assistant-text">{{ text }}</div>
</template>

<style scoped>
.assistant-text {
  margin-bottom: 10px;
  padding: 2px 0;
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.55;
  text-wrap: pretty;
  white-space: pre-wrap;
}
</style>
