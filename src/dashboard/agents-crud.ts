// Agent record CRUD (DX-160 Phase 2 + DX-161 Phase 3). POST/PATCH/DELETE on
// /api/agents. `MutateError` + `authAndResolveRepo` are exported so
// `agents-avatar.ts` can reuse the pattern without a circular import.
// Avatar upload + serve live there to keep both modules under the 300-line
// ceiling.
//
// DX-161 Phase 3 wires `WorktreeManager` into POST + DELETE so the agent's
// `<repo>/.danxbot/worktrees/<name>/` lifecycle is owned by the same
// transaction as the settings record. POST bootstraps after the record
// lands and rolls back on bootstrap failure; DELETE tears down BEFORE the
// record is removed so a teardown failure leaves the operator with a
// recoverable state (record still present, retry available).

import type { IncomingMessage, ServerResponse } from "http";
import { rmSync } from "node:fs";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { RepoConfig } from "../types.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import { findNonTerminalDispatches } from "./dispatches-db.js";
import {
  AGENT_NAME_SHAPE,
  AGENTS_MAX,
  DASHBOARD_PREFIX,
  defaultStrikes,
  mutateAgents,
  type AgentRecord,
  type AgentRecordWithName,
} from "../settings-file.js";
import { publishAgentSnapshot } from "./agents-list.js";
import { validateAgentFields } from "./agent-validators.js";
import { agentDir, assertWithinAgentsRoot } from "./agent-fs.js";
import { clearAssignedAgentOnDeletion } from "../poller/heal.js";
import { loadIssuePrefix } from "../issue-tracker/load-issue-prefix.js";

const log = createLogger("agents-crud");

// Bail out of a `mutateAgents` callback with an HTTP status — exception
// rather than return-shape since the callback runs inside the lock.
export class MutateError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const namedRecord = (n: string, r: AgentRecord): AgentRecordWithName =>
  ({ name: n, ...r });

// Auth + repo lookup shared by every mutation route. Returns the repo
// + username on success; null after writing 401/400/404 itself.
export async function authAndResolveRepo(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  deps: DispatchProxyDeps,
): Promise<{ repo: RepoConfig; username: string } | null> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  if (!repoName) {
    json(res, 400, { error: "Missing required query param: repo" });
    return null;
  }
  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return null;
  }
  return { repo, username: auth.user.username };
}

// POST /api/agents?repo=<name>. Body `{name, bio, capabilities[],
// schedule, enabled}`; server stamps `type:"agent"`, `created_at`,
// `updated_at`. Returns 201 / 400 / 409 (5-cap or duplicate name).
export async function handlePostAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const rawName = body.name;
  if (typeof rawName !== "string" || !AGENT_NAME_SHAPE.test(rawName)) {
    json(res, 400, {
      error: `name must match ${AGENT_NAME_SHAPE} (lowercase, starts with letter, ≤32 chars, [a-z0-9_-])`,
    });
    return;
  }
  const name = rawName;

  const validation = validateAgentFields(body, { requireAll: true });
  if ("errors" in validation) {
    json(res, 400, { error: "validation failed", errors: validation.errors });
    return;
  }
  const f = validation.fields;
  if (
    f.bio === undefined ||
    f.capabilities === undefined ||
    f.schedule === undefined ||
    f.enabled === undefined
  ) {
    // requireAll=true guarantees these — guard preserves type narrowing.
    json(res, 400, { error: "validation failed" });
    return;
  }

  const now = new Date().toISOString();
  const record: AgentRecord = {
    type: "agent",
    bio: f.bio,
    capabilities: f.capabilities,
    schedule: f.schedule,
    enabled: f.enabled,
    broken: null,
    // DX-364 — fresh agents start at zero strikes; Phase 2 of DX-363
    // wires the increment hook.
    strikes: defaultStrikes(),
    created_at: now,
    updated_at: now,
  };

  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        if (Object.prototype.hasOwnProperty.call(current, name)) {
          throw new MutateError(409, `agent "${name}" already exists`);
        }
        if (Object.keys(current).length >= AGENTS_MAX) {
          throw new MutateError(
            409,
            `agent limit reached — at most ${AGENTS_MAX} agents per repo`,
          );
        }
        current[name] = record;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(`handlePostAgent(${repo.name}, ${name}): mutateAgents threw`, err);
    json(res, 500, { error: "Failed to persist agent" });
    return;
  }

  // DX-161: bootstrap the agent's worktree at
  // `<repo>/.danxbot/worktrees/<name>/`. Runs AFTER the settings record
  // lands so a bootstrap failure has a record to roll back. On failure
  // we run the full SYMMETRIC inverse — `worktreeManager.teardown` drops
  // any partially-provisioned worktree dir, DB role+db, port-registry
  // offset, and persisted DB password — then delete the settings
  // record. Without the inverse, a mid-bootstrap throw (e.g. DB DNS
  // unreachable from this container) leaves orphan port allocations,
  // worktree dirs, and DB roles for the operator to clean up by hand.
  if (deps.worktreeManager) {
    try {
      await deps.worktreeManager.bootstrap(repo, name);
    } catch (bootErr) {
      const bootMsg = bootErr instanceof Error ? bootErr.message : String(bootErr);
      log.error(
        `handlePostAgent(${repo.name}, ${name}): bootstrap failed — rolling back artifacts + settings record`,
        bootErr,
      );
      // 1) Artifact rollback — teardown is fail-soft (worktree-cleanup
      //    helper logs + swallows individual step failures) so even a
      //    cascading DB-unreachable here won't mask the original boot
      //    error.
      try {
        await deps.worktreeManager.teardown(repo, name);
      } catch (cleanupErr) {
        log.error(
          `handlePostAgent(${repo.name}, ${name}): artifact teardown after failed bootstrap also failed — orphans may remain on disk`,
          cleanupErr,
        );
      }
      // 2) Settings record rollback — the artifact may or may not have
      //    been cleaned, but the settings record MUST go so the operator
      //    can retry POST without 409.
      try {
        await mutateAgents(
          repo.localPath,
          (current) => {
            delete current[name];
            return current;
          },
          `${DASHBOARD_PREFIX}${username}`,
        );
      } catch (rollErr) {
        log.error(
          `handlePostAgent(${repo.name}, ${name}): ROLLBACK FAILED — settings record may be stale`,
          rollErr,
        );
      }
      json(res, 500, {
        error: `Failed to bootstrap worktree for agent "${name}": ${bootMsg}`,
      });
      return;
    }
  }

  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 201, namedRecord(name, record));
}

