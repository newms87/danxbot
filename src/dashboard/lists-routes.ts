/**
 * DX-583 — Dashboard REST surface for the per-repo list taxonomy.
 *
 * Routes:
 *   GET    /api/lists?repo=<name>             — full ordered array
 *   POST   /api/lists?repo=<name>             — create
 *   PATCH  /api/lists/:id?repo=<name>         — rename / promote / reorder
 *   DELETE /api/lists/:id?repo=<name>         — refuses last-of-type;
 *                                                otherwise reassigns
 *                                                affected cards'
 *                                                `list_name` to the
 *                                                type's default
 *
 * Every route is auth-gated by the operator bearer (handler-level
 * `requireUser`) — same band as the issue write surface. Successful
 * writes publish the `lists:updated` SSE topic; the SPA's reducer
 * projects the payload to its in-memory list without a refetch.
 *
 * The `DELETE` route's reassignment scans the repo's
 * `.danxbot/issues/{open,closed}/*.yml` and updates each YAML whose
 * top-level `list_name` matches the deleted list's name to the
 * reassignTo list's name. The scan uses raw YAML parse/stringify (not
 * the typed `parseIssue` / `serializeIssue`) so it stays Phase-1-
 * agnostic — `list_name` lands on the typed `Issue` interface in
 * DX-581, but this code only touches the field through the bare
 * YAML object and skips files that don't carry it. Once Phase 1
 * ships, the field is present on every YAML the loader migrates,
 * and this code reassigns it correctly without further changes.
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { requireUser } from "./auth-middleware.js";
import { eventBus } from "./event-bus.js";
import {
  ListsValidationError,
  applyCreateList,
  applyDeleteList,
  applyUpdateList,
  readLists,
  writeLists,
  type CreateListInput,
  type ListType,
  type ListsFile,
  type UpdateListInput,
} from "../lists-file.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";

const log = createLogger("lists-routes");

function resolveRepo(
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): { name: string; localPath: string } | null {
  if (!repoQuery) {
    json(res, 400, { error: "Missing required query param: repo" });
    return null;
  }
  const match = deps.repos.find((r) => r.name === repoQuery);
  if (!match) {
    json(res, 404, { error: `Repo "${repoQuery}" is not configured` });
    return null;
  }
  return { name: match.name, localPath: match.localPath };
}

async function requireAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

function publishUpdate(repoName: string, file: ListsFile): void {
  eventBus.publish({
    topic: "lists:updated",
    data: { repoName, file },
  });
}

export async function handleListLists(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  const file = readLists(repo.localPath);
  json(res, 200, { file });
}

export async function handleCreateList(
  req: IncomingMessage,
  res: ServerResponse,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  let input: CreateListInput;
  try {
    input = parseCreateInput(body);
  } catch (err) {
    if (err instanceof ListsValidationError) {
      json(res, 400, { errors: err.errors });
      return;
    }
    throw err;
  }
  try {
    const current = readLists(repo.localPath);
    const { file: next, created } = applyCreateList(current, input);
    const written = await writeLists(repo.localPath, next);
    publishUpdate(repo.name, written);
    json(res, 201, { list: created, file: written });
  } catch (err) {
    if (err instanceof ListsValidationError) {
      json(res, 400, { errors: err.errors });
      return;
    }
    log.error(`handleCreateList(${repo.name}) failed`, err);
    json(res, 500, { error: err instanceof Error ? err.message : "Create failed" });
  }
}

export async function handleUpdateList(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }
  let patch: UpdateListInput;
  try {
    patch = parseUpdateInput(body);
  } catch (err) {
    if (err instanceof ListsValidationError) {
      json(res, 400, { errors: err.errors });
      return;
    }
    throw err;
  }
  try {
    const current = readLists(repo.localPath);
    const next = applyUpdateList(current, id, patch);
    const written = await writeLists(repo.localPath, next);
    publishUpdate(repo.name, written);
    const updated = written.lists.find((l) => l.id === id);
    json(res, 200, { list: updated, file: written });
  } catch (err) {
    if (err instanceof ListsValidationError) {
      const isNotFound = err.errors.some((e) => /No list with id/.test(e));
      json(res, isNotFound ? 404 : 400, { errors: err.errors });
      return;
    }
    log.error(`handleUpdateList(${repo.name}, ${id}) failed`, err);
    json(res, 500, { error: err instanceof Error ? err.message : "Update failed" });
  }
}

export async function handleDeleteList(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  repoQuery: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  if (!(await requireAuth(req, res))) return;
  const repo = resolveRepo(res, repoQuery, deps);
  if (!repo) return;
  try {
    const current = readLists(repo.localPath);
    const result = applyDeleteList(current, id);
    // Reassign affected cards BEFORE writing the taxonomy. The
    // alternative order (write taxonomy first, then reassign) leaves
    // a divergence window: if the per-file YAML rewrite throws
    // partway (disk full, EPERM), cards still carry the dead
    // `list_name` while the taxonomy no longer contains it. Reordering
    // is safe — over-reassign (taxonomy still carries the soon-to-be-
    // deleted list while cards have already moved to its default
    // sibling) is benign because `list_name` is a free-form display
    // pointer, not a referential-integrity gate. SSE publishes only
    // after both steps succeed.
    const reassignedCount = reassignCardsByListName(
      repo.localPath,
      result.deleted.name,
      result.reassignTo.name,
    );
    const written = await writeLists(repo.localPath, result.file);
    publishUpdate(repo.name, written);
    json(res, 200, {
      deleted: result.deleted,
      reassignTo: result.reassignTo,
      reassignedCount,
      file: written,
    });
  } catch (err) {
    if (err instanceof ListsValidationError) {
      const isLastOfType = err.errors.some((e) => /last list of type/.test(e));
      const isNotFound = err.errors.some((e) => /No list with id/.test(e));
      const status = isNotFound ? 404 : isLastOfType ? 409 : 400;
      json(res, status, { errors: err.errors });
      return;
    }
    log.error(`handleDeleteList(${repo.name}, ${id}) failed`, err);
    json(res, 500, { error: err instanceof Error ? err.message : "Delete failed" });
  }
}

/**
 * Scan `<repoLocalPath>/.danxbot/issues/{open,closed}/*.yml` and rewrite
 * every file whose top-level `list_name` equals `fromName` to use
 * `toName`. Atomic per-file (temp + rename). Returns the count of
 * files updated.
 *
 * Phase-1-agnostic: parses each YAML as a raw object; only touches the
 * top-level `list_name` key. Files without the key are skipped (no
 * `list_name` on disk yet = nothing to reassign). Other top-level
 * fields are preserved verbatim by re-stringifying the parsed object.
 */
