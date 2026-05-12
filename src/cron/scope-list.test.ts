/**
 * Unit tests for `scope-list.ts` — DX-327.
 *
 * Every parser is exercised against captured `systemctl --user` output
 * shapes (list-units JSON + show key=value blocks). The exec wrapper is
 * tested via dependency injection — no real systemctl call is made.
 */

import { describe, expect, it } from "vitest";
import {
  listDispatchScopes,
  parseDispatchIdFromUnitName,
  parseListUnitsJson,
  parseShowActiveEnterTimestamps,
  type ExecResult,
} from "./scope-list.js";

describe("parseDispatchIdFromUnitName", () => {
  it("strips the `danxbot-dispatch-` prefix and `.scope` suffix", () => {
    expect(
      parseDispatchIdFromUnitName("danxbot-dispatch-abc-123.scope"),
    ).toBe("abc-123");
  });

  it("returns null for non-matching prefix", () => {
    expect(parseDispatchIdFromUnitName("session-c2.scope")).toBeNull();
  });

  it("returns null for non-scope suffix", () => {
    expect(
      parseDispatchIdFromUnitName("danxbot-dispatch-abc-123.service"),
    ).toBeNull();
  });

  it("returns null for empty id between prefix and suffix", () => {
    expect(parseDispatchIdFromUnitName("danxbot-dispatch-.scope")).toBeNull();
  });

  it("preserves UUID dashes verbatim", () => {
    expect(
      parseDispatchIdFromUnitName(
        "danxbot-dispatch-c5672736-6e7b-4801-83de-55e09146676d.scope",
      ),
    ).toBe("c5672736-6e7b-4801-83de-55e09146676d");
  });
});

describe("parseListUnitsJson", () => {
  it("returns only `danxbot-dispatch-*.scope` units", () => {
    const json = JSON.stringify([
      {
        unit: "danxbot-dispatch-abc.scope",
        load: "loaded",
        active: "active",
        sub: "running",
      },
      {
        unit: "session-2.scope",
        load: "loaded",
        active: "active",
        sub: "running",
      },
      {
        unit: "danxbot-dispatch-def.scope",
        load: "loaded",
        active: "active",
        sub: "running",
      },
    ]);
    expect(parseListUnitsJson(json)).toEqual([
      "danxbot-dispatch-abc.scope",
      "danxbot-dispatch-def.scope",
    ]);
  });

  it("returns an empty list when no danxbot scopes are present", () => {
    expect(parseListUnitsJson("[]")).toEqual([]);
  });

  it("ignores entries with missing or non-string `unit`", () => {
    const json = JSON.stringify([
      { unit: "danxbot-dispatch-abc.scope" },
      { active: "active" },
      { unit: 42 },
      null,
    ]);
    expect(parseListUnitsJson(json)).toEqual(["danxbot-dispatch-abc.scope"]);
  });

  it("throws when the JSON root is not an array", () => {
    expect(() => parseListUnitsJson("{}")).toThrow(/expected.*array/i);
  });

  it("throws on malformed JSON with a JSON-parser error message", () => {
    expect(() => parseListUnitsJson("not-json")).toThrow(
      /JSON|Unexpected token/i,
    );
  });
});

describe("parseShowActiveEnterTimestamps", () => {
  it("returns Id → epoch ms for each block", () => {
    const show = [
      "Id=danxbot-dispatch-abc.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
      "Id=danxbot-dispatch-def.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:41:00 UTC",
      "",
    ].join("\n");

    const result = parseShowActiveEnterTimestamps(show);

    expect(result.size).toBe(2);
    expect(result.get("danxbot-dispatch-abc.scope")).toBe(
      Date.UTC(2026, 4, 12, 23, 40, 0),
    );
    expect(result.get("danxbot-dispatch-def.scope")).toBe(
      Date.UTC(2026, 4, 12, 23, 41, 0),
    );
  });

  it("skips blocks missing the ActiveEnterTimestamp key entirely", () => {
    const show = [
      "Id=danxbot-dispatch-no-key.scope",
      "LoadState=loaded",
      "",
      "Id=danxbot-dispatch-ok.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
    ].join("\n");

    const result = parseShowActiveEnterTimestamps(show);

    expect(result.has("danxbot-dispatch-no-key.scope")).toBe(false);
    expect(result.get("danxbot-dispatch-ok.scope")).toBe(
      Date.UTC(2026, 4, 12, 23, 40, 0),
    );
  });

  it("skips blocks with empty ActiveEnterTimestamp (scope not yet active)", () => {
    const show = [
      "Id=danxbot-dispatch-not-yet.scope",
      "ActiveEnterTimestamp=",
      "",
      "Id=danxbot-dispatch-ok.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
    ].join("\n");

    const result = parseShowActiveEnterTimestamps(show);

    expect(result.has("danxbot-dispatch-not-yet.scope")).toBe(false);
    expect(result.get("danxbot-dispatch-ok.scope")).toBe(
      Date.UTC(2026, 4, 12, 23, 40, 0),
    );
  });

  it("returns an empty map for empty input", () => {
    expect(parseShowActiveEnterTimestamps("")).toEqual(new Map());
  });

  it("tolerates a single trailing newline between blocks", () => {
    const show =
      "Id=danxbot-dispatch-a.scope\nActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC\n\nId=danxbot-dispatch-b.scope\nActiveEnterTimestamp=Mon 2026-05-12 23:41:00 UTC\n";

    const result = parseShowActiveEnterTimestamps(show);

    expect(result.size).toBe(2);
  });
});

