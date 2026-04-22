import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flagPath,
  readFlag,
  writeFlag,
  clearFlag,
  type CriticalFailurePayload,
} from "./critical-failure.js";

describe("critical-failure", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "danxbot-critical-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("flagPath", () => {
    it("resolves to <localPath>/.danxbot/CRITICAL_FAILURE", () => {
      expect(flagPath(tmp)).toBe(join(tmp, ".danxbot", "CRITICAL_FAILURE"));
    });
  });

  describe("readFlag", () => {
    it("returns null ONLY when the file is absent (so the poller can actually resume)", () => {
      expect(readFlag(tmp)).toBeNull();
    });

    it("returns a synthetic unparseable payload when the file contains non-JSON (fail-closed)", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(flagPath(tmp), "not json");
      const result = readFlag(tmp);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("unparseable");
      expect(result!.reason).toMatch(/unparseable/i);
    });

    it("returns a synthetic unparseable payload when the source is not one of the accepted values", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(
        flagPath(tmp),
        JSON.stringify({
          timestamp: "2026-04-21T00:00:00.000Z",
          source: "bogus",
          dispatchId: "d-1",
          reason: "x",
        }),
      );
      const result = readFlag(tmp);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("unparseable");
    });

    it("returns a synthetic unparseable payload when required fields are missing", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(flagPath(tmp), JSON.stringify({ source: "agent" }));
      const result = readFlag(tmp);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("unparseable");
    });

    it("returns a synthetic unparseable payload when top-level JSON is an array (covers non-object normalize branch)", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(flagPath(tmp), JSON.stringify([1, 2, 3]));
      expect(readFlag(tmp)!.source).toBe("unparseable");
    });

    it("returns a synthetic unparseable payload when top-level JSON is a string", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(flagPath(tmp), JSON.stringify("a string"));
      expect(readFlag(tmp)!.source).toBe("unparseable");
    });

    it("returns the payload when the file is a valid flag", () => {
      mkdirSync(join(tmp, ".danxbot"));
      const payload: CriticalFailurePayload = {
        timestamp: "2026-04-21T00:00:00.000Z",
        source: "agent",
        dispatchId: "d-1",
        reason: "Test reason",
        detail: "Multi\nLine\nDetail",
      };
      writeFileSync(flagPath(tmp), JSON.stringify(payload));
      expect(readFlag(tmp)).toEqual(payload);
    });

    it("drops empty-string optional fields so callers don't render blanks", () => {
      mkdirSync(join(tmp, ".danxbot"));
      writeFileSync(
        flagPath(tmp),
        JSON.stringify({
          timestamp: "2026-04-21T00:00:00.000Z",
          source: "post-dispatch-check",
          dispatchId: "d-1",
          reason: "r",
          cardId: "",
          cardUrl: "",
          detail: "",
        }),
      );
      const result = readFlag(tmp);
      expect(result).not.toBeNull();
      expect(result!.cardId).toBeUndefined();
      expect(result!.cardUrl).toBeUndefined();
      expect(result!.detail).toBeUndefined();
    });
  });

  describe("writeFlag", () => {
    it("creates the .danxbot directory when it doesn't exist", () => {
      expect(existsSync(join(tmp, ".danxbot"))).toBe(false);
      writeFlag(tmp, { source: "agent", dispatchId: "d-1", reason: "Test" });
      expect(existsSync(flagPath(tmp))).toBe(true);
    });

    it("stamps an ISO-8601 timestamp when the caller omits it", () => {
      const result = writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
      });
      expect(result.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it("preserves a caller-supplied timestamp", () => {
      const result = writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result.timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("round-trips a post-dispatch-check payload via readFlag", () => {
      writeFlag(tmp, {
        source: "post-dispatch-check",
        dispatchId: "d-2",
        cardId: "card-abc",
        cardUrl: "https://trello.com/c/abc",
        reason: "Card still in ToDo after dispatch",
        detail: "Tracked card was not moved out of ToDo list",
      });
      const result = readFlag(tmp);
      expect(result).not.toBeNull();
      expect(result!.source).toBe("post-dispatch-check");
      expect(result!.cardId).toBe("card-abc");
      expect(result!.cardUrl).toBe("https://trello.com/c/abc");
      expect(result!.reason).toBe("Card still in ToDo after dispatch");
      expect(result!.detail).toBe(
        "Tracked card was not moved out of ToDo list",
      );
    });

    it("overwrites an existing flag", () => {
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "first",
      });
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-2",
        reason: "second",
      });
      const result = readFlag(tmp);
      expect(result!.reason).toBe("second");
      expect(result!.dispatchId).toBe("d-2");
    });

    it("writes pretty-printed JSON (humans cat the file)", () => {
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
      });
      const raw = readFileSync(flagPath(tmp), "utf-8");
      expect(raw).toContain("\n");
      expect(raw).toMatch(/"source": "agent"/);
      expect(raw.endsWith("\n")).toBe(true);
    });

    it("leaves no tmp file behind after a successful write", () => {
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
      });
      const entries = readdirSync(join(tmp, ".danxbot"));
      const orphans = entries.filter((e) =>
        e.startsWith("CRITICAL_FAILURE.tmp"),
      );
      expect(orphans).toEqual([]);
    });
  });

  describe("clearFlag", () => {
    it("returns false when the file is missing", () => {
      expect(clearFlag(tmp)).toBe(false);
    });

    it("deletes the file and returns true when the flag is present", () => {
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
      });
      expect(existsSync(flagPath(tmp))).toBe(true);
      expect(clearFlag(tmp)).toBe(true);
      expect(existsSync(flagPath(tmp))).toBe(false);
    });

    it("is idempotent — second call returns false without throwing", () => {
      writeFlag(tmp, {
        source: "agent",
        dispatchId: "d-1",
        reason: "Test",
      });
      clearFlag(tmp);
      expect(() => clearFlag(tmp)).not.toThrow();
      expect(clearFlag(tmp)).toBe(false);
    });
  });
});
