import { describe, it, expect } from "vitest";
import { classifySpawnError } from "./core.js";

/**
 * DX-562 — the spawn-time error classifier branches on the literal
 * `"MCP server probe failed"` prefix produced by
 * `src/agent/spawn-preflight.ts`. The two-branch classifier is the
 * ONLY conditional component selection in the Phase 2 wiring, so it
 * gets a dedicated unit test that pins both branches PLUS the literal
 * prefix string — if `spawn-preflight.ts` ever rewords the throw,
 * this test trips CI before every probe failure silently
 * miscategorizes as `dispatch.spawn`.
 */
describe("classifySpawnError", () => {
  it("returns 'mcp-load' when the message starts with the MCP probe prefix", () => {
    const err = new Error("MCP server probe failed for [trello] before launching agent");
    expect(classifySpawnError(err)).toBe("mcp-load");
  });

  it("returns 'dispatch.spawn' for any other error message", () => {
    expect(classifySpawnError(new Error("ENOSPC: no space left on device"))).toBe(
      "dispatch.spawn",
    );
    expect(classifySpawnError(new Error("claude-auth: credentials expired"))).toBe(
      "dispatch.spawn",
    );
    expect(classifySpawnError(new Error("spawn EACCES"))).toBe("dispatch.spawn");
  });

  it("treats prefix-substring (mid-string match) as 'dispatch.spawn'", () => {
    // The classifier uses `startsWith`, not `includes`. A message that
    // only MENTIONS the prefix mid-string is NOT an MCP probe failure.
    expect(
      classifySpawnError(new Error("wrapped: MCP server probe failed somewhere upstream")),
    ).toBe("dispatch.spawn");
  });

  it("handles non-Error throw values (coerced via String())", () => {
    expect(classifySpawnError("MCP server probe failed for [trello]")).toBe(
      "mcp-load",
    );
    expect(classifySpawnError("plain string error")).toBe("dispatch.spawn");
    expect(classifySpawnError(undefined)).toBe("dispatch.spawn");
    expect(classifySpawnError(null)).toBe("dispatch.spawn");
  });
});
