import { describe, it, expect } from "vitest";
import {
  DISPATCH_PROFILES,
  resolveProfile,
  type DispatchProfile,
  type DispatchProfileName,
} from "./profiles.js";

describe("dispatch profiles", () => {
  describe("registry", () => {
    it("exposes the two canonical profile names", () => {
      expect(Object.keys(DISPATCH_PROFILES).sort()).toEqual([
        "http-launch",
        "poller",
      ]);
    });

    it("every entry's name matches its registry key", () => {
      for (const [key, profile] of Object.entries(DISPATCH_PROFILES)) {
        expect(profile.name).toBe(key as DispatchProfileName);
      }
    });

    it("registry is frozen — runtime mutation throws", () => {
      // Object.freeze makes assignment throw at runtime in strict mode,
      // even though TypeScript's type system doesn't enforce immutability
      // on `Record<K, V>`. This guards against a future refactor
      // accidentally mutating a profile in place.
      expect(() => {
        (DISPATCH_PROFILES as Record<string, DispatchProfile>).poller = {
          name: "poller",
          allowTools: [],
        } as DispatchProfile;
      }).toThrow();
    });
  });

  describe("poller profile", () => {
    it("includes the danx-next/danx-ideate built-in baseline", () => {
      // These are the built-ins the orchestrator needs to read, edit,
      // and commit code (the union of /danx-next + /danx-ideate skill
      // surfaces). Changing this allowlist without a card rethink is a
      // scope change, not a refactor.
      for (const t of [
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "Bash",
        "TodoWrite",
        "Agent",
        "Task",
      ]) {
        expect(DISPATCH_PROFILES.poller.allowTools).toContain(t);
      }
    });

    it("includes mcp__trello__* (the poller's card-management surface)", () => {
      expect(DISPATCH_PROFILES.poller.allowTools).toContain("mcp__trello__*");
    });

    it("does NOT include mcp__danxbot__danxbot_complete", () => {
      // The resolver auto-injects danxbot_complete as infrastructure;
      // listing it explicitly would double-emit through the registry's
      // lookup path. Fail-loud protection.
      expect(DISPATCH_PROFILES.poller.allowTools).not.toContain(
        "mcp__danxbot__danxbot_complete",
      );
    });
  });

  describe("http-launch profile", () => {
    it("has an empty baseline allowlist", () => {
      // Every HTTP dispatch supplies its own tool surface via the body.
      // The profile names the baseline; it does not grant tools by default.
      expect(DISPATCH_PROFILES["http-launch"].allowTools).toEqual([]);
    });
  });

  describe("resolveProfile", () => {
    it("returns the registered profile for a known name", () => {
      expect(resolveProfile("poller")).toBe(DISPATCH_PROFILES.poller);
      expect(resolveProfile("http-launch")).toBe(
        DISPATCH_PROFILES["http-launch"],
      );
    });

    it("throws fail-loud on an unknown name", () => {
      expect(() =>
        // @ts-expect-error — intentional invalid name to exercise throw path
        resolveProfile("typo-in-name"),
      ).toThrow(/Unknown dispatch profile/);
    });

    it("lists registered names in the error message", () => {
      expect(() =>
        // @ts-expect-error — intentional invalid name
        resolveProfile("garbage"),
      ).toThrow(/poller.*http-launch|http-launch.*poller/);
    });
  });
});
