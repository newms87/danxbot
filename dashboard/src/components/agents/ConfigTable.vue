<script setup lang="ts">
import { ref } from "vue";
import type { SettingsDisplay } from "../../types";

defineProps<{
  display: SettingsDisplay;
}>();

const expanded = ref(false);

function fmt(val: unknown): string {
  if (val === null || val === undefined || val === "") return "—";
  if (typeof val === "boolean") return val ? "yes" : "no";
  return String(val);
}
</script>

<template>
  <div class="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
    <button
      type="button"
      class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      @click="expanded = !expanded"
    >
      {{ expanded ? "▾ Hide config" : "▸ Show masked config" }}
    </button>

    <div v-if="expanded" class="mt-2 text-xs">
      <table class="w-full">
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr v-if="display.worker">
            <td class="py-1 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">worker</td>
            <td class="py-1 font-mono text-gray-900 dark:text-gray-100">
              port {{ fmt(display.worker.port) }} · runtime {{ fmt(display.worker.runtime) }}
            </td>
          </tr>
          <tr v-if="display.slack">
            <td class="py-1 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">slack</td>
            <td class="py-1 font-mono text-gray-900 dark:text-gray-100">
              token {{ fmt(display.slack.botToken) }} · channel {{ fmt(display.slack.channelId) }}
              · configured {{ fmt(display.slack.configured) }}
            </td>
          </tr>
          <tr v-if="display.trello">
            <td class="py-1 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">trello</td>
            <td class="py-1 font-mono text-gray-900 dark:text-gray-100">
              key {{ fmt(display.trello.apiKey) }} · board {{ fmt(display.trello.boardId) }}
              · configured {{ fmt(display.trello.configured) }}
            </td>
          </tr>
          <tr v-if="display.github">
            <td class="py-1 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">github</td>
            <td class="py-1 font-mono text-gray-900 dark:text-gray-100">
              token {{ fmt(display.github.token) }} · configured {{ fmt(display.github.configured) }}
            </td>
          </tr>
          <tr v-if="display.db">
            <td class="py-1 pr-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">db</td>
            <td class="py-1 font-mono text-gray-900 dark:text-gray-100">
              host {{ fmt(display.db.host) }} · database {{ fmt(display.db.database) }}
              · configured {{ fmt(display.db.configured) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!display.worker && !display.slack && !display.trello && !display.github && !display.db" class="text-gray-500 dark:text-gray-400 py-2">
        No masked config available yet. Redeploy or re-run setup to populate.
      </div>
    </div>
  </div>
</template>
