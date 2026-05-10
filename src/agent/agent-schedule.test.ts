import { describe, expect, it } from "vitest";
import { isAgentInSchedule, type ScheduleCheckAgent } from "./agent-schedule.js";
import type { AgentSchedule } from "../settings-file.js";

function emptySchedule(tz: string): AgentSchedule {
  return {
    tz,
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  };
}

function agent(schedule: AgentSchedule, enabled = true): ScheduleCheckAgent {
  return { enabled, schedule };
}

describe("isAgentInSchedule", () => {
  it("returns true when now falls inside the day's window (basic case, US/Central, weekday)", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-17:00"];
    // Mon 2026-04-20 is a Monday. 14:00 CDT = 19:00 UTC.
    const now = new Date("2026-04-20T19:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });

  it("returns false when now is before the window starts", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-17:00"];
    // Mon 2026-04-20 08:59 CDT = 13:59 UTC.
    const now = new Date("2026-04-20T13:59:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("returns false when now matches the window's exclusive end (half-open semantics)", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-17:00"];
    // Exactly 17:00 CDT = 22:00 UTC.
    const now = new Date("2026-04-20T22:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("returns true when now matches the window's inclusive start", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-17:00"];
    // Exactly 09:00 CDT = 14:00 UTC.
    const now = new Date("2026-04-20T14:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });

  it("returns true when now falls inside ANY of multiple windows on the same day", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-12:00", "14:00-17:00"];
    // 15:00 CDT = 20:00 UTC — second window.
    const now = new Date("2026-04-20T20:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });

  it("returns false when now falls in the gap between two windows on the same day", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["09:00-12:00", "14:00-17:00"];
    // 13:00 CDT = 18:00 UTC — between the two windows.
    const now = new Date("2026-04-20T18:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("returns false when the relevant day's window list is empty", () => {
    const sched = emptySchedule("America/Chicago");
    // Mon empty; Tue has windows. Tested on a Mon.
    sched.tue = ["09:00-17:00"];
    const now = new Date("2026-04-20T15:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("returns false when the agent is disabled, regardless of schedule", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["00:00-23:59"];
    const now = new Date("2026-04-20T15:00:00Z");
    expect(isAgentInSchedule(agent(sched, false), now)).toBe(false);
  });

  it("respects per-day windows — checks the right weekday in the local tz", () => {
    const sched = emptySchedule("America/Chicago");
    // Sunday is excluded; Saturday is open.
    sched.sat = ["10:00-18:00"];
    sched.sun = [];
    // Saturday 2026-04-25 14:00 CDT = 19:00 UTC.
    const sat = new Date("2026-04-25T19:00:00Z");
    // Sunday 2026-04-26 14:00 CDT = 19:00 UTC.
    const sun = new Date("2026-04-26T19:00:00Z");
    expect(isAgentInSchedule(agent(sched), sat)).toBe(true);
    expect(isAgentInSchedule(agent(sched), sun)).toBe(false);
  });

  it("DST: US/Eastern fall-back (winter EST), 09:00 local = 14:00 UTC", () => {
    const sched = emptySchedule("America/New_York");
    sched.thu = ["09:00-17:00"];
    // November 2026: EST (UTC-5). Thu 2026-11-19 09:00 EST = 14:00 UTC.
    const winter = new Date("2026-11-19T14:00:00Z");
    expect(isAgentInSchedule(agent(sched), winter)).toBe(true);
    // Same UTC instant in summer would have been 10:00 EDT — also inside, so
    // pick a UTC instant where summer behaviour differs from winter.
    // Sat 2026-08-15 13:30 EDT = 17:30 UTC. Window = 09:00-17:00 EDT.
    sched.sat = ["09:00-17:00"];
    const summer = new Date("2026-08-15T17:30:00Z");
    expect(isAgentInSchedule(agent(sched), summer)).toBe(true);
    // Same window 17:00 EDT = 21:00 UTC — exclusive end, expect false.
    const summerEdge = new Date("2026-08-15T21:00:00Z");
    expect(isAgentInSchedule(agent(sched), summerEdge)).toBe(false);
  });

  it("DST: US/Eastern spring-forward gap (2026-03-08 02:00 → 03:00 EST→EDT) — 02:30 EST does not exist; 03:30 EDT is inside an 03:00-04:00 window", () => {
    const sched = emptySchedule("America/New_York");
    sched.sun = ["03:00-05:00"];
    // 03:30 EDT on the spring-forward day = 07:30 UTC (EDT is UTC-4).
    const now = new Date("2026-03-08T07:30:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });

  it("returns false when tz is empty / falsy (defense in depth)", () => {
    const sched = emptySchedule("");
    sched.mon = ["09:00-17:00"];
    const now = new Date("2026-04-20T15:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("treats malformed window strings as no-match (defense in depth)", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["bogus", "09:00-17:00"];
    // 14:00 CDT = 19:00 UTC — second window matches.
    const now = new Date("2026-04-20T19:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });

  it("zero-duration windows (start === end) match nothing", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["12:00-12:00"];
    // 12:00 CDT = 17:00 UTC.
    const now = new Date("2026-04-20T17:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(false);
  });

  it("wrap-over-midnight windows (start > end) match the start-day half", () => {
    const sched = emptySchedule("America/Chicago");
    sched.mon = ["22:00-04:00"];
    // Mon 2026-04-20 23:00 CDT = Tue 04:00 UTC.
    const now = new Date("2026-04-21T04:00:00Z");
    expect(isAgentInSchedule(agent(sched), now)).toBe(true);
  });
});
