import type { MessageEvent } from "./events.js";
import { getResponseTimeMs } from "./events.js";

const CSV_HEADER = "timestamp,user,text,status,cost,feedback,response_time_ms";

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
    const cost = event.agentCostUsd !== null ? String(event.agentCostUsd) : "";
    const feedback = event.feedback || "";
    const responseTime = getResponseTimeMs(event);

    return [
      escapeCSVField(timestamp),
      escapeCSVField(user),
      escapeCSVField(text),
      escapeCSVField(status),
      escapeCSVField(cost),
      escapeCSVField(feedback),
      escapeCSVField(String(responseTime)),
    ].join(",");
  });

  return [CSV_HEADER, ...rows, ""].join("\n");
}
