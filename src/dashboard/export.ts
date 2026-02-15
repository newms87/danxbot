import type { MessageEvent } from "./events.js";
import { getResponseTimeMs } from "./events.js";

const CSV_HEADER = "timestamp,user,text,status,subscription_cost,api_cost,feedback,response_time_ms";

const CSV_INJECTION_PREFIXES = /^[=+\-@\t\r]/;

function escapeCSVField(value: string): string {
  // Neutralize CSV/formula injection by prepending a single quote
  if (CSV_INJECTION_PREFIXES.test(value)) {
    value = `'${value}`;
  }

  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("'")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function eventsToCSV(events: MessageEvent[]): string {
  const rows = events.map((event) => {
    const timestamp = new Date(event.receivedAt).toISOString();
    const user = event.userName || event.user;
    const text = event.text;
    const status = event.status;
    const subscriptionCost = event.subscriptionCostUsd !== null ? String(event.subscriptionCostUsd) : "";
    const apiCost = event.apiCostUsd !== null ? String(event.apiCostUsd) : "";
    const feedback = event.feedback || "";
    const responseTime = getResponseTimeMs(event);

    return [
      escapeCSVField(timestamp),
      escapeCSVField(user),
      escapeCSVField(text),
      escapeCSVField(status),
      escapeCSVField(subscriptionCost),
      escapeCSVField(apiCost),
      escapeCSVField(feedback),
      escapeCSVField(String(responseTime)),
    ].join(",");
  });

  return [CSV_HEADER, ...rows, ""].join("\n");
}