describe("listDispatchScopes", () => {
  function buildExecStub(
    plan: Map<string, ExecResult>,
  ): (cmd: string, args: readonly string[]) => Promise<ExecResult> {
    return async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      const result = plan.get(key);
      if (!result) {
        throw new Error(`exec stub: no plan for "${key}"`);
      }
      return result;
    };
  }

  const LIST_KEY =
    "systemctl --user list-units --all --output=json --type=scope danxbot-dispatch-*.scope";

  it("returns scope units paired with their ActiveEnterTimestamp", async () => {
    const listJson = JSON.stringify([
      { unit: "danxbot-dispatch-abc.scope" },
      { unit: "danxbot-dispatch-def.scope" },
    ]);
    const showOut = [
      "Id=danxbot-dispatch-abc.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
      "Id=danxbot-dispatch-def.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:41:00 UTC",
      "",
    ].join("\n");
    const plan = new Map<string, ExecResult>([
      [LIST_KEY, { stdout: listJson, stderr: "" }],
      [
        "systemctl --user show --property=Id,ActiveEnterTimestamp danxbot-dispatch-abc.scope danxbot-dispatch-def.scope",
        { stdout: showOut, stderr: "" },
      ],
    ]);

    const scopes = await listDispatchScopes({ exec: buildExecStub(plan) });

    expect(scopes).toEqual([
      {
        unit: "danxbot-dispatch-abc.scope",
        dispatchId: "abc",
        activeEnterEpochMs: Date.UTC(2026, 4, 12, 23, 40, 0),
      },
      {
        unit: "danxbot-dispatch-def.scope",
        dispatchId: "def",
        activeEnterEpochMs: Date.UTC(2026, 4, 12, 23, 41, 0),
      },
    ]);
  });

  it("returns [] without calling `systemctl show` when list is empty", async () => {
    let showCalled = false;
    const exec: (cmd: string, args: readonly string[]) => Promise<ExecResult> =
      async (cmd, args) => {
        if (args.includes("show")) {
          showCalled = true;
          return { stdout: "", stderr: "" };
        }
        return { stdout: "[]", stderr: "" };
      };

    const result = await listDispatchScopes({ exec });

    expect(result).toEqual([]);
    expect(showCalled).toBe(false);
  });

  it("drops scopes whose `systemctl show` response omits a matching Id (alias / stale unit)", async () => {
    const listJson = JSON.stringify([
      { unit: "danxbot-dispatch-alpha.scope" },
      { unit: "danxbot-dispatch-beta.scope" },
    ]);
    // `show` only returns a block for `alpha` — `beta` is missing
    // entirely (simulates a systemctl alias where the Id-of-record
    // differs from the queried name).
    const showOut = [
      "Id=danxbot-dispatch-alpha.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
    ].join("\n");
    const plan = new Map<string, ExecResult>([
      [LIST_KEY, { stdout: listJson, stderr: "" }],
      [
        "systemctl --user show --property=Id,ActiveEnterTimestamp danxbot-dispatch-alpha.scope danxbot-dispatch-beta.scope",
        { stdout: showOut, stderr: "" },
      ],
    ]);

    const scopes = await listDispatchScopes({ exec: buildExecStub(plan) });

    expect(scopes.map((s) => s.unit)).toEqual([
      "danxbot-dispatch-alpha.scope",
    ]);
  });

  it("drops scopes whose ActiveEnterTimestamp is empty (not yet active)", async () => {
    const listJson = JSON.stringify([
      { unit: "danxbot-dispatch-ready.scope" },
      { unit: "danxbot-dispatch-not-yet.scope" },
    ]);
    const showOut = [
      "Id=danxbot-dispatch-ready.scope",
      "ActiveEnterTimestamp=Mon 2026-05-12 23:40:00 UTC",
      "",
      "Id=danxbot-dispatch-not-yet.scope",
      "ActiveEnterTimestamp=",
      "",
    ].join("\n");
    const plan = new Map<string, ExecResult>([
      [LIST_KEY, { stdout: listJson, stderr: "" }],
      [
        "systemctl --user show --property=Id,ActiveEnterTimestamp danxbot-dispatch-ready.scope danxbot-dispatch-not-yet.scope",
        { stdout: showOut, stderr: "" },
      ],
    ]);

    const scopes = await listDispatchScopes({ exec: buildExecStub(plan) });

    expect(scopes.map((s) => s.unit)).toEqual([
      "danxbot-dispatch-ready.scope",
    ]);
  });
});
