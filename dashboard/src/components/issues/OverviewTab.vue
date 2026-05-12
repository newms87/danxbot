<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ConflictOnEntry, Issue, IssueDetail, IssueStatus } from "../../types";
import { patchIssue } from "../../api";
import { MarkdownEditor } from "@thehammer/danx-ui";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "jump-issue": [id: string];
  "update:issue": [issue: Issue];
}>();

// DX-309 — three orthogonal dispatch gates render in the "Dispatch gates"
// subsection. Hidden iff every gate is empty.
const selfBlocked = computed(() => props.issue.blocked);
const waitingOn = computed(() => props.issue.waiting_on);
const conflictForward = computed(() => props.issue.conflict_on ?? []);
const conflictReverse = computed(() => props.issue.conflict_on_reverse ?? []);
const partnerSummaries = computed(() => props.issue.conflict_on_partners ?? {});
const hasAnyGate = computed(
  () =>
    selfBlocked.value !== null ||
    waitingOn.value !== null ||
    conflictForward.value.length > 0 ||
    conflictReverse.value.length > 0,
);

function partnerStatus(id: string): IssueStatus | null {
  return partnerSummaries.value[id]?.status ?? null;
}
function partnerTitle(id: string): string | null {
  return partnerSummaries.value[id]?.title ?? null;
}

const gateError = ref<string | null>(null);
const gateBusy = ref(false);

async function clearBlocked(): Promise<void> {
  gateBusy.value = true;
  gateError.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      blocked: null,
      status: "ToDo",
    });
    emit("update:issue", updated);
  } catch (err) {
    gateError.value = err instanceof Error ? err.message : String(err);
  } finally {
    gateBusy.value = false;
  }
}

async function clearConflictEntry(entry: ConflictOnEntry): Promise<void> {
  gateBusy.value = true;
  gateError.value = null;
  try {
    const next = conflictForward.value.filter((e) => e.id !== entry.id);
    const updated = await patchIssue(props.repo, props.issue.id, {
      conflict_on: next,
    });
    emit("update:issue", updated);
  } catch (err) {
    gateError.value = err instanceof Error ? err.message : String(err);
  } finally {
    gateBusy.value = false;
  }
}

const editing = ref(false);
const draft = ref("");
const saving = ref(false);
const errorMsg = ref<string | null>(null);

// Drop edit state whenever the drawer switches cards — otherwise the new
// card opens with stale draft text + edit mode left over from the prior
// card.
watch(
  () => props.issue.id,
  () => {
    editing.value = false;
    saving.value = false;
    errorMsg.value = null;
    draft.value = "";
  },
);

function startEdit(): void {
  draft.value = props.issue.description;
  editing.value = true;
  errorMsg.value = null;
}

function cancel(): void {
  editing.value = false;
  draft.value = "";
  errorMsg.value = null;
}

