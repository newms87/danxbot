<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  label: string;
}>();

const expanded = ref(false);
</script>

<template>
  <div>
    <button
      class="flex items-center gap-1 text-xs text-gray-500 uppercase tracking-wide hover:text-gray-700 dark:hover:text-gray-300"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? '▼' : '▶' }}</span> {{ label }}
    </button>
    <div v-if="expanded" class="mt-2">
      <slot />
    </div>
  </div>
</template>
