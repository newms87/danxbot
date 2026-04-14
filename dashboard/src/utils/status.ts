const STATUS_CLASSES: Record<string, string> = {
  received: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  routing: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300",
  routed: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  agent_running: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
  queued: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300",
  complete: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  error: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};

const STATUS_LABELS: Record<string, string> = {
  received: "Received",
  routing: "Routing...",
  routed: "Routed",
  agent_running: "Agent...",
  queued: "Queued",
  complete: "Complete",
  error: "Error",
};

const LOG_TYPE_CLASSES: Record<string, string> = {
  system: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  assistant: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  user: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  tool_progress: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300",
  result: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300",
};

export function statusClass(status: string): string {
  return STATUS_CLASSES[status] ?? STATUS_CLASSES.received;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function logTypeBadge(type: string): string {
  return LOG_TYPE_CLASSES[type] ?? LOG_TYPE_CLASSES.system;
}
