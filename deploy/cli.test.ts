import { describe, it, expect } from "vitest";
import { parseCliArgs, buildMaterializeRepoArgs } from "./cli.js";

describe("parseCliArgs", () => {
  it("parses `deploy gpt`", () => {
    expect(parseCliArgs(["deploy", "gpt"])).toMatchObject({
      command: "deploy",
      target: "gpt",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses `status flytedesk`", () => {
    expect(parseCliArgs(["status", "flytedesk"])).toMatchObject({
      command: "status",
      target: "flytedesk",
      dryRun: false,
      confirm: false,
    });
  });

  it("parses --dry-run", () => {
    expect(parseCliArgs(["deploy", "gpt", "--dry-run"])).toMatchObject({
      command: "deploy",
      target: "gpt",
      dryRun: true,
      confirm: false,
    });
  });

  it("parses --confirm for destroy", () => {
    expect(parseCliArgs(["destroy", "gpt", "--confirm"])).toMatchObject({
      command: "destroy",
      target: "gpt",
      dryRun: false,
      confirm: true,
    });
  });

  it("parses `create-user gpt alice` with username positional", () => {
    expect(parseCliArgs(["create-user", "gpt", "alice"])).toMatchObject({
      command: "create-user",
      target: "gpt",
      username: "alice",
    });
  });

  it("throws when create-user is missing USERNAME", () => {
    expect(() => parseCliArgs(["create-user", "gpt"])).toThrow(/USERNAME/);
  });

  it("throws when create-user is given a flag where USERNAME should be", () => {
    expect(() => parseCliArgs(["create-user", "gpt", "--dry-run"])).toThrow(
      /USERNAME/,
    );
  });

  it("does NOT set username for non-create-user commands", () => {
    const parsed = parseCliArgs(["deploy", "gpt", "extra-positional"]);
    expect(parsed.username).toBeUndefined();
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

  it("parses all valid commands (create-user needs a 3rd positional)", () => {
    for (const cmd of [
      "deploy",
      "status",
      "destroy",
      "ssh",
      "logs",
      "secrets-push",
      "smoke",
      "ensure-root-user",
    ]) {
      expect(parseCliArgs([cmd, "gpt"]).command).toBe(cmd);
    }
    expect(parseCliArgs(["create-user", "gpt", "alice"]).command).toBe(
      "create-user",
    );
  });
});

describe("buildMaterializeRepoArgs", () => {
  it("emits bare name for repos without app_env_subpath", () => {
    expect(
      buildMaterializeRepoArgs([
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561 },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562 },
      ]),
    ).toBe("danxbot gpt-manager");
  });

  it("emits name:subpath for repos with app_env_subpath", () => {
    expect(
      buildMaterializeRepoArgs([
        {
          name: "platform",
          url: "https://github.com/x/p.git",
          appEnvSubpath: "ssap",
          workerPort: 5563,
        },
      ]),
    ).toBe("platform:ssap");
  });

  it("mixes bare and :subpath forms in one call", () => {
    // Regression guard for the order / concatenation: if anyone swaps
    // `${r.name}:${r.appEnvSubpath}` → `${r.appEnvSubpath}:${r.name}`,
    // this test fails immediately.
    expect(
      buildMaterializeRepoArgs([
        {
          name: "platform",
          url: "https://github.com/x/p.git",
          appEnvSubpath: "ssap",
          workerPort: 5563,
        },
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561 },
      ]),
    ).toBe("platform:ssap danxbot");
  });

  it("returns empty string for zero repos (no deploy-without-repos ever needed it, but keep it safe)", () => {
    expect(buildMaterializeRepoArgs([])).toBe("");
  });
});
