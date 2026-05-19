<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxButton, DanxDialog, trashIcon } from "@thehammer/danx-ui";
import { deleteIssue } from "../../api";

const props = defineProps<{
  repo: string;
  issueId: string;
  childCount: number;
}>();

const emit = defineEmits<{
  deleted: [];
}>();

const open = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.issueId,
  () => {
    open.value = false;
    busy.value = false;
    error.value = null;
  },
);

const bodyText = computed(() => {
  if (props.childCount > 0) {
    const n = props.childCount;
    return `Move ${props.issueId} and its ${n} ${n === 1 ? "child" : "descendants"} (recursive) to /tmp/danxbot/${props.repo}/issues/. The YAML survives on disk until the OS clears /tmp — no in-dashboard undo.`;
  }
  return `Move ${props.issueId} to /tmp/danxbot/${props.repo}/issues/. The YAML survives on disk until the OS clears /tmp — no in-dashboard undo.`;
});

function openDialog(): void {
  error.value = null;
  open.value = true;
}

function closeDialog(): void {
  if (busy.value) return;
  open.value = false;
  error.value = null;
}

async function confirm(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await deleteIssue(props.repo, props.issueId);
    open.value = false;
    emit("deleted");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DanxButton
    variant="danger"
    size="sm"
    :icon="trashIcon"
    class="meta-btn"
    tooltip="Delete this card (moves YAML to /tmp)"
    aria-label="Delete card"
    data-test="drawer-delete"
    @click="openDialog"
  />

  <DanxDialog
    :model-value="open"
    :title="`Delete ${issueId}?`"
    :close-button="'Cancel'"
    :confirm-button="busy ? 'Deleting…' : 'Delete'"
    :is-saving="busy"
    :disabled="busy"
    variant="danger"
    persistent
    @close="closeDialog"
    @confirm="confirm"
  >
    <div class="delete-dialog-body" data-test="drawer-delete-dialog-body">
      <p>{{ bodyText }}</p>
      <p
        v-if="error"
        class="delete-dialog-error"
        data-test="drawer-delete-error"
      >{{ error }}</p>
    </div>
  </DanxDialog>
</template>

<style scoped>
.meta-btn {
  --dx-bg: transparent;
  --dx-bg-hover: rgb(51 65 85 / 0.5);
  --dx-border: transparent;
  --dx-border-hover: rgb(99 102 241 / 0.4);
}
.meta-btn:deep(button),
.meta-btn :deep(button) {
  background: transparent;
  border: 1px solid transparent;
  color: #cbd5e1;
}
.meta-btn:hover:deep(button),
.meta-btn:hover :deep(button) {
  background: rgb(51 65 85 / 0.5);
  border-color: rgb(99 102 241 / 0.3);
  color: #f1f5f9;
}
.delete-dialog-body {
  font-size: 14px;
  color: #cbd5e1;
  line-height: 1.5;
}
.delete-dialog-body p {
  margin: 0 0 10px 0;
}
.delete-dialog-body p:last-child {
  margin-bottom: 0;
}
.delete-dialog-error {
  color: #fca5a5;
  font-weight: 500;
}
</style>
