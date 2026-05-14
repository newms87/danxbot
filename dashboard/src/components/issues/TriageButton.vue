<script setup lang="ts">
/**
 * DX-518 — Triage button. Lives in the Issues page header next to the
 * Paste / Create-Card controls. Click opens `TriageDialog`. Disabled
 * when no triage-eligible cards exist for the active repo (the dialog
 * would have nothing to dispatch against).
 */
import { computed, ref } from "vue";
import TriageDialog from "./TriageDialog.vue";
import type { IssueListItem } from "../../types";

const props = defineProps<{
  /** Repo to scope the triage against. Empty string disables the button. */
  repo: string;
  /**
   * Pool of triage-eligible candidates. The dialog filters internally —
   * the parent passes the full list of currently-loaded issues.
   */
  candidates: IssueListItem[];
  /**
   * Pre-select this id when the dialog opens. Typically the currently-
   * focused drawer card; null falls back to the first eligible card.
   */
  initialIssueId: string | null;
}>();

const emit = defineEmits<{
  /** Fired with the issue id after a successful dispatch. */
  dispatched: [issueId: string];
}>();

const dialogOpen = ref<boolean>(false);

// Mirror `local-issues.ts#inTriageScope` so the disabled state matches
// the dialog's selector contents — the operator never sees an enabled
// button that opens an empty dropdown. (List projection collapses
// `waiting_on` to a boolean; the worker reads the full record off YAML.)
function isTriageEligible(issue: IssueListItem): boolean {
  if (issue.waiting_on) return true;
  if (issue.status === "Review") return true;
  if (issue.status === "Blocked") return true;
  return false;
}

const hasEligibleCandidate = computed<boolean>(
  () => props.candidates.some(isTriageEligible),
);

const disabled = computed<boolean>(
  () => !props.repo || !hasEligibleCandidate.value,
);

function onClick(): void {
  if (disabled.value) return;
  dialogOpen.value = true;
}

function onDispatched(issueId: string): void {
  emit("dispatched", issueId);
}
</script>

<template>
  <button
    type="button"
    class="triage-btn"
    :disabled="disabled"
    data-test="issues-triage-button"
    title="Re-triage a Review / Blocked / Waiting-On card now"
    @click="onClick"
  >Triage…</button>

  <TriageDialog
    v-if="repo"
    v-model="dialogOpen"
    :repo="repo"
    :candidates="candidates"
    :initial-issue-id="initialIssueId"
    @dispatched="onDispatched"
  />
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
</style>
