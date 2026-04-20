<script setup lang="ts">
import { computed } from "vue";
import type { AgentSnapshot, Feature } from "../../types";
import FeatureToggle from "./FeatureToggle.vue";
import ConfigTable from "./ConfigTable.vue";

const props = defineProps<{
  agent: AgentSnapshot;
  busyFeature: Feature | null;
}>();

defineEmits<{
  toggle: [repo: string, feature: Feature, enabled: boolean | null];
}>();

// The env default each feature falls back to when the override is null.
// For slack, configured === slack.enabled on the backend. For
// trelloPoller, `display.trello.configured` is a good proxy; for
// dispatchApi the default is always true.
const envDefaults = computed<Record<Feature, boolean>>(() => ({
  slack: !!props.agent.settings.display.slack?.configured,
  trelloPoller: !!props.agent.settings.display.trello?.configured,
  dispatchApi: true,
}));

const slackSub = computed(
  () => `${props.agent.counts.total.slack} total / ${props.agent.counts.last24h.slack} last 24h`,
);
const trelloSub = computed(
  () => `${props.agent.counts.total.trello} total / ${props.agent.counts.last24h.trello} last 24h`,
);
const apiSub = computed(
  () => `${props.agent.counts.total.api} total / ${props.agent.counts.last24h.api} last 24h`,
);

const workerPillText = computed(() =>
  props.agent.worker.reachable ? "worker up" : "worker unreachable",
);
const workerPillColor = computed(() =>
  props.agent.worker.reachable
    ? "text-green-600 dark:text-green-400"
    : "text-red-600 dark:text-red-400",
);

const lastSeen = computed(() => {
  const ts = props.agent.worker.lastSeenMs;
  if (!ts) return null;
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  return `${Math.floor(ageMs / 3_600_000)}h ago`;
});

const links = computed(() => props.agent.settings.display.links ?? {});
</script>

<template>
  <article class="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
    <header class="flex items-start justify-between mb-3">
      <div>
        <div class="flex items-center gap-2">
          <span :class="workerPillColor" class="text-lg leading-none">●</span>
          <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ agent.name }}</h3>
          <span class="text-xs font-medium" :class="workerPillColor">
            {{ workerPillText }}
          </span>
        </div>
        <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          <span v-if="lastSeen">last seen {{ lastSeen }}</span>
          <span v-else>no recent heartbeat</span>
          <span class="mx-2">·</span>
          <span>{{ agent.counts.total.total }} dispatches total</span>
          <span class="mx-2">·</span>
          <span>{{ agent.counts.today.total }} today</span>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-wrap justify-end">
        <a
          v-if="links.githubUrl"
          :href="links.githubUrl"
          target="_blank"
          rel="noopener"
          class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          GitHub ↗
        </a>
        <a
          v-if="links.trelloBoardUrl"
          :href="links.trelloBoardUrl"
          target="_blank"
          rel="noopener"
          class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Trello ↗
        </a>
        <a
          v-if="links.slackChannelUrl"
          :href="links.slackChannelUrl"
          target="_blank"
          rel="noopener"
          class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Slack ↗
        </a>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <FeatureToggle
        feature="slack"
        label="Slack"
        :enabled="agent.settings.overrides.slack.enabled"
        :env-default="envDefaults.slack"
        :subline="slackSub"
        :busy="busyFeature === 'slack'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
      <FeatureToggle
        feature="trelloPoller"
        label="Trello poller"
        :enabled="agent.settings.overrides.trelloPoller.enabled"
        :env-default="envDefaults.trelloPoller"
        :subline="trelloSub"
        :busy="busyFeature === 'trelloPoller'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
      <FeatureToggle
        feature="dispatchApi"
        label="Dispatch API"
        :enabled="agent.settings.overrides.dispatchApi.enabled"
        :env-default="envDefaults.dispatchApi"
        :subline="apiSub"
        :busy="busyFeature === 'dispatchApi'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
    </div>

    <ConfigTable :display="agent.settings.display" />
  </article>
</template>
