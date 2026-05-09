<script setup lang="ts">
/**
 * AgentAvatar — DX-160 Phase 2.
 *
 * Renders the agent's avatar via authed fetch (`fetchAgentAvatarUrl`)
 * with an initials fallback when no `avatar_path` is set or the
 * fetch returns 404. Uses a `blob:` URL so the bytes flow through
 * the same `Authorization: Bearer ...` header the rest of the
 * dashboard fetches use.
 *
 * The blob URL is revoked on unmount to free memory; an extra
 * watch handles the case where the parent swaps to a different
 * agent without unmounting (e.g. flipping between roster cards).
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { fetchAgentAvatarUrl } from "../../api";

const props = defineProps<{
  repo: string;
  name: string;
  avatarPath?: string | undefined;
  size?: number;
}>();

const SIZE = computed(() => props.size ?? 40);
const initials = computed(() =>
  props.name.length > 0
    ? props.name.slice(0, Math.min(2, props.name.length)).toUpperCase()
    : "?",
);

const url = ref<string | null>(null);
let currentUrl: string | null = null;

function revoke(): void {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

async function load(): Promise<void> {
  revoke();
  url.value = null;
  if (!props.avatarPath) return;
  try {
    const fresh = await fetchAgentAvatarUrl(props.repo, props.name);
    if (fresh) {
      currentUrl = fresh;
      url.value = fresh;
    }
  } catch {
    // Non-blocking — fall back to initials.
    url.value = null;
  }
}

watch(
  () => [props.repo, props.name, props.avatarPath].join("|"),
  () => {
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(revoke);
</script>

<template>
  <div
    class="avatar"
    :style="{ width: `${SIZE}px`, height: `${SIZE}px`, fontSize: `${SIZE / 2.5}px` }"
    :data-test="`agent-avatar-${name}`"
  >
    <img v-if="url" :src="url" :alt="`${name} avatar`" />
    <span v-else class="initials">{{ initials }}</span>
  </div>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  background: #1e293b;
  color: #cbd5e1;
  font-weight: 600;
  flex-shrink: 0;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.initials {
  user-select: none;
}
</style>
