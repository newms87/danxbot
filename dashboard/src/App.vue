<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { useEvents } from "./composables/useEvents";
import DashboardHeader from "./components/DashboardHeader.vue";
import AnalyticsCards from "./components/AnalyticsCards.vue";
import MessagesTable from "./components/MessagesTable.vue";
import DetailPanel from "./components/DetailPanel.vue";

const {
  events,
  analytics,
  selectedEvent,
  connected,
  searchQuery,
  statusFilter,
  filteredEvents,
  fetchAll,
  selectEvent,
  clearSelection,
  init,
  destroy,
} = useEvents();

onMounted(init);
onUnmounted(destroy);
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 py-6">
    <DashboardHeader
      :connected="connected"
      :event-count="events.length"
      @refresh="fetchAll"
    />

    <AnalyticsCards :analytics="analytics" />

    <MessagesTable
      v-model:search-query="searchQuery"
      v-model:status-filter="statusFilter"
      :filtered-events="filteredEvents"
      :total-count="events.length"
      @select="selectEvent"
    />

    <DetailPanel
      v-if="selectedEvent"
      :event="selectedEvent"
      @close="clearSelection"
    />
  </div>
</template>
