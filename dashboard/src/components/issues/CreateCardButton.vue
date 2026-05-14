<script setup lang="ts">
/**
 * DX-350 — Create Card button. Lives in the Issues tab's FilterToolbar
 * row. Click opens `CreateCardDialog`. Disabled when no repo is selected
 * (the dialog needs a repo to POST against).
 */
import { ref } from "vue";
import CreateCardDialog from "./CreateCardDialog.vue";

const props = defineProps<{
  /** Repo to scope the create against. Empty string disables the button. */
  repo: string;
}>();

const emit = defineEmits<{
  /** Fired with the new id after a successful create — IssuesPage opens the drawer. */
  created: [issueId: string];
}>();

const dialogOpen = ref<boolean>(false);

function onClick(): void {
  if (!props.repo) return;
  dialogOpen.value = true;
}

function onCreated(issueId: string): void {
  emit("created", issueId);
}
</script>

<template>
  <button
    type="button"
    class="create-btn"
    :disabled="!repo"
    data-test="create-card-button"
    @click="onClick"
  >
    <span class="plus">+</span>
    <span>Create Card</span>
  </button>

  <CreateCardDialog
    v-model="dialogOpen"
    :repo="repo"
    @created="onCreated"
  />
</template>

<style scoped>
.create-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  background: rgb(99 102 241 / 0.18);
  color: #c7d2fe;
  border: 1px solid rgb(99 102 241 / 0.35);
  cursor: pointer;
  font-family: inherit;
  transition: background 120ms, border-color 120ms;
}
.create-btn:hover:not(:disabled) {
  background: rgb(99 102 241 / 0.3);
  border-color: rgb(99 102 241 / 0.55);
}
.create-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.plus {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
</style>
