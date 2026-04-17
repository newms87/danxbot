import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./cli.js";

describe("parseCliArgs", () => {
  it("parses `deploy gpt`", () => {
    expect(parseCliArgs(["deploy", "gpt"])).toEqual({
      command: "deploy",
      target: "gpt",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses `status flytedesk`", () => {
    expect(parseCliArgs(["status", "flytedesk"])).toEqual({
      command: "status",
      target: "flytedesk",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses --dry-run", () => {
    expect(parseCliArgs(["deploy", "gpt", "--dry-run"])).toEqual({
      command: "deploy",
      target: "gpt",
      dryRun: true,
      confirm: false,
    });
  });

  it("parses --confirm for destroy", () => {
    expect(parseCliArgs(["destroy", "gpt", "--confirm"])).toEqual({
      command: "destroy",
      target: "gpt",
      dryRun: false,
      confirm: true,
    });
  });

  it("throws on unknown command", () => {
    expect(() => parseCliArgs(["frobnicate", "gpt"])).toThrow("Unknown command");
  });

  it("throws when target is missing", () => {
    expect(() => parseCliArgs(["deploy"])).toThrow("TARGET is required");
  });

  it("throws when only flags are provided (no target)", () => {
    expect(() => parseCliArgs(["deploy", "--dry-run"])).toThrow(
      "TARGET is required",
    );
  });

  it("parses `secrets-push gpt`", () => {
    expect(parseCliArgs(["secrets-push", "gpt"])).toEqual({
      command: "secrets-push",
      target: "gpt",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses all valid commands", () => {
    for (const cmd of [
      "deploy",
      "status",
      "destroy",
      "ssh",
      "logs",
      "secrets-push",
      "smoke",
    ]) {
      expect(parseCliArgs([cmd, "gpt"]).command).toBe(cmd);
    }
  });
});
