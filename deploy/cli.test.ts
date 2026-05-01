import { describe, it, expect } from "vitest";
import {
  parseCliArgs,
  buildMaterializeRepoArgs,
  fetchRepoTokens,
} from "./cli.js";
import { makeConfig } from "./test-helpers.js";

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
    expect(parsed).not.toHaveProperty("username");
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
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562, branch: "main" },
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
          branch: "main",
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
          branch: "main",
        },
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
      ]),
    ).toBe("platform:ssap danxbot");
  });

  it("returns empty string for zero repos (no deploy-without-repos ever needed it, but keep it safe)", () => {
    expect(buildMaterializeRepoArgs([])).toBe("");
  });
});

describe("fetchRepoTokens", () => {
  it("queries SSM at <prefix>/repos/<name>/DANX_GITHUB_TOKEN per repo", () => {
    const calls: string[] = [];
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-gpt",
      region: "us-east-1",
      aws: { profile: "gpt" },
      repos: [
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562, branch: "main" },
      ],
    });
    const tokens = fetchRepoTokens(cfg, (cmd: string) => {
      calls.push(cmd);
      // Match against the per-repo segment of the SSM path so the test
      // doesn't trip on the prefix-also-containing-"danxbot".
      return cmd.includes("/repos/danxbot/")
        ? "ghp_danxbot"
        : "ghp_gpt";
    });

    expect(tokens).toEqual({
      danxbot: "ghp_danxbot",
      "gpt-manager": "ghp_gpt",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(
      `--name "/danxbot-gpt/repos/danxbot/DANX_GITHUB_TOKEN"`,
    );
    expect(calls[1]).toContain(
      `--name "/danxbot-gpt/repos/gpt-manager/DANX_GITHUB_TOKEN"`,
    );
    expect(calls[0]).toContain("--with-decryption");
    expect(calls[0]).toContain("--region us-east-1");
    expect(calls[0]).toContain("aws --profile gpt");
  });

  it("returns an empty object when the deployment has no repos", () => {
    const calls: string[] = [];
    const cfg = makeConfig({ repos: [] });
    expect(
      fetchRepoTokens(cfg, (cmd: string) => {
        calls.push(cmd);
        return "";
      }),
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  it("propagates non-zero exit from runCmd (no swallowing — broken token must abort deploy)", () => {
    const cfg = makeConfig({
      repos: [{ name: "x", url: "https://github.com/x/x.git", workerPort: 5561, branch: "main" }],
    });
    expect(() =>
      fetchRepoTokens(cfg, () => {
        throw new Error("ParameterNotFound");
      }),
    ).toThrow(/ParameterNotFound/);
  });
});
