import type { IncomingMessage, ServerResponse } from "http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createLogger } from "../logger.js";
import { json } from "../http/helpers.js";
import {
  getDispatchById,
  listDispatches,
} from "./dispatches-db.js";
import { parseJsonlFile, parseJsonlContent } from "./jsonl-reader.js";
import type {
  DispatchFilters,
  DispatchStatus,
  TriggerType,
} from "./dispatches.js";
import { readFile, open } from "node:fs/promises";

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
    if (dispatch.jsonlPath) {
      timeline = await parseJsonlFile(dispatch.jsonlPath);
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
    if (!dispatch.jsonlPath) {
      json(res, 404, { error: "No JSONL recorded for this dispatch" });
      return;
    }
    // Validate that the file exists before streaming, so we can return 404
    // instead of crashing the response with an ENOENT mid-stream.
    try {
      await stat(dispatch.jsonlPath);
    } catch {
      json(res, 404, { error: "JSONL file no longer available" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${id}.jsonl"`,
    });
    createReadStream(dispatch.jsonlPath).pipe(res);
  } catch (err) {
    log.error(`rawJsonl(${id}) failed`, err);
    json(res, 500, { error: "Failed to read JSONL" });
  }
}

const FOLLOW_POLL_MS = 1_000;

/**
 * Tail the dispatch's JSONL file, emitting newly-appended blocks as SSE.
 * Closes when the underlying dispatch reaches a terminal status.
 */
export async function handleFollowDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const dispatch = await getDispatchById(id);
  if (!dispatch) {
    json(res, 404, { error: "Dispatch not found" });
    return;
  }
  if (!dispatch.jsonlPath) {
    json(res, 404, { error: "No JSONL recorded yet" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let offset = 0;
  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  async function tick(): Promise<void> {
    if (closed) return;
    try {
      const fh = await open(dispatch!.jsonlPath!, "r");
      const s = await fh.stat();
      if (s.size > offset) {
        const buf = Buffer.alloc(s.size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = s.size;
        await fh.close();
        const { blocks } = parseJsonlContent(buf.toString("utf-8"));
        for (const block of blocks) {
          res.write(`data: ${JSON.stringify(block)}\n\n`);
        }
      } else {
        await fh.close();
      }

      // If the row is terminal and we've caught up, close the stream.
      const latest = await getDispatchById(id);
      if (latest && latest.status !== "running" && latest.status !== "queued") {
        res.end();
        return;
      }
    } catch (err) {
      log.warn(`follow(${id}) tick error`, err);
    }
    setTimeout(tick, FOLLOW_POLL_MS);
  }

  // Prime with existing content so new subscribers see history immediately.
  try {
    const existing = await readFile(dispatch.jsonlPath, "utf-8");
    const { blocks } = parseJsonlContent(existing);
    for (const block of blocks) {
      res.write(`data: ${JSON.stringify(block)}\n\n`);
    }
    offset = Buffer.byteLength(existing, "utf-8");
  } catch {
    // File may not exist yet if the watcher hasn't attached — tick will retry.
  }

  tick();
}
