<script setup lang="ts">
/**
 * Triage button. Two states:
 *
 *   1. No active triage dispatch for the selected repo →
 *      "Triage…" button, opens `TriageDialog` to launch one.
 *   2. Active triage dispatch in flight →
 *      pulsing "Triage running" indicator, opens `TriageStatusDialog`
 *      with the operator notes + a Cancel button.
 *
 * Active-state detection runs through `useActiveTriage`, which derives
 * from the SSE-fed `useDispatches` store — no polling. The disabled
 * state on the launch button (no repo selected) collapses to the same
 * `!repo` guard.
 */
import { computed, ref, toRef } from "vue";
import { DanxTooltip } from "@thehammer/danx-ui";
import TriageDialog from "./TriageDialog.vue";
import TriageStatusDialog from "./TriageStatusDialog.vue";
import { useActiveTriage } from "../../composables/useActiveTriage";

const props = defineProps<{
  /** Repo to scope the triage against. Empty string disables the button. */
  repo: string;
}>();

const emit = defineEmits<{
  /** Fired after a successful launch dispatch. */
  dispatched: [];
}>();

const launchOpen = ref<boolean>(false);
const statusOpen = ref<boolean>(false);

const activeTriage = useActiveTriage(toRef(props, "repo"));
const isRunning = computed<boolean>(() => activeTriage.value !== null);

function onLaunchClick(): void {
  if (!props.repo) return;
  if (isRunning.value) return;
  launchOpen.value = true;
}

function onIndicatorClick(): void {
  if (!isRunning.value) return;
  statusOpen.value = true;
}

function onDispatched(): void {
  emit("dispatched");
}
</script>

<template>
  <template v-if="isRunning && activeTriage">
    <DanxTooltip tooltip="Triage orchestrator is running — click for status / cancel">
      <template #trigger>
        <button
          type="button"
          class="triage-running"
          data-test="issues-triage-running"
          @click="onIndicatorClick"
        >
          <span class="pulse-dot" />
          Triage running
        </button>
      </template>
    </DanxTooltip>

    <TriageStatusDialog
      v-model="statusOpen"
      :repo="repo"
      :dispatch="activeTriage"
    />
  </template>

  <template v-else>
    <DanxTooltip tooltip="Dispatch a triage orchestrator over the Review list">
      <template #trigger>
        <button
          type="button"
          class="triage-btn"
          :disabled="!repo"
          data-test="issues-triage-button"
          @click="onLaunchClick"
        >Triage…</button>
      </template>
    </DanxTooltip>

    <TriageDialog
      v-if="repo"
      v-model="launchOpen"
      :repo="repo"
      @dispatched="onDispatched"
    />
  </template>
</template>

<style scoped>
.triage-btn {
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #cbd5e1;
  background: rgb(30 41 59 / 0.6);
  border: 1px solid #334155;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms;
}
.triage-btn:hover:not(:disabled) {
  background: rgb(51 65 85 / 0.7);
  border-color: rgb(99 102 241 / 0.45);
  color: #e2e8f0;
}
.triage-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.triage-running {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: #fcd34d;
  background: rgb(245 158 11 / 0.10);
  border: 1px solid rgb(245 158 11 / 0.45);
  border-radius: 6px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: background 120ms, border-color 120ms;
}
.triage-running:hover {
  background: rgb(245 158 11 / 0.18);
  border-color: rgb(245 158 11 / 0.7);
}
.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fcd34d;
  animation: triage-pulse 1.2s ease-in-out infinite;
}
@keyframes triage-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
</style>