// PATCH /api/agents/:name?repo=<name>. Partial update; `name` is
// immutable. Any subset of `bio`, `capabilities`, `schedule`, `enabled`
// accepted; missing fields preserve. `avatar_path` is server-managed
// (POST /avatar). Bumps `updated_at`. Returns 200 / 400 / 404.
export async function handlePatchAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    json(res, 400, { error: "name is immutable" });
    return;
  }

  const validation = validateAgentFields(body, { requireAll: false });
  if ("errors" in validation) {
    json(res, 400, { error: "validation failed", errors: validation.errors });
    return;
  }
  const f = validation.fields;

  let saved: AgentRecord | null = null;
  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        const record = current[agentName];
        if (!record) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        // DX-298: `broken: null` clears a worker-stamped broken record
        // ("Mark Resolved" on the dashboard). The validator's literal
        // `broken?: null` typing makes only two states reachable on
        // the parsed result — `null` (clear) and `undefined` (absent /
        // preserve). Non-null populated records were rejected upstream
        // and cannot land here.
        const updated: AgentRecord = {
          ...record,
          bio: f.bio ?? record.bio,
          capabilities: f.capabilities ?? record.capabilities,
          schedule: f.schedule ?? record.schedule,
          enabled: f.enabled ?? record.enabled,
          broken: f.broken === null ? null : record.broken,
          // DX-510 — preserve operator-set level when the patch omits it.
          // Absent on the record (unset → reader serves "medium" default)
          // stays undefined; explicit patch lands the new label.
          ...(f.effortLevel !== undefined
            ? { effortLevel: f.effortLevel }
            : {}),
          updated_at: new Date().toISOString(),
        };
        current[agentName] = updated;
        saved = updated;
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(`handlePatchAgent(${repo.name}, ${agentName}): mutateAgents threw`, err);
    json(res, 500, { error: "Failed to persist agent update" });
    return;
  }
  // mutateAgents either runs the callback (which assigns saved) or throws.
  await publishAgentSnapshot(repo, deps.resolveHost);
  json(res, 200, namedRecord(agentName, saved!));
}

