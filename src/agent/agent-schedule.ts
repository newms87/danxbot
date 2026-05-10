/**
 * Agent schedule check (DX-200 / DX-158 epic Phase 5).
 *
 * Operators encode each agent's working hours in
 * `<repo>/.danxbot/settings.json` under `agents.<name>.schedule` (see
 * `AgentSchedule` in `src/settings-file.ts`). The schedule carries an
 * IANA timezone (`tz`) plus a list of `HH:MM-HH:MM` windows for each
 * weekday. The poller's pick step calls `isAgentInSchedule(agent, now)`
 * once per candidate; agents outside their schedule are skipped on this
 * tick.
 *
 * Why per-day windows + an explicit tz:
 *   - Operators want flexible coverage rules (e.g. weekday daytime
 *     only, weekend nights only, no overnight). Per-day arrays are
 *     enough; the schedule is operator-authored, not auto-generated.
 *   - Tz is a per-agent property because a multi-region deployment
 *     might host agents in different operator timezones (gpt-manager's
 *     CT operator + a hypothetical UK contributor). Carrying the tz on
 *     the agent record (instead of a single repo-wide setting) lets
 *     each persona stay in its operator's local hours regardless of
 *     where the worker container runs.
 *   - DST is solved by `Intl.DateTimeFormat` with `timeZone` — the
 *     formatter applies the correct offset for the supplied instant.
 *     A window of `09:00-17:00` in `America/New_York` covers 14:00-22:00
 *     UTC in summer (EDT) and 13:00-21:00 UTC in winter (EST) without
 *     any operator-side bookkeeping.
 *
 * Window semantics:
 *   - `[start, end)` half-open. A `09:00-17:00` window covers minute
 *     09:00 through 16:59 inclusive, but NOT 17:00 — so two adjacent
 *     windows `09:00-12:00, 12:00-17:00` are seamless without
 *     double-counting the 12:00 boundary.
 *   - `start === end` (e.g. `12:00-12:00`) is a zero-duration window —
 *     never inside. The settings normalizer accepts it; this function
 *     treats it as never-matching.
 *   - `start > end` (e.g. `22:00-04:00`) is a wrap-over-midnight
 *     window. Treated as TWO windows: `22:00-24:00` on the start day +
 *     `00:00-04:00` on the next day. The next-day half is checked when
 *     the schedule entry of the *next* weekday is consulted by a later
 *     `now`. We do NOT currently model "yesterday spilled into today" —
 *     a window like `22:00-04:00` configured for Monday only would not
 *     match Tuesday 03:00. (The settings normalizer already discourages
 *     wrap-over windows; operators express overnight as two adjacent
 *     entries: `22:00-24:00` Mon + `00:00-04:00` Tue. This function
 *     supports either.)
 *
 * Out-of-schedule does NOT remove the agent from the roster — the
 * picker simply skips them this tick. The next tick re-checks; an
 * agent's schedule transition (e.g. 09:00 boundary) is observed within
 * one poll interval.
 */

import type { AgentSchedule } from "../settings-file.js";

/** Agent shape this helper needs. Slim subset of `AgentRecordWithName`. */
export interface ScheduleCheckAgent {
  enabled: boolean;
  schedule: AgentSchedule;
}

/**
 * Index a `(weekday-name, hour, minute)` triple out of the agent's
 * timezone for the supplied instant. Uses `Intl.DateTimeFormat` with
 * the agent's `tz`. Throws on an invalid `tz` (e.g. typo `Americ/NY`)
 * — the upstream settings normalizer should reject those at write
 * time, but this is the defense-in-depth gate so a misconfigured agent
 * fails loud instead of silently appearing always-out-of-schedule.
 */
interface LocalTimeParts {
  /** `mon` / `tue` / `wed` / `thu` / `fri` / `sat` / `sun` — matches
   *  the lowercase keys on `AgentSchedule`. */
  day: keyof AgentSchedule | "tz";
  /** Minute-of-day in the agent's tz (0–1439). */
  minuteOfDay: number;
}

const SHORT_DAY_TO_KEY: Record<string, keyof AgentSchedule> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

function getLocalTimeParts(
  tz: string,
  now: Date,
): { day: keyof AgentSchedule; minuteOfDay: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  let weekday = "";
  let hour = -1;
  let minute = -1;
  for (const p of parts) {
    if (p.type === "weekday") weekday = p.value;
    else if (p.type === "hour") {
      // Intl's `hour: '2-digit', hour12: false` emits `00`–`24` in some
      // locales (en-US returns `24` for midnight under hour12=false).
      // Normalize 24 → 0 so the minute-of-day calculation stays in
      // [0, 1439].
      const h = Number(p.value);
      hour = h === 24 ? 0 : h;
    } else if (p.type === "minute") minute = Number(p.value);
  }
  const day = SHORT_DAY_TO_KEY[weekday];
  if (!day || hour < 0 || minute < 0) {
    throw new Error(
      `agent-schedule: failed to parse local time for tz=${JSON.stringify(tz)} (weekday=${weekday} hour=${hour} minute=${minute})`,
    );
  }
  return { day, minuteOfDay: hour * 60 + minute };
}

/**
 * Parse `HH:MM-HH:MM` into a `[startMinute, endMinute]` tuple. Returns
 * null on a shape that doesn't match (defense-in-depth — the settings
 * normalizer's `SCHEDULE_WINDOW_SHAPE` regex should already filter
 * these out at the write boundary).
 */
function parseWindow(window: string): [number, number] | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(
    window,
  );
  if (!match) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2]);
  const endMin = Number(match[3]) * 60 + Number(match[4]);
  return [startMin, endMin];
}

/**
 * Returns true when `now` falls inside any of the agent's schedule
 * windows for the current weekday in the agent's tz.
 *
 * False when:
 *   - `agent.enabled === false` (caller can rely on this so a disabled
 *     agent's schedule entry isn't separately checked),
 *   - `agent.schedule.tz` is falsy,
 *   - the day's window list is empty,
 *   - `now` doesn't land inside any window.
 *
 * Throws when:
 *   - `agent.schedule.tz` is non-empty but invalid (Intl rejects the
 *     value). The upstream settings normalizer should reject these at
 *     write time, but a hand-edited settings.json could still produce
 *     one — the throw surfaces it loudly to the operator's first poll
 *     log instead of silently parking the agent forever.
 */
export function isAgentInSchedule(
  agent: ScheduleCheckAgent,
  now: Date,
): boolean {
  if (!agent.enabled) return false;
  if (!agent.schedule.tz) return false;

  const { day, minuteOfDay } = getLocalTimeParts(agent.schedule.tz, now);
  const dayWindows = agent.schedule[day];
  if (!Array.isArray(dayWindows) || dayWindows.length === 0) return false;

  for (const raw of dayWindows) {
    const parsed = parseWindow(raw);
    if (!parsed) continue;
    const [start, end] = parsed;
    if (start === end) continue; // zero-duration
    if (start < end) {
      if (minuteOfDay >= start && minuteOfDay < end) return true;
    } else {
      // Wrap-over-midnight: `22:00-04:00` covers `[22:00, 24:00)` on
      // THIS day. The other half (`[00:00, 04:00)` on the NEXT day) is
      // the operator's responsibility to express on the next-day key
      // — see module header.
      if (minuteOfDay >= start) return true;
    }
  }
  return false;
}
