/**
 * Agent record validators shared across DX-160 CRUD handlers.
 *
 * `validateAgentFields` is the strict counterpart to
 * `normalize()` in `settings-file.ts`: the disk loader is forgiving
 * (drops malformed fields silently to keep the worker booting), HTTP
 * intake is strict so the SPA's edit drawer can highlight the bad
 * input. Reused from POST (`requireAll: true`) and PATCH
 * (`requireAll: false`) — keep the shape return + error-list shape so
 * callers can pattern-match without thinking about which path they're on.
 */

import {
  AGENT_CAPABILITIES,
  SCHEDULE_WINDOW_SHAPE,
  isValidIanaTimeZone,
  type AgentCapability,
  type AgentSchedule,
} from "../settings-file.js";

/**
 * Hot-path file `settings.json` is read on every Slack message, every
 * poller tick, and every `/api/launch` (`isFeatureEnabled`). Cap bio
 * length so an oversized bio can't degrade those paths. 4 KB is plenty
 * for a human-readable persona; longer values 400 with a clear error.
 */
export const BIO_MAX_BYTES = 4_000;

export interface AgentValidationFields {
  bio?: string;
  capabilities?: AgentCapability[];
  schedule?: AgentSchedule;
  enabled?: boolean;
}

export function validateAgentFields(
  body: Record<string, unknown>,
  opts: { requireAll: boolean },
): { fields: AgentValidationFields } | { errors: string[] } {
  const errors: string[] = [];
  const fields: AgentValidationFields = {};

  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key);

  // `avatar_path` is reserved for `handlePostAvatar` to stamp server-side.
  // Accepting it from a PATCH/POST body would let a client set a stale
  // path or, worse, point at another agent's file. Defense in depth: the
  // GET handler's `assertWithinAgentsRoot` guard already prevents the
  // serve-side leak, but we want the data on disk to stay clean too.
  if (has("avatar_path")) {
    errors.push("avatar_path is read-only — upload via POST /avatar");
  }

  if (has("bio")) {
    if (typeof body.bio !== "string") errors.push("bio must be a string");
    else if (body.bio.length > BIO_MAX_BYTES)
      errors.push(`bio is too long — max ${BIO_MAX_BYTES} characters`);
    else fields.bio = body.bio;
  } else if (opts.requireAll) {
    errors.push("bio is required");
  }

  if (has("enabled")) {
    if (typeof body.enabled !== "boolean")
      errors.push("enabled must be a boolean");
    else fields.enabled = body.enabled;
  } else if (opts.requireAll) {
    errors.push("enabled is required");
  }

  if (has("capabilities")) {
    const cap = body.capabilities;
    if (!Array.isArray(cap) || cap.length === 0) {
      errors.push("capabilities must be a non-empty array");
    } else {
      const known = new Set<string>(AGENT_CAPABILITIES);
      const filtered: AgentCapability[] = [];
      let bad = false;
      for (const c of cap) {
        if (typeof c !== "string" || !known.has(c)) {
          errors.push(
            `capabilities[*] must each be one of: ${AGENT_CAPABILITIES.join(", ")}`,
          );
          bad = true;
          break;
        }
        filtered.push(c as AgentCapability);
      }
      if (!bad) fields.capabilities = Array.from(new Set(filtered));
    }
  } else if (opts.requireAll) {
    errors.push("capabilities is required");
  }

  if (has("schedule")) {
    const sched = validateScheduleShape(body.schedule);
    if ("error" in sched) errors.push(sched.error);
    else fields.schedule = sched.schedule;
  } else if (opts.requireAll) {
    errors.push("schedule is required");
  }

  if (errors.length > 0) return { errors };
  return { fields };
}

export function validateScheduleShape(
  raw: unknown,
): { schedule: AgentSchedule } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "schedule must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (!isValidIanaTimeZone(r.tz)) {
    return {
      error: `schedule.tz must be a recognized IANA time zone — got ${typeof r.tz === "string" ? `"${r.tz}"` : typeof r.tz}`,
    };
  }
  // DX-247 temp impl: `always_on` is optional in the body; missing/undefined
  // normalizes to `false` for backwards compatibility with pre-DX-247 clients.
  // A non-boolean value is rejected so a typo (e.g. `"true"` string) surfaces
  // loudly instead of silently degrading to `false`.
  let alwaysOn = false;
  if (Object.prototype.hasOwnProperty.call(r, "always_on")) {
    if (typeof r.always_on !== "boolean") {
      return { error: "schedule.always_on must be a boolean" };
    }
    alwaysOn = r.always_on;
  }
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const out: AgentSchedule = {
    tz: r.tz,
    always_on: alwaysOn,
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
  for (const day of days) {
    const v = r[day];
    if (v === undefined) continue;
    if (!Array.isArray(v)) {
      return { error: `schedule.${day} must be an array of HH:MM-HH:MM strings` };
    }
    for (const w of v) {
      if (typeof w !== "string" || !SCHEDULE_WINDOW_SHAPE.test(w)) {
        return {
          error: `schedule.${day} contains an invalid window — each entry must match HH:MM-HH:MM (24h)`,
        };
      }
    }
    out[day] = v as string[];
  }
  return { schedule: out };
}
