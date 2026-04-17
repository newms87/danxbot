<script setup lang="ts">
import { computed } from "vue";
import type { UsageBlock } from "../../types";

const props = defineProps<{ block: UsageBlock }>();

const total = computed(
  () =>
    props.block.usage.tokensIn +
    props.block.usage.tokensOut +
    props.block.usage.cacheRead +
    props.block.usage.cacheWrite,
);
</script>

<template>
  <div class="font-mono text-[10.5px] text-slate-500 my-1 ml-4">
    usage: total {{ total.toLocaleString() }} · in {{ block.usage.tokensIn.toLocaleString() }} ·
    out {{ block.usage.tokensOut.toLocaleString() }} ·
    cache r/w {{ block.usage.cacheRead.toLocaleString() }}/{{ block.usage.cacheWrite.toLocaleString() }}
  </div>
</template>
