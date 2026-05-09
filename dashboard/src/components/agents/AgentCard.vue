<script setup lang="ts">
/**
 * AgentCard — single roster row for the Agents tab. DX-160 Phase 2.
 *
 * Live busy badge is a placeholder grey dot in this phase; real
 * busy state lands in DX-164 (Phase 6). The card is read-only —
 * Edit + Delete affordances emit events the parent handles.
 */
import { computed } from "vue";
import type { AgentRecordWithName } from "../../types";
import AgentAvatar from "./AgentAvatar.vue";

const props = defineProps<{
  agent: AgentRecordWithName;
  repo: string;
}>();
const emit = defineEmits<{
  edit: [AgentRecordWithName];
  delete: [AgentRecordWithName];
}>();

function summarizeSchedule(): string {
  const days: Array<keyof typeof daysMap> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const daysMap = { mon: "M", tue: "T", wed: "W", thu: "T", fri: "F", sat: "S", sun: "S" } as const;
  const active = days
    .filter((d) => props.agent.schedule[d].length > 0)
    .map((d) => daysMap[d]);
  if (active.length === 0) return "Off-hours only";
  return `${active.join("·")} · ${props.agent.schedule.tz}`;
}
const scheduleSummary = computed(summarizeSchedule);
</script>

<template>
  <article
    class="card"
    :data-test="`agent-card-${agent.name}`"
    :data-test-name="agent.name"
  >
    <header class="head">
      <div class="head-left">
        <AgentAvatar
          :repo="repo"
          :name="agent.name"
          :avatar-path="agent.avatar_path"
          :size="48"
        />
        <div>
          <h3 class="name">{{ agent.name }}</h3>
          <span
            class="status-pill"
            :class="agent.enabled ? 'on' : 'off'"
          >{{ agent.enabled ? "enabled" : "disabled" }}</span>
        </div>
      </div>
      <div class="head-right">
        <span
          class="busy-dot"
          title="Live busy badge — wired in Phase 6"
          aria-label="busy state placeholder"
          data-test="agent-busy-placeholder"
        ></span>
      </div>
    </header>
    <div class="caps">
      <span
        v-for="cap in agent.capabilities"
        :key="cap"
        class="cap-chip"
      >{{ cap }}</span>
    </div>
    <div class="schedule">{{ scheduleSummary }}</div>
    <p class="bio">{{ agent.bio }}</p>
    <footer class="actions">
      <button
        type="button"
        class="btn btn-edit"
        :data-test="`agent-edit-${agent.name}`"
        @click="emit('edit', agent)"
      >Edit</button>
      <button
        type="button"
        class="btn btn-delete"
        :data-test="`agent-delete-${agent.name}`"
        @click="emit('delete', agent)"
      >Delete</button>
    </footer>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid #1e293b;
  background: #0f172a;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: #f1f5f9;
}
.status-pill {
  display: inline-block;
  margin-top: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
}
.status-pill.on {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}
.status-pill.off {
  background: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
}
.busy-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #475569;
  display: inline-block;
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.cap-chip {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.12);
  color: #93c5fd;
}
.schedule {
  font-size: 12px;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.bio {
  margin: 0;
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 4.5em;
  overflow: hidden;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}
.btn {
  flex: 1;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #1e293b;
  cursor: pointer;
  font-weight: 500;
}
.btn-edit {
  background: #1e293b;
  color: #e2e8f0;
}
.btn-edit:hover {
  background: #334155;
}
.btn-delete {
  background: transparent;
  color: #f87171;
}
.btn-delete:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: #f87171;
}
</style>
