import { describe, it, expect } from "vitest";
import { renderRepoConfigMarkdown } from "./repo-config-rule.js";

function baseCfg(): Record<string, string> {
  return {
    name: "test-repo",
    url: "https://github.com/org/repo.git",
    runtime: "local",
    language: "typescript",
    framework: "node",
    git_mode: "main",
    "commands.test": "npx vitest run",
    "commands.lint": "npx tsc --noEmit",
    "commands.type_check": "npx tsc --noEmit",
    "commands.dev": "npm run dev",
    "paths.source": "src",
    "paths.tests": "src",
  };
}

describe("renderRepoConfigMarkdown", () => {
  it("renders a complete config with all fields", () => {
    const out = renderRepoConfigMarkdown(baseCfg());
    expect(out).toContain("| Name | `test-repo` |");
    expect(out).toContain("| URL | `https://github.com/org/repo.git` |");
    expect(out).toContain("| Runtime | `local` |");
    expect(out).toContain("| Language | `typescript` |");
    expect(out).toContain("| Framework | `node` |");
    expect(out).toContain("| Git Mode | `main` |");
    expect(out).toContain("| Test | `npx vitest run` |");
    expect(out).toContain("| Source | `src` |");
  });

  it("falls back to git_mode = pr when omitted (optional field)", () => {
    const cfg = baseCfg();
    delete cfg.git_mode;
    const out = renderRepoConfigMarkdown(cfg);
    expect(out).toContain("| Git Mode | `pr` |");
  });

  it("renders empty optional fields without throwing", () => {
    const cfg = baseCfg();
    delete cfg.framework;
    delete cfg["commands.lint"];
    delete cfg["paths.tests"];
    const out = renderRepoConfigMarkdown(cfg);
    expect(out).toContain("| Framework | `` |");
    expect(out).toContain("| Lint | `` |");
    expect(out).toContain("| Tests | `` |");
  });

  for (const required of ["name", "url", "runtime", "language"] as const) {
    it(`throws when required field '${required}' is missing`, () => {
      const cfg = baseCfg();
      delete cfg[required];
      expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
        new RegExp(`'${required}'.*missing`),
      );
    });

    it(`throws when required field '${required}' is empty`, () => {
      const cfg = { ...baseCfg(), [required]: "" };
      expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
        new RegExp(`'${required}'.*missing`),
      );
    });

    it(`throws when required field '${required}' is whitespace only`, () => {
      const cfg = { ...baseCfg(), [required]: "   " };
      expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
        new RegExp(`'${required}'.*missing`),
      );
    });
  }

  describe("docker runtime", () => {
    function dockerCfg(): Record<string, string> {
      return {
        ...baseCfg(),
        runtime: "docker",
        "docker.compose_file": "docker-compose.yml",
        "docker.service_name": "app",
        "docker.project_name": "myproject",
      };
    }

    it("renders Docker section when runtime=docker and compose_file is set", () => {
      const out = renderRepoConfigMarkdown(dockerCfg());
      expect(out).toContain("## Docker");
      expect(out).toContain("| Compose File | `docker-compose.yml` |");
      expect(out).toContain("| Service Name | `app` |");
      expect(out).toContain("| Project Name | `myproject` |");
    });

    it("omits Docker section when runtime=docker but compose_file is empty (no docker config)", () => {
      const cfg = dockerCfg();
      delete cfg["docker.compose_file"];
      const out = renderRepoConfigMarkdown(cfg);
      expect(out).not.toContain("## Docker");
    });

    for (const sub of ["docker.service_name", "docker.project_name"] as const) {
      it(`throws when runtime=docker, compose_file is set, but '${sub}' is missing`, () => {
        const cfg = dockerCfg();
        delete cfg[sub];
        expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
          new RegExp(`'${sub.replace(".", "\\.")}'.*missing`),
        );
      });

      it(`throws when runtime=docker, compose_file is set, but '${sub}' is empty`, () => {
        const cfg = { ...dockerCfg(), [sub]: "" };
        expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
          new RegExp(`'${sub.replace(".", "\\.")}'.*missing`),
        );
      });

      it(`throws when runtime=docker, compose_file is set, but '${sub}' is whitespace only`, () => {
        const cfg = { ...dockerCfg(), [sub]: "   " };
        expect(() => renderRepoConfigMarkdown(cfg)).toThrow(
          new RegExp(`'${sub.replace(".", "\\.")}'.*missing`),
        );
      });
    }
  });
});