async function save(): Promise<void> {
  saving.value = true;
  errorMsg.value = null;
  try {
    const updated = await patchIssue(props.repo, props.issue.id, {
      description: draft.value,
    });
    emit("update:issue", updated);
    editing.value = false;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="overview">
    <section
      v-if="hasAnyGate"
      class="dispatch-gates"
      data-test="dispatch-gates"
    >
      <div class="gates-title">Dispatch gates</div>

      <div
        v-if="selfBlocked"
        class="gate gate-blocked"
        data-test="gate-blocked"
      >
        <div class="gate-head">
          <span class="gate-glyph">🔒</span>
          <span class="gate-label">Blocked</span>
          <span class="gate-time">{{ selfBlocked.timestamp }}</span>
          <button
            type="button"
            class="clear-btn"
            :disabled="gateBusy"
            data-test="clear-blocked"
            @click="clearBlocked"
          >Clear</button>
        </div>
        <div class="gate-reason">{{ selfBlocked.reason }}</div>
      </div>

      <div
        v-if="waitingOn"
        class="gate gate-waiting"
        data-test="gate-waiting"
      >
        <div class="gate-head">
          <span class="gate-glyph">⏳</span>
          <span class="gate-label">Waiting on</span>
          <span class="gate-time">{{ waitingOn.timestamp }}</span>
        </div>
        <div class="gate-reason">{{ waitingOn.reason }}</div>
        <ul v-if="waitingOn.by.length > 0" class="partners">
          <li v-for="bid in waitingOn.by" :key="bid">
            <button
              type="button"
              class="partner-chip"
              @click="$emit('jump-issue', bid)"
            >{{ bid }}</button>
            <span v-if="partnerStatus(bid)" class="partner-status">{{ partnerStatus(bid) }}</span>
            <span v-if="partnerTitle(bid)" class="partner-title">{{ partnerTitle(bid) }}</span>
          </li>
        </ul>
      </div>

      <div
        v-if="conflictForward.length > 0 || conflictReverse.length > 0"
        class="gate gate-conflict"
        data-test="gate-conflict"
      >
        <div class="gate-head">
          <span class="gate-glyph">⚡</span>
          <span class="gate-label">Conflict on</span>
        </div>
        <ul v-if="conflictForward.length > 0" class="conflict-list">
          <li v-for="entry in conflictForward" :key="`fwd-${entry.id}`">
            <button
              type="button"
              class="partner-chip conflict-chip"
              @click="$emit('jump-issue', entry.id)"
            >{{ entry.id }}</button>
            <span v-if="partnerStatus(entry.id)" class="partner-status">{{ partnerStatus(entry.id) }}</span>
            <span class="conflict-reason">{{ entry.reason }}</span>
            <button
              type="button"
              class="clear-btn"
              :disabled="gateBusy"
              :data-test="`clear-conflict-${entry.id}`"
              @click="clearConflictEntry(entry)"
            >Clear</button>
          </li>
        </ul>
        <ul v-if="conflictReverse.length > 0" class="conflict-list reverse">
          <li v-for="entry in conflictReverse" :key="`rev-${entry.id}`">
            <span class="reverse-arrow">↩</span>
            <button
              type="button"
              class="partner-chip conflict-chip"
              @click="$emit('jump-issue', entry.id)"
            >{{ entry.id }}</button>
            <span v-if="partnerStatus(entry.id)" class="partner-status">{{ partnerStatus(entry.id) }}</span>
            <span class="conflict-reason">{{ entry.reason }}</span>
            <span class="reverse-note">declared on partner</span>
          </li>
        </ul>
      </div>

      <div v-if="gateError" class="error" data-test="dispatch-gates-error">{{ gateError }}</div>
    </section>

    <section v-if="issue.description || editing">
      <div class="section-label">
        <span>Description</span>
        <button
          v-if="!editing"
          type="button"
          class="edit-btn"
          data-test="overview-edit-description"
          @click="startEdit"
        >Edit</button>
      </div>
      <template v-if="editing">
        <div class="editor-wrap" data-test="overview-description-editor-wrap">
          <MarkdownEditor
            v-model="draft"
            hide-footer
            data-test="overview-description-editor"
          />
        </div>
        <div v-if="errorMsg" class="error" data-test="overview-description-error">{{ errorMsg }}</div>
        <div class="actions">
          <button
            type="button"
            class="save-btn"
            :disabled="saving"
            data-test="overview-save-description"
            @click="save"
          >{{ saving ? "Saving…" : "Save" }}</button>
          <button
            type="button"
            class="cancel-btn"
            :disabled="saving"
            data-test="overview-cancel-description"
            @click="cancel"
          >Cancel</button>
        </div>
      </template>
      <MarkdownEditor
        v-else
        :model-value="issue.description"
        readonly
        hide-footer
      />
    </section>
  </div>
</template>

<style scoped>
.overview {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 20px;
}
.section-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.edit-btn {
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  color: #a5b4fc;
  background: rgb(99 102 241 / 0.12);
  border: 1px solid rgb(99 102 241 / 0.3);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  text-transform: none;
  letter-spacing: normal;
}
.edit-btn:hover {
  background: rgb(99 102 241 / 0.2);
}
.editor-wrap {
  border: 1px solid #6366f1;
  border-radius: 4px;
}
.error {
  font-size: 12px;
  color: #fca5a5;
  background: rgb(239 68 68 / 0.1);
  border: 1px solid rgb(239 68 68 / 0.3);
  padding: 6px 10px;
  border-radius: 4px;
  margin-top: 6px;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}
.save-btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #f1f5f9;
  background: #6366f1;
  border: 0;
  border-radius: 4px;
  padding: 5px 12px;
  cursor: pointer;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cancel-btn {
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #94a3b8;
  background: rgb(30 41 59 / 0.5);
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 5px 12px;
  cursor: pointer;
}
.cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dispatch-gates {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gates-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}
.gate {
  padding: 10px 12px;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gate-blocked {
  background: rgb(239 68 68 / 0.08);
  border: 1px solid rgb(239 68 68 / 0.3);
}
.gate-waiting {
  background: rgb(245 158 11 / 0.08);
  border: 1px solid rgb(245 158 11 / 0.3);
}
.gate-conflict {
  background: rgb(168 85 247 / 0.08);
  border: 1px solid rgb(168 85 247 / 0.3);
}
.gate-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.gate-blocked .gate-head { color: #fca5a5; }
.gate-waiting .gate-head { color: #fcd34d; }
.gate-conflict .gate-head { color: #d8b4fe; }
.gate-glyph {
  font-size: 12px;
}
.gate-time {
  font-size: 10px;
  font-weight: 400;
  color: #64748b;
  text-transform: none;
  letter-spacing: normal;
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}
.gate-reason {
  font-size: 13px;
  line-height: 1.5;
}
.gate-blocked .gate-reason { color: #fecaca; }
.gate-waiting .gate-reason { color: #fde68a; }
.partners,
.conflict-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.partners > li,
.conflict-list > li {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.partner-chip {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  color: #e2e8f0;
  background: rgb(15 23 42 / 0.5);
  border: 1px solid #334155;
  cursor: pointer;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
.gate-waiting .partner-chip {
  color: #fde68a;
  background: rgb(245 158 11 / 0.15);
  border-color: rgb(245 158 11 / 0.35);
}
.gate-conflict .partner-chip.conflict-chip {
  color: #d8b4fe;
  background: rgb(168 85 247 / 0.15);
  border-color: rgb(168 85 247 / 0.35);
}
.partner-status {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(15 23 42 / 0.4);
  border: 1px solid #1e293b;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.partner-title {
  font-size: 12px;
  color: #cbd5e1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conflict-reason {
  font-size: 12px;
  color: #e9d5ff;
  flex: 1;
  min-width: 120px;
}
.conflict-list.reverse > li {
  opacity: 0.8;
}
.reverse-arrow {
  font-size: 12px;
  color: #c4b5fd;
}
.reverse-note {
  font-size: 10px;
  font-style: italic;
  color: #94a3b8;
}
.clear-btn {
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  color: #cbd5e1;
  background: rgb(30 41 59 / 0.6);
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  margin-left: auto;
  text-transform: none;
  letter-spacing: normal;
}
.clear-btn:hover:not(:disabled) {
  background: rgb(30 41 59 / 0.9);
}
.clear-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
