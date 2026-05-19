<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Issue, IssueAcItem, IssueDetail } from "../../types";
import { patchIssue } from "../../api";
import { useDebouncedFn } from "../../composables/useDebouncedFn";
import ACBar from "./ACBar.vue";
import { acCounts } from "./acCounts";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "update:issue": [issue: Issue];
}>();

const DEBOUNCE_MS = 300;

function cloneAc(items: readonly IssueAcItem[]): IssueAcItem[] {
  return items.map((a) => ({ ...a }));
}

// Local optimistic copy. The user's click flips this first; the PATCH
// catches up after the debounce window. While the debounce timer is
// pending OR a PATCH is in flight, incoming `props.issue.ac` updates
// are ignored so we don't clobber the optimistic state with a stale
// snapshot the parent forwarded from a poll tick that started before
// the toggle.
const localAc = ref<IssueAcItem[]>(cloneAc(props.issue.ac));
const counts = computed(() => acCounts(localAc.value));
const saving = ref(false);
const errorMsg = ref<string | null>(null);

async function doSave(signal: AbortSignal): Promise<void> {
  const snapshot = cloneAc(localAc.value);
  saving.value = true;
  errorMsg.value = null;
  try {
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
      ac: snapshot,
    });
    if (signal.aborted) return;
    emit("update:issue", updated);
  } catch (err) {
    if (signal.aborted) return;
    // Revert optimistic local state to the canonical server state. The
    // watcher's `inFlight()` guard kept `props.issue.ac` from being
    // overwritten by any poll tick that landed while this PATCH was
    // pending — so reverting from props gets the user back to the
    // last known-good state, not a half-applied poll snapshot.
    localAc.value = cloneAc(props.issue.ac);
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (!signal.aborted) saving.value = false;
  }
}

const debouncedSave = useDebouncedFn(doSave, DEBOUNCE_MS, { abortPrevious: true });

function inFlight(): boolean {
  return saving.value || debouncedSave.pending.value;
}

watch(
  () => props.issue.ac,
  (next) => {
    if (inFlight()) return;
    localAc.value = cloneAc(next);
  },
  { deep: true },
);

function onToggle(i: number): void {
  if (i < 0 || i >= localAc.value.length) return;
  localAc.value = localAc.value.map((a, j) =>
    j === i ? { ...a, checked: !a.checked } : a,
  );
  debouncedSave.trigger();
}
</script>

<template>
  <div v-if="localAc.length === 0" class="empty">
    No acceptance criteria.
  </div>
  <div v-else class="ac-tab">
    <div class="bar-row">
      <ACBar :done="counts.done" :total="counts.total" />
      <span v-if="saving" class="saving" data-test="ac-saving">saving…</span>
    </div>
    <div v-if="errorMsg" class="error" data-test="ac-error">{{ errorMsg }}</div>
    <div class="ac-list">
      <button
        v-for="(a, i) in localAc"
        :key="i"
        type="button"
        class="ac-row"
        :class="{ done: a.checked, saving }"
        :data-test="`ac-row-${i}`"
        @click="onToggle(i)"
      >
        <span class="ac-chip" :class="{ done: a.checked }">{{ a.checked ? "✓" : "" }}</span>
        <span class="ac-text">{{ a.title }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 40px;
  text-align: center;
  color: #475569;
  font-size: 13px;
}
.ac-tab {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.saving {
  font-size: 11px;
  color: #94a3b8;
  font-style: italic;
  animation: ac-pulse 1.2s infinite ease-in-out;
}
@keyframes ac-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
.error {
  font-size: 12px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.1);
  border: 1px solid rgb(239 68 68 / 0.3);
  padding: 6px 10px;
  border-radius: 4px;
}
.ac-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ac-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.4;
  background: none;
  border: 0;
  padding: 4px 6px;
  margin-left: -6px;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  font-family: inherit;
  transition: background 120ms;
}
.ac-row:hover {
  background: rgb(51 65 85 / 0.4);
}
.ac-row:focus-visible {
  outline: 2px solid #6366f1;
  outline-offset: -2px;
}
.ac-row.done {
  color: #64748b;
}
.ac-row.saving {
  opacity: 0.75;
}
.ac-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-top: 1px;
  background: rgb(51 65 85 / 0.5);
  color: #475569;
  font-size: 11px;
  font-weight: 700;
}
.ac-chip.done {
  background: rgb(16 185 129 / 0.18);
  color: #6ee7b7;
}
.ac-text {
  text-wrap: pretty;
}
.ac-row.done .ac-text {
  text-decoration: line-through;
}
</style>
