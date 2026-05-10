<script setup lang="ts">
/**
 * AgentBadge — DX-164 Phase 6.
 *
 * Compact `<avatar><name>` chip surfaced on issue list rows + drawer
 * headers when an agent has claimed the card (`assigned_agent` set).
 * Reuses `AgentAvatar` for the avatar with-initials-fallback path so
 * the visual treatment matches the Agents-tab roster.
 *
 * `size: "sm"` → 16px avatar + 11px name (issue list row).
 * `size: "md"` → 24px avatar + 13px name (drawer header).
 *
 * Click is opt-in: when the consumer attaches a `@click` listener Vue
 * fires it; otherwise the chip is a static label. The drawer header
 * passes a click handler that routes to the Agents tab via the SPA's
 * existing `?tab=agents` query — the badge itself stays UI-agnostic.
 */
import { computed } from "vue";
import AgentAvatar from "./agents/AgentAvatar.vue";

const props = withDefaults(
  defineProps<{
    repo: string;
    agentName: string;
    avatarPath?: string | undefined;
    size?: "sm" | "md";
  }>(),
  { size: "sm" },
);

const avatarPx = computed(() => (props.size === "md" ? 24 : 16));
</script>

<template>
  <span
    class="agent-badge"
    :class="`size-${size}`"
    :data-test="`agent-badge-${agentName}`"
    :title="`Assigned to ${agentName}`"
  >
    <AgentAvatar
      :repo="repo"
      :name="agentName"
      :avatar-path="avatarPath"
      :size="avatarPx"
    />
    <span class="name">{{ agentName }}</span>
  </span>
</template>

<style scoped>
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 2px;
  border-radius: 999px;
  background: rgb(99 102 241 / 0.1);
  border: 1px solid rgb(99 102 241 / 0.25);
  color: #c7d2fe;
  font-weight: 500;
  font-family: inherit;
  white-space: nowrap;
  cursor: inherit;
}
.agent-badge.size-sm {
  font-size: 10px;
  gap: 4px;
  padding: 1px 6px 1px 2px;
}
.agent-badge.size-md {
  font-size: 12px;
  gap: 6px;
  padding: 2px 10px 2px 3px;
}
.name {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
</style>
