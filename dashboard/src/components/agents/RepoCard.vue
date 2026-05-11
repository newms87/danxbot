<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentSnapshot, Feature } from "../../types";
import FeatureToggle from "./FeatureToggle.vue";
import ConfigTable from "./ConfigTable.vue";
import CriticalFailureBanner from "./CriticalFailureBanner.vue";

const props = defineProps<{
  agent: AgentSnapshot;
  busyFeature: Feature | null;
  clearingCriticalFailure?: boolean;
  savingIssuePrefix?: boolean;
}>();

const emit = defineEmits<{
  toggle: [repo: string, feature: Feature, enabled: boolean | null];
  clearCriticalFailure: [repo: string];
  saveIssuePrefix: [repo: string, prefix: string];
}>();

// DX-103: per-repo issue prefix editor. Local-state input; live regex
// validation against ISSUE_PREFIX_SHAPE (2-4 uppercase ASCII letters);
// Save button enabled only when dirty + valid.
const ISSUE_PREFIX_REGEX = /^[A-Z]{2,4}$/;
const prefixInput = ref<string>(props.agent.issuePrefix ?? "");
watch(
  () => props.agent.issuePrefix,
  (next) => {
    prefixInput.value = next ?? "";
  },
);
const prefixDirty = computed(
  () => prefixInput.value !== (props.agent.issuePrefix ?? ""),
);
const prefixValid = computed(() => ISSUE_PREFIX_REGEX.test(prefixInput.value));
const prefixSaveDisabled = computed(
  () => !prefixDirty.value || !prefixValid.value || !!props.savingIssuePrefix,
);
function onSavePrefix(): void {
  if (prefixSaveDisabled.value) return;
  emit("saveIssuePrefix", props.agent.name, prefixInput.value);
}

// The env default each feature falls back to when the override is null.
// For slack, configured === slack.enabled on the backend. For
// issuePoller, `display.trello.configured` is a good proxy; for
// dispatchApi the default is always true; for ideator and autoTriage
// the default is false (explicit opt-in — see
// `src/settings-file.ts#envDefault`).
const envDefaults = computed<Record<Feature, boolean>>(() => ({
  slack: !!props.agent.settings.display.slack?.configured,
  issuePoller: !!props.agent.settings.display.trello?.configured,
  dispatchApi: true,
  ideator: false,
  autoTriage: false,
  // DX-302 — `trelloSync`'s env default mirrors `issuePoller`'s proxy:
  // when Trello creds are present the worker registers a Trello tracker
  // and inbound + outbound sync run by default. Operators flip the
  // explicit override to disable both directions without rotating env.
  trelloSync: !!props.agent.settings.display.trello?.configured,
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

    <CriticalFailureBanner
      v-if="agent.criticalFailure"
      :flag="agent.criticalFailure"
      :repo-name="agent.name"
      :busy="clearingCriticalFailure"
      @clear="(r) => $emit('clearCriticalFailure', r)"
    />

    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
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
        feature="issuePoller"
        label="Issue poller"
        :enabled="agent.settings.overrides.issuePoller.enabled"
        :env-default="envDefaults.issuePoller"
        :subline="trelloSub"
        :busy="busyFeature === 'issuePoller'"
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
      <FeatureToggle
        feature="ideator"
        label="Ideator"
        :enabled="agent.settings.overrides.ideator.enabled"
        :env-default="envDefaults.ideator"
        subline="generates feature cards when Review is short"
        :busy="busyFeature === 'ideator'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
      <FeatureToggle
        feature="autoTriage"
        label="Auto-triage"
        :enabled="agent.settings.overrides.autoTriage.enabled"
        :env-default="envDefaults.autoTriage"
        subline="triages Action Items + Review when ToDo is empty"
        :busy="busyFeature === 'autoTriage'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
      <FeatureToggle
        feature="trelloSync"
        label="Trello sync"
        :enabled="agent.settings.overrides.trelloSync.enabled"
        :env-default="envDefaults.trelloSync"
        subline="inbound + outbound Trello calls"
        :busy="busyFeature === 'trelloSync'"
        @change="(f, e) => $emit('toggle', agent.name, f, e)"
      />
    </div>

    <div class="mt-4 flex items-end gap-3 flex-wrap rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <div class="flex flex-col">
        <label
          :for="`issue-prefix-${agent.name}`"
          class="text-xs font-medium text-gray-700 dark:text-gray-300"
        >
          Issue prefix
        </label>
        <input
          :id="`issue-prefix-${agent.name}`"
          v-model="prefixInput"
          type="text"
          maxlength="4"
          pattern="[A-Z]{2,4}"
          autocomplete="off"
          spellcheck="false"
          class="mt-1 w-24 rounded-md border bg-white dark:bg-gray-900 dark:text-gray-100 px-2 py-1 text-sm font-mono uppercase tracking-wider"
          :class="
            prefixDirty && !prefixValid
              ? 'border-red-500 dark:border-red-500'
              : 'border-gray-300 dark:border-gray-600'
          "
          :disabled="!!savingIssuePrefix"
        />
        <span class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          2-4 uppercase letters
        </span>
      </div>
      <button
        type="button"
        class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="prefixSaveDisabled"
        @click="onSavePrefix"
      >
        {{ savingIssuePrefix ? "Saving…" : "Save prefix" }}
      </button>
      <span
        v-if="prefixDirty && !prefixValid"
        class="text-xs text-red-600 dark:text-red-400"
      >
        Invalid — must be 2-4 uppercase letters.
      </span>
      <span
        v-else-if="!agent.issuePrefix"
        class="text-xs text-amber-600 dark:text-amber-400"
      >
        No issue_prefix configured — set one to enable issue tracking.
      </span>
    </div>

    <ConfigTable :display="agent.settings.display" />
  </article>
</template>
