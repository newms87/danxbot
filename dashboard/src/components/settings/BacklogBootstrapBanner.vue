<script setup lang="ts">
/**
 * DX-620 (Phase 9c of DX-575) — One-click banner that materializes a
 * Trello "Backlog" list on the operator's board when the danxbot
 * archived-type default list is unmapped. Shows above the
 * TrelloListMapping panel on the per-repo Settings tab.
 *
 * Visibility predicate (every condition must hold):
 *  - `useTrelloListMapping` returned a non-null mapping.
 *  - `board_configured === true` — the repo has a Trello board id in
 *    `trello.yml`. (The TrelloListMapping panel itself hides on the
 *    same flag; the banner mirrors that gate so a board-less repo
 *    never sees Trello-shaped UI.)
 *  - An archived-type default list exists in `lists.yaml`.
 *  - `map.list_id_to_trello_list_id[archivedId]` is empty / absent
 *    (the operator has not yet paired the archived list with a Trello
 *    list).
 *
 * After a successful POST the SSE `trello-list-map:updated` topic
 * carries the new map; the visibility predicate flips to false and
 * the banner self-hides without an explicit dismiss action.
 *
 * Per `.claude/rules/dashboard.md`: DanxUI primitives, no raw HTML
 * tooltips, no `setInterval`. The banner has no polling — every
 * update arrives through the SSE bus the two composables already
 * subscribe to.
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { DanxButton } from "@thehammer/danx-ui";
import {
  bootstrapBacklogTrelloList,
  type BootstrapBacklogResponse,
} from "../../api";
import { useListColors } from "../../composables/useListColors";
import { useTrelloListMapping } from "../../composables/useTrelloListMapping";

const props = defineProps<{
  repo: string;
}>();

const {
  lists: danxbotLists,
  init: initLists,
  destroy: destroyLists,
} = useListColors(props.repo);

const {
  mapping,
  init: initMapping,
  destroy: destroyMapping,
  refresh: refreshMapping,
} = useTrelloListMapping(props.repo);

onMounted(() => {
  initLists();
  initMapping();
});

onBeforeUnmount(() => {
  destroyLists();
  destroyMapping();
});

// Re-key wire state on repo switch (defense-in-depth — parent uses :key).
watch(
  () => props.repo,
  (next, prev) => {
    if (next === prev) return;
    destroyLists();
    destroyMapping();
    initLists();
    initMapping();
  },
);

interface ArchivedListShape {
  id: string;
  name: string;
}

const archived = computed<ArchivedListShape | null>(() => {
  const match = danxbotLists.value.find(
    (l) => l.type === "archived" && l.is_default_for_type,
  );
  return match ? { id: match.id, name: match.name } : null;
});

const isUnmapped = computed<boolean>(() => {
  if (!mapping.value || mapping.value.board_configured !== true) return false;
  if (!archived.value) return false;
  const existing = mapping.value.map.list_id_to_trello_list_id[archived.value.id];
  return typeof existing !== "string" || existing.length === 0;
});

const busy = ref<boolean>(false);
const errorMessage = ref<string | null>(null);
const conflict = ref<{ trello_list_name: string; message: string } | null>(null);

const showBanner = computed<boolean>(() => {
  // Keep the banner mounted while a name-conflict message is active so
  // the operator can read it even after the predicate would otherwise
  // hide the row.
  return isUnmapped.value || conflict.value !== null;
});

async function onBootstrap(): Promise<void> {
  if (busy.value || !archived.value) return;
  busy.value = true;
  errorMessage.value = null;
  conflict.value = null;
  try {
    const result: BootstrapBacklogResponse = await bootstrapBacklogTrelloList(
      props.repo,
    );
    if (result.status === "name-conflict") {
      conflict.value = {
        trello_list_name: result.trello_list_name,
        message: result.message,
      };
      return;
    }
    // For `created` and `already-mapped`, refresh the mapping so badges
    // + dropdowns reconcile to the new state immediately (the SSE event
    // updates `map` but `classification` is server-computed — refresh
    // pulls a fresh snapshot). Same tab also avoids an SSE round-trip.
    await refreshMapping();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function dismissConflict(): void {
  conflict.value = null;
}
</script>

<template>
  <section
    v-if="showBanner"
    class="rounded-md border border-amber-400 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-600 p-4 text-sm text-amber-900 dark:text-amber-200"
    data-test="backlog-bootstrap-banner"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex-1 min-w-[260px]">
        <h4 class="font-semibold mb-1">
          Backlog list is unmapped
        </h4>
        <p class="text-xs leading-relaxed">
          The danxbot
          <span class="font-mono">{{ archived?.name ?? "Backlog" }}</span>
          list has no paired Trello list on this board. Cards parked
          here will be skipped at outbound push time until you pair it.
          Click below to create a matching Trello list with one shot;
          you can also pair an existing list via the dropdown row in
          the table.
        </p>
        <p
          v-if="errorMessage"
          class="mt-2 text-xs text-red-700 dark:text-red-300"
          data-test="backlog-bootstrap-error"
        >
          {{ errorMessage }}
        </p>
        <div
          v-if="conflict"
          class="mt-2 rounded-md border border-amber-500 bg-amber-100/60 dark:bg-amber-900/40 p-2 text-xs flex items-start justify-between gap-2"
          data-test="backlog-bootstrap-conflict"
        >
          <span>{{ conflict.message }}</span>
          <DanxButton
            variant="warning"
            size="xs"
            class="bg-transparent border-0"
            aria-label="Dismiss"
            data-test="backlog-bootstrap-conflict-dismiss"
            @click="dismissConflict"
          >
            ✕
          </DanxButton>
        </div>
      </div>
      <DanxButton
        :disabled="busy || !archived"
        :is-saving="busy"
        data-test="backlog-bootstrap-cta"
        @click="onBootstrap"
      >
        Create Backlog list on Trello board
      </DanxButton>
    </div>
  </section>
</template>
