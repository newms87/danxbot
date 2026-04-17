<script setup lang="ts">
import type { SystemBlock } from "../../types";

defineProps<{ block: SystemBlock }>();
</script>

<template>
  <div class="text-[11px] text-slate-500 font-mono my-1 ml-4">
    [{{ block.subtype }}] {{ block.summary }}
  </div>
</template>
