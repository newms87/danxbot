import type { ServerResponse } from "http";
import { createReadStream } from "node:fs";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import {
  getDispatchById,
  listDispatches,
} from "./dispatches-db.js";
import { parseJsonlFile } from "./jsonl-reader.js";
import type {
  DispatchFilters,
  DispatchStatus,
  TriggerType,
} from "./dispatches.js";
import { resolveJsonlPath } from "./jsonl-path-resolver.js";

const log = createLogger("dispatches-routes");

const VALID_TRIGGERS: readonly TriggerType[] = ["slack", "trello", "api"];
const VALID_STATUSES: readonly DispatchStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
];

function parseFilters(params: URLSearchParams): DispatchFilters {
  const filters: DispatchFilters = {};
  const trigger = params.get("trigger");
  if (trigger && (VALID_TRIGGERS as readonly string[]).includes(trigger)) {
    filters.trigger = trigger as TriggerType;
  }
  const repo = params.get("repo");
  if (repo) filters.repo = repo;
  const status = params.get("status");
  if (status && (VALID_STATUSES as readonly string[]).includes(status)) {
    filters.status = status as DispatchStatus;
  }
  const since = params.get("since");
  if (since !== null) {
    const n = Number(since);
    if (Number.isFinite(n)) filters.since = n;
  }
  const q = params.get("q");
  if (q) filters.q = q;
  return filters;
}

export async function handleListDispatches(
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  try {
    const filters = parseFilters(params);
    const rows = await listDispatches(filters);
    json(res, 200, rows);
  } catch (err) {
    log.error("listDispatches failed", err);
    json(res, 500, { error: "Failed to list dispatches" });
  }
}

export async function handleGetDispatch(
  res: ServerResponse,
  id: string,
): Promise<void> {
  try {
    const dispatch = await getDispatchById(id);
    if (!dispatch) {
      json(res, 404, { error: "Dispatch not found" });
      return;
    }
    let timeline: Awaited<ReturnType<typeof parseJsonlFile>> | null = null;
    const jsonlPath = await resolveJsonlPath(dispatch);
    if (jsonlPath) {
      timeline = await parseJsonlFile(jsonlPath);
    }
    json(res, 200, {
      dispatch,
      timeline: timeline?.blocks ?? [],
      totals: timeline?.totals ?? null,
    });
  } catch (err) {
    log.error(`getDispatch(${id}) failed`, err);
    json(res, 500, { error: "Failed to load dispatch" });
  }
}

export async function handleRawJsonl(
  res: ServerResponse,
  id: string,
): Promise<void> {
  try {
    const dispatch = await getDispatchById(id);
    if (!dispatch) {
      json(res, 404, { error: "Dispatch not found" });
      return;
    }
    // resolveJsonlPath tries the stored path, worker→dashboard translation, and
    // deterministic session-UUID computation; returns null if no file exists.
    const jsonlPath = await resolveJsonlPath(dispatch);
    if (!jsonlPath) {
      const msg = dispatch.jsonlPath || dispatch.sessionUuid
        ? "JSONL file no longer available"
        : "No JSONL recorded for this dispatch";
      json(res, 404, { error: msg });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${id}.jsonl"`,
    });
    createReadStream(jsonlPath)
      .on("error", (err) => {
        log.error(`rawJsonl(${id}) stream error`, err);
        res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    log.error(`rawJsonl(${id}) failed`, err);
    json(res, 500, { error: "Failed to read JSONL" });
  }
}