// DELETE /api/agents/:name?repo=<name>. 409 if any non-terminal dispatch
// in the repo (Phase 5 / DX-200 narrows to `assigned_agent === agentName`);
// else drop the record + `rm -rf <repo>/.danxbot/agents/<name>/`
// (best-effort). Worktree teardown is Phase 3. Returns 204.
export async function handleDeleteAgent(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string | null,
  agentName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const ctx = await authAndResolveRepo(req, res, repoName, deps);
  if (!ctx) return;
  const { repo, username } = ctx;

  // Busy check runs OUTSIDE the settings lock — different storage
  // layer. Worktree teardown is Phase 3; the Phase 2 contract here is
  // "remove the record + per-agent dir", which a stale probe doesn't
  // compromise.
  try {
    const active = await findNonTerminalDispatches(repo.name, agentName);
    if (active.length > 0) {
      json(res, 409, {
        error: `agent "${agentName}" is busy — ${active.length} non-terminal dispatch(es) in repo "${repo.name}"`,
      });
      return;
    }
  } catch (err) {
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): busy probe threw`, err);
    json(res, 500, { error: "Failed to probe dispatch state" });
    return;
  }

  // DX-161: tear down the agent's worktree BEFORE removing the settings
  // record. Ordering matters — if teardown fails (locked worktree,
  // disconnected remote, fs permissions) we leave the record present so
  // the operator can retry the DELETE. The worktree is the
  // expensive-to-recover side; the record is the cheap-to-recover side.
  // Skipped entirely when no manager wired (legacy / non-multi-worker).
  if (deps.worktreeManager) {
    try {
      await deps.worktreeManager.teardown(repo, agentName);
    } catch (tearErr) {
      const tearMsg = tearErr instanceof Error ? tearErr.message : String(tearErr);
      log.error(
        `handleDeleteAgent(${repo.name}, ${agentName}): teardown failed — settings record left in place for retry`,
        tearErr,
      );
      json(res, 500, {
        error: `Failed to tear down worktree for agent "${agentName}": ${tearMsg}`,
      });
      return;
    }
  }

  try {
    await mutateAgents(
      repo.localPath,
      (current) => {
        if (!Object.prototype.hasOwnProperty.call(current, agentName)) {
          throw new MutateError(404, `agent "${agentName}" not found`);
        }
        delete current[agentName];
        return current;
      },
      `${DASHBOARD_PREFIX}${username}`,
    );
  } catch (err) {
    if (err instanceof MutateError) {
      json(res, err.status, { error: err.message });
      return;
    }
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): mutateAgents threw`, err);
    json(res, 500, { error: "Failed to persist agent removal" });
    return;
  }

  // Best-effort cleanup — a failure here is logged but does NOT roll
  // back the settings write; a stale `agents/<name>/` directory is
  // gitignored and harmless.
  const dir = agentDir(repo, agentName);
  const escape = assertWithinAgentsRoot(repo, dir);
  if (escape) {
    log.error(`handleDeleteAgent(${repo.name}, ${agentName}): refusing to rm — ${escape}`);
  } else {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`handleDeleteAgent(${repo.name}, ${agentName}): rm ${dir} failed`, err);
    }
  }

  // DX-283 cascade: clear `assigned_agent: <deleted>` from any open
  // YAMLs. Without this the multi-agent picker treats those cards as
  // owned by an offline agent forever — `pickCardForAgent` skips them
  // for every other agent until the next worker boot heal scrubs the
  // claim. The boot heal already exists (DX-281, `healOrphanAssigned-
  // Agents`); this cascade gives the operator the same outcome
  // immediately, no restart required. Idempotent + best-effort: a
  // failure here is logged but does NOT roll back the settings write.
  try {
    // `RepoConfig` (the handler's repo shape) doesn't carry the
    // issue prefix — resolve it from disk via the same loader the
    // worker boot uses. Throws on missing config.yml or invalid
    // prefix shape; both are caught + logged (best-effort cascade).
    const prefix = loadIssuePrefix(repo.localPath);
    const cleared = await clearAssignedAgentOnDeletion(
      repo.localPath,
      prefix,
      agentName,
    );
    if (cleared.healed.length > 0) {
      log.info(
        `handleDeleteAgent(${repo.name}, ${agentName}): cleared assigned_agent on ${cleared.healed.length} card(s): ${cleared.healed.map((h) => h.id).join(", ")}`,
      );
    }
  } catch (err) {
    log.warn(
      `handleDeleteAgent(${repo.name}, ${agentName}): assigned_agent cascade failed — boot heal will catch up on next restart`,
      err,
    );
  }

  await publishAgentSnapshot(repo, deps.resolveHost);
  res.writeHead(204);
  res.end();
}
