<script setup lang="ts">
// Dispatch gates (blocked / waiting_on / conflict_on / requires_human)
// were lifted into the pinned `DispatchGatesSection` above the tabs in
// IssueDetailView. OverviewTab now renders only the description editor.
import { ref, watch } from "vue";
import type { Issue, IssueDetail } from "../../types";
import { patchIssue } from "../../api";
import { MarkdownEditor } from "@thehammer/danx-ui";

const props = defineProps<{
  issue: IssueDetail;
  repo: string;
}>();

const emit = defineEmits<{
  "update:issue": [issue: Issue];
}>();

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
    const { issue: updated } = await patchIssue(props.repo, props.issue.id, {
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
</style>
