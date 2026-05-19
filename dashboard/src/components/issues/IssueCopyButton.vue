<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DanxButton, copyIcon } from "@thehammer/danx-ui";
import { useTransientStatus } from "../../composables/useTransientStatus";
import { getIssueSubtree } from "../../api";

const props = defineProps<{
  repo: string;
  issueId: string;
}>();

const copy = useTransientStatus<"idle" | "copying" | "copied" | "error">({
  idleMs: 2500,
  idleValue: "idle",
});
const state = copy.status;
const message = ref<string | null>(null);

watch(state, (s) => {
  if (s === "idle") message.value = null;
});

watch(
  () => props.issueId,
  () => {
    copy.clear();
    message.value = null;
  },
);

async function onCopy(): Promise<void> {
  if (state.value === "copying") return;
  copy.set("copying", { autoReset: false });
  message.value = null;
  try {
    const payload = await getIssueSubtree(props.repo, props.issueId);
    const text = JSON.stringify(payload);
    if (!navigator.clipboard?.writeText) {
      throw new Error(
        "Clipboard API not available — open the dashboard over HTTPS or localhost",
      );
    }
    await navigator.clipboard.writeText(text);
    const n = payload.issues.length;
    message.value = `Copied ${n} ${n === 1 ? "card" : "cards"}`;
    copy.set("copied");
  } catch (err) {
    message.value = err instanceof Error ? err.message : String(err);
    copy.set("error");
  }
}

const tooltip = computed(
  () => message.value ?? "Copy this card and all descendants to clipboard",
);
const dataTest = computed(() =>
  state.value === "copied"
    ? "drawer-copy-success"
    : state.value === "error"
      ? "drawer-copy-error"
      : "drawer-copy",
);
</script>

<template>
  <DanxButton
    variant=""
    size="sm"
    :icon="copyIcon"
    class="meta-btn"
    :disabled="state === 'copying'"
    :loading="state === 'copying'"
    :tooltip="tooltip"
    :aria-label="tooltip"
    :data-test="dataTest"
    @click="onCopy"
  />
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
</style>
