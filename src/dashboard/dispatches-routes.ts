import type { IncomingMessage, ServerResponse } from "http";
import { createReadStream } from "node:fs";
import { readFile, open } from "node:fs/promises";
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
import {
  resolveJsonlPath,
  expectedJsonlPath,
} from "./jsonl-path-resolver.js";

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

const FOLLOW_POLL_MS = 1_000;
// After this many consecutive tick errors (file-not-found while agent starts
// up, or transient DB failures), give up and close the SSE stream to avoid a
// zombie connection that polls forever on a completed dispatch.
const FOLLOW_MAX_CONSECUTIVE_ERRORS = 30;

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
  // Derive the expected path without requiring the file to exist yet — the
  // tick loop will retry until the agent creates it.
  const rawJsonlPath = expectedJsonlPath(dispatch);
  if (!rawJsonlPath) {
    json(res, 404, { error: "No JSONL recorded yet" });
    return;
  }
  // Capture as a non-nullable `const` so the `tick` closure below sees `string`
  // rather than `string | null` (TypeScript doesn't narrow across async closures).
  const jsonlPath: string = rawJsonlPath;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let offset = 0;
  let closed = false;
  let consecutiveErrors = 0;
  req.on("close", () => {
    closed = true;
  });

  async function tick(): Promise<void> {
    if (closed) return;
    try {
      const fh = await open(jsonlPath, "r");
      try {
        const s = await fh.stat();
        if (s.size > offset) {
          const buf = Buffer.alloc(s.size - offset);
          await fh.read(buf, 0, buf.length, offset);
          offset = s.size;
          const { blocks } = parseJsonlContent(buf.toString("utf-8"));
          for (const block of blocks) {
            res.write(`data: ${JSON.stringify(block)}\n\n`);
          }
        }
      } finally {
        await fh.close();
      }

      // Successful tick — reset the error counter.
      consecutiveErrors = 0;

      // If the row is terminal and we've caught up, close the stream.
      const latest = await getDispatchById(id);
      if (latest && latest.status !== "running" && latest.status !== "queued") {
        closed = true;
        res.end();
        return;
      }
    } catch (err) {
      consecutiveErrors++;
      log.warn(`follow(${id}) tick error (${consecutiveErrors}/${FOLLOW_MAX_CONSECUTIVE_ERRORS})`, err);
      if (consecutiveErrors >= FOLLOW_MAX_CONSECUTIVE_ERRORS) {
        log.warn(`follow(${id}) closing stream after ${FOLLOW_MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        closed = true;
        res.end();
        return;
      }
    }
    setTimeout(tick, FOLLOW_POLL_MS);
  }

  // Prime with existing content so new subscribers see history immediately.
  try {
    const existing = await readFile(jsonlPath, "utf-8");
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