function reassignCardsByListName(
  repoLocalPath: string,
  fromName: string,
  toName: string,
): number {
  let updated = 0;
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(repoLocalPath, ".danxbot", "issues", state);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
    for (const filename of files) {
      const path = resolve(dir, filename);
      try {
        const raw = readFileSync(path, "utf-8");
        const parsed = parseYaml(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (parsed.list_name !== fromName) continue;
        parsed.list_name = toName;
        writeYamlAtomic(path, stringifyYaml(parsed, { lineWidth: 0 }));
        updated++;
      } catch (err) {
        log.warn(`reassignCards: skipped ${path} (parse/write failed)`, err);
      }
    }
  }
  return updated;
}

function writeYamlAtomic(targetPath: string, body: string): void {
  // Tmp suffix lives in the SAME directory as the destination so
  // `renameSync` is atomic on every supported fs (`rename(2)`).
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, body, "utf-8");
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function parseCreateInput(body: Record<string, unknown>): CreateListInput {
  const errors: string[] = [];
  const out: Partial<CreateListInput> = {};
  if (typeof body.name !== "string" || body.name.length === 0) {
    errors.push("name must be a non-empty string");
  } else {
    out.name = body.name;
  }
  if (typeof body.type !== "string") {
    errors.push("type is required");
  } else {
    out.type = body.type as ListType;
  }
  if ("order" in body && body.order !== undefined) {
    if (typeof body.order !== "number" || !Number.isFinite(body.order)) {
      errors.push("order must be a finite number");
    } else {
      out.order = body.order;
    }
  }
  if ("is_default_for_type" in body && body.is_default_for_type !== undefined) {
    if (typeof body.is_default_for_type !== "boolean") {
      errors.push("is_default_for_type must be a boolean");
    } else {
      out.is_default_for_type = body.is_default_for_type;
    }
  }
  if ("color" in body && body.color !== undefined) {
    if (typeof body.color !== "string") {
      errors.push("color must be a string");
    } else {
      out.color = body.color;
    }
  }
  if (errors.length > 0) throw new ListsValidationError(errors);
  return out as CreateListInput;
}

function parseUpdateInput(body: Record<string, unknown>): UpdateListInput {
  // `type` is intentionally not patchable — see UpdateListInput in
  // lists-file.ts for rationale.
  const ALLOWED = new Set(["name", "order", "is_default_for_type", "color"]);
  const errors: string[] = [];
  for (const k of Object.keys(body)) {
    if (!ALLOWED.has(k)) errors.push(`Field not patchable: ${k}`);
  }
  if (Object.keys(body).length === 0) errors.push("Empty patch");
  const out: UpdateListInput = {};
  if ("name" in body) {
    if (typeof body.name !== "string" || body.name.length === 0) {
      errors.push("name must be a non-empty string");
    } else {
      out.name = body.name;
    }
  }
  if ("order" in body) {
    if (typeof body.order !== "number" || !Number.isFinite(body.order)) {
      errors.push("order must be a finite number");
    } else {
      out.order = body.order;
    }
  }
  if ("is_default_for_type" in body) {
    if (typeof body.is_default_for_type !== "boolean") {
      errors.push("is_default_for_type must be a boolean");
    } else {
      out.is_default_for_type = body.is_default_for_type;
    }
  }
  if ("color" in body) {
    if (typeof body.color !== "string") {
      errors.push("color must be a string");
    } else {
      out.color = body.color;
    }
  }
  if (errors.length > 0) throw new ListsValidationError(errors);
  return out;
}
