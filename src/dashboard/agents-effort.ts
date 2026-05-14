/**
 * DX-510 — Effort-level settings PATCH route. Operator-facing
 * counterpart to the DX-509 backend schema. Mutates two settings
 * fields:
 *
 *   PATCH /api/agents/:repo/effort-settings → handlePatchEffortSettings
 *
 * Body:
 *   - `effortLevels?: EffortLevelMapping[]` — full 7-row table replace
 *     (atomic, per the DX-509 writer-merge contract — the array is
 *     replaced whole).
 *   - `effortAssignmentPrompt?: string` — operator-tunable prompt the
 *     agent reads when picking a level. `""` is the reset-to-default
 *     affordance (the reader normalizes empty → default on next read).
 *
 * Auth band: per-user bearer (NOT `DANXBOT_DISPATCH_TOKEN`). Mirrors
 * `handlePatchToggle` — `requireUser` returns 401 on missing / wrong
 * token, the handler stamps `meta.updatedBy = dashboard:<username>`
 * via the `writeSettings({writtenBy})` argument. See
 * `.claude/rules/agent-dispatch.md` for the auth-band separation.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import type { DispatchProxyDeps } from "./dispatch-proxy.js";
import { requireUser } from "./auth-middleware.js";
import { countDispatchesByRepo, type RepoDispatchCounts } from "./dispatches-db.js";
import {
  DASHBOARD_PREFIX,
  EFFORT_LEVEL_NAMES,
  writeSettings,
  type EffortLevelMapping,
  type WriteSettingsPatch,
} from "../settings-file.js";
import { eventBus } from "./event-bus.js";
import { buildSnapshot, emptyCounts } from "./agents-list.js";

const log = createLogger("agents-effort");

/**
 * Hot-path cap: `effortAssignmentPrompt` lives in settings.json which is
 * re-read on every Slack route, every poller tick, every `/api/launch`
 * (`isFeatureEnabled`). An unbounded operator paste would degrade those
 * paths. 32 KB is plenty for the built-in default (~1.5 KB) plus
 * operator additions; longer values 400 with a clear error. Pairs with
 * the `BIO_MAX_BYTES = 4 KB` cap in `agent-validators.ts` for the same
 * hot-path reason.
 */
export const EFFORT_PROMPT_MAX_BYTES = 32_000;

interface ValidatedPatch {
  effortLevels?: EffortLevelMapping[];
  effortAssignmentPrompt?: string;
}

/**
 * Strict validator for the patch body. Mirrors the disk loader's
 * `normalizeEffortLevels` shape contract (length 7, canonical order,
 * non-empty `model` + `effort`), but is intentionally NOT forgiving —
 * the dashboard's edit drawer should highlight bad input rather than
 * silently downgrading to defaults on disk. Returns the validated
 * patch on success, or a 400 error string on failure.
 */
function validateEffortPatch(
  body: Record<string, unknown>,
): { patch: ValidatedPatch } | { error: string } {
  const hasLevels = Object.prototype.hasOwnProperty.call(body, "effortLevels");
  const hasPrompt = Object.prototype.hasOwnProperty.call(
    body,
    "effortAssignmentPrompt",
  );

  if (!hasLevels && !hasPrompt) {
    return {
      error:
        "body must include at least one of effortLevels / effortAssignmentPrompt",
    };
  }

  const patch: ValidatedPatch = {};

  if (hasLevels) {
    const raw = body.effortLevels;
    if (!Array.isArray(raw)) {
      return { error: "effortLevels must be an array" };
    }
    if (raw.length !== EFFORT_LEVEL_NAMES.length) {
      return {
        error: `effortLevels must have ${EFFORT_LEVEL_NAMES.length} entries (got ${raw.length})`,
      };
    }
    const levels: EffortLevelMapping[] = [];
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return { error: `effortLevels[${i}] must be an object` };
      }
      const r = row as Record<string, unknown>;
      const expectedName = EFFORT_LEVEL_NAMES[i];
      if (r.name !== expectedName) {
        return {
          error: `effortLevels[${i}].name must be "${expectedName}" (canonical ordering — got ${typeof r.name === "string" ? `"${r.name}"` : typeof r.name})`,
        };
      }
      if (typeof r.model !== "string" || r.model.trim().length === 0) {
        return {
          error: `effortLevels[${i}].model must be a non-empty string`,
        };
      }
      if (typeof r.effort !== "string" || r.effort.trim().length === 0) {
        return {
          error: `effortLevels[${i}].effort must be a non-empty string`,
        };
      }
      levels.push({
        name: expectedName,
        model: r.model,
        effort: r.effort,
      });
    }
    patch.effortLevels = levels;
  }

  if (hasPrompt) {
    const raw = body.effortAssignmentPrompt;
    if (typeof raw !== "string") {
      return { error: "effortAssignmentPrompt must be a string" };
    }
    if (raw.length > EFFORT_PROMPT_MAX_BYTES) {
      return {
        error: `effortAssignmentPrompt is too long — max ${EFFORT_PROMPT_MAX_BYTES} characters`,
      };
    }
    patch.effortAssignmentPrompt = raw;
  }

  return { patch };
}

/**
 * PATCH /api/agents/:repo/effort-settings — user-bearer auth required.
 * Mutates `effortLevels` and/or `effortAssignmentPrompt` on the repo's
 * settings.json. Re-aggregates the repo's `AgentSnapshot` and publishes
 * on the `agent:updated` SSE topic so connected SPAs see the change
 * without polling.
 */
export async function handlePatchEffortSettings(
  req: IncomingMessage,
  res: ServerResponse,
  repoName: string,
  deps: DispatchProxyDeps,
): Promise<void> {
  const auth = await requireUser(req);
  if (!auth.ok) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }

  const repo = deps.repos.find((r) => r.name === repoName);
  if (!repo) {
    json(res, 404, { error: `Repo "${repoName}" is not configured` });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const validated = validateEffortPatch(body);
  if ("error" in validated) {
    json(res, 400, { error: validated.error });
    return;
  }

  try {
    const patch: WriteSettingsPatch = {
      writtenBy: `${DASHBOARD_PREFIX}${auth.user.username}`,
    };
    if (validated.patch.effortLevels !== undefined) {
      patch.effortLevels = validated.patch.effortLevels;
    }
    if (validated.patch.effortAssignmentPrompt !== undefined) {
      patch.effortAssignmentPrompt = validated.patch.effortAssignmentPrompt;
    }
    await writeSettings(repo.localPath, patch);

    const countsByRepo = await countDispatchesByRepo().catch((err) => {
      log.warn(
        `Failed to query dispatch counts post-effort-settings PATCH for ${repoName}`,
        err,
      );
      return {} as Record<string, RepoDispatchCounts>;
    });
    const snapshot = await buildSnapshot(
      repo,
      countsByRepo[repo.name] ?? emptyCounts(),
      deps.resolveHost,
    );
    eventBus.publish({ topic: "agent:updated", data: snapshot });
    json(res, 200, snapshot);
  } catch (err) {
    log.error(`handlePatchEffortSettings(${repoName}) failed`, err);
    json(res, 500, {
      error:
        err instanceof Error
          ? err.message
          : "Failed to update effort settings",
    });
  }
}
