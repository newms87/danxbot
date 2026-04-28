import { describe, it, expect } from "vitest";
import {
  sharedKeyPath,
  repoKeyPath,
  repoAppKeyPath,
} from "./ssm-paths.js";

describe("ssm-paths", () => {
  describe("sharedKeyPath", () => {
    it("composes <prefix>/shared/<key>", () => {
      expect(sharedKeyPath("/danxbot-gpt", "ANTHROPIC_API_KEY")).toBe(
        "/danxbot-gpt/shared/ANTHROPIC_API_KEY",
      );
    });

    it("does not collapse repeated slashes when caller passes a trailing-slash prefix", () => {
      // Callers should not pass trailing slashes; if they do, the result
      // surfaces the duplication so the bug is loud rather than silent.
      expect(sharedKeyPath("/danxbot-gpt/", "FOO")).toBe(
        "/danxbot-gpt//shared/FOO",
      );
    });
  });

  describe("repoKeyPath", () => {
    it("composes <prefix>/repos/<repo>/<key>", () => {
      expect(repoKeyPath("/danxbot-gpt", "platform", "DANX_GITHUB_TOKEN")).toBe(
        "/danxbot-gpt/repos/platform/DANX_GITHUB_TOKEN",
      );
    });

    it("preserves dashes/underscores/dots in repo names verbatim", () => {
      // Repo names matching config.ts's regex include hyphens and dots; the
      // helper must not normalize them.
      expect(repoKeyPath("/p", "gpt-manager", "K")).toBe(
        "/p/repos/gpt-manager/K",
      );
      expect(repoKeyPath("/p", "my_repo", "K")).toBe("/p/repos/my_repo/K");
      expect(repoKeyPath("/p", "v8.3.app", "K")).toBe("/p/repos/v8.3.app/K");
    });
  });

  describe("repoAppKeyPath", () => {
    it("prefixes the key with REPO_ENV_ to mirror the materializer's split rule", () => {
      // The instance-side materializer splits the per-repo SSM subtree into
      // <repo>/.danxbot/.env (non-REPO_ENV_*) vs the app .env (REPO_ENV_*).
      // The helper encodes that contract on the write side so the two paths
      // can never drift apart silently.
      expect(repoAppKeyPath("/danxbot-gpt", "platform", "APP_KEY")).toBe(
        "/danxbot-gpt/repos/platform/REPO_ENV_APP_KEY",
      );
    });

    it("does NOT double-prefix when caller passes a key that already starts with REPO_ENV_", () => {
      // The collision case from the card description: a danxbot-side key
      // literally named REPO_ENV_FOO would, if passed to repoAppKeyPath,
      // become REPO_ENV_REPO_ENV_FOO — that's the desired behavior because
      // it's how the materializer would round-trip it (the FIRST REPO_ENV_
      // prefix gets stripped, leaving REPO_ENV_FOO as the app-side key
      // name). The helper must not "be smart" and skip the prefix; the
      // contract is mechanical.
      expect(repoAppKeyPath("/p", "app", "REPO_ENV_FOO")).toBe(
        "/p/repos/app/REPO_ENV_REPO_ENV_FOO",
      );
    });
  });
});
