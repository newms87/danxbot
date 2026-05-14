/**
 * DX-510 — lockstep guard between the SPA's redeclared
 * `EFFORT_LEVEL_NAMES` / `DEFAULT_AGENT_EFFORT_LEVEL` constants in
 * `dashboard/src/types.ts` and the backend's source of truth in
 * `src/settings-file.ts`.
 *
 * The SPA can't re-export the backend's runtime values without pulling
 * the entire backend module into the SPA bundle (it carries heavy
 * Node-only imports — fs, http, etc.). The redeclaration is therefore
 * intentional; this test is the lockstep enforcement so the next time
 * an eighth effort label is added on the backend, the build fails here
 * rather than silently mismatching at runtime.
 */
import { describe, it, expect } from "vitest";
import {
  EFFORT_LEVEL_NAMES as SPA_EFFORT_LEVEL_NAMES,
  DEFAULT_AGENT_EFFORT_LEVEL as SPA_DEFAULT_AGENT_EFFORT_LEVEL,
} from "../types";
import {
  EFFORT_LEVEL_NAMES as BACKEND_EFFORT_LEVEL_NAMES,
  DEFAULT_AGENT_EFFORT_LEVEL as BACKEND_DEFAULT_AGENT_EFFORT_LEVEL,
} from "@backend/settings-file.js";

describe("DX-510 — SPA / backend effort-level lockstep", () => {
  it("EFFORT_LEVEL_NAMES match verbatim including order", () => {
    expect([...SPA_EFFORT_LEVEL_NAMES]).toEqual([
      ...BACKEND_EFFORT_LEVEL_NAMES,
    ]);
  });

  it("EFFORT_LEVEL_NAMES has exactly 7 entries on both sides", () => {
    expect(SPA_EFFORT_LEVEL_NAMES).toHaveLength(7);
    expect(BACKEND_EFFORT_LEVEL_NAMES).toHaveLength(7);
  });

  it("DEFAULT_AGENT_EFFORT_LEVEL matches", () => {
    expect(SPA_DEFAULT_AGENT_EFFORT_LEVEL).toBe(
      BACKEND_DEFAULT_AGENT_EFFORT_LEVEL,
    );
  });

  it("the default level is one of the canonical names on both sides", () => {
    expect(SPA_EFFORT_LEVEL_NAMES).toContain(SPA_DEFAULT_AGENT_EFFORT_LEVEL);
    expect(BACKEND_EFFORT_LEVEL_NAMES).toContain(
      BACKEND_DEFAULT_AGENT_EFFORT_LEVEL,
    );
  });
});
