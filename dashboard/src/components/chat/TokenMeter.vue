<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatSession } from "./chatTypes";
import { fmtTokens } from "./chatTypes";

const props = defineProps<{ session: ChatSession }>();
const open = ref(false);

const total = computed(() => props.session.tokensTotal ?? 0);
const ctxMax = computed(() => props.session.contextWindow ?? 200_000);
const ctxPct = computed(() => Math.min(100, Math.round((total.value / ctxMax.value) * 100)));
const ctxColor = computed(() => {
  const p = ctxPct.value;
  if (p >= 90) return "#fca5a5";
  if (p >= 70) return "#fcd34d";
  return "#a5b4fc";
});

const hasUsage = computed(() => props.session.tokensTotal !== undefined);
</script>

<template>
  <div
    v-if="hasUsage"
    class="meter-wrap"
    @mouseenter="open = true"
    @mouseleave="open = false"
  >
    <button
      type="button"
      class="chip"
      :aria-expanded="open"
      @click="open = !open"
      @focus="open = true"
      @blur="open = false"
    >
      <span class="total">{{ fmtTokens(total) }}</span>
      <span class="bar"><span class="fill" :style="{ width: `${ctxPct}%`, background: ctxColor }" /></span>
      <span class="pct" :style="{ color: ctxColor }">{{ ctxPct }}%</span>
    </button>
    <div v-if="open" class="popover">
      <div class="popover-label">Token usage</div>
      <div class="grid">
        <span class="dim">Total</span><span class="val total-val">{{ total.toLocaleString() }}</span>
        <span class="dim">Input</span><span class="val">{{ (session.tokensIn ?? 0).toLocaleString() }}</span>
        <span class="dim">Output</span><span class="val">{{ (session.tokensOut ?? 0).toLocaleString() }}</span>
        <span class="dim">Cache read</span><span class="val cache">{{ (session.cacheRead ?? 0).toLocaleString() }}</span>
        <span class="dim">Cache write</span><span class="val cache">{{ (session.cacheWrite ?? 0).toLocaleString() }}</span>
      </div>
      <div class="footer">
        <span>Context window</span>
        <span :style="{ color: ctxColor }">{{ fmtTokens(total) }} / {{ fmtTokens(ctxMax) }} ({{ ctxPct }}%)</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.meter-wrap {
  position: relative;
  display: inline-flex;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 9999px;
  border: 1px solid #1e293b;
  background: rgb(15 23 42 / 0.6);
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  color: #cbd5e1;
}
.total {
  font-family: ui-monospace, monospace;
  color: #94a3b8;
  font-size: 10.5px;
}
.bar {
  width: 28px;
  height: 4px;
  border-radius: 9999px;
  background: #1e293b;
  position: relative;
  overflow: hidden;
}
.fill {
  position: absolute;
  inset: 0;
  right: auto;
  transition: width 240ms;
}
.pct {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 5;
  min-width: 220px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #0f172a;
  border: 1px solid #334155;
  box-shadow: 0 10px 30px -6px rgb(0 0 0 / 0.5);
  font-size: 11px;
  color: #cbd5e1;
}
.popover-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 6px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr auto;
  row-gap: 3px;
  font-family: ui-monospace, monospace;
}
.dim {
  color: #64748b;
}
.val {
  text-align: right;
}
.total-val {
  color: #e2e8f0;
}
.cache {
  color: #6ee7b7;
}
.footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #1e293b;
  display: flex;
  justify-content: space-between;
  color: #64748b;
  font-size: 10px;
}
</style>
