<script setup lang="ts">
import type { UserBlock } from "../../types";

defineProps<{ block: UserBlock }>();
</script>

<template>
  <div class="border-l-2 border-blue-400/70 pl-4 mb-4">
    <div class="text-[11px] font-semibold uppercase tracking-wider text-blue-300 mb-1">User</div>
    <div class="text-slate-100 whitespace-pre-wrap">{{ block.text }}</div>
  </div>
</template>
