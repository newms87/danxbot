import { describe, it, expect } from "vitest";
import {
  dispatchAllowTools,
  DISPATCH_PROFILES,
  mergeProfileWithBody,
  resolveProfile,
  type DispatchProfile,
  type DispatchProfileName,
} from "./profiles.js";

describe("dispatch profiles", () => {
  describe("registry", () => {
    it("exposes the three canonical profile names", () => {
      expect(Object.keys(DISPATCH_PROFILES).sort()).toEqual([
        "http-launch",
        "poller",
        "slack",
      ]);
    });

    it("registry is frozen — runtime mutation throws", () => {
      // Object.freeze makes assignment throw at runtime in strict mode,
      // even though TypeScript's type system doesn't enforce immutability
      // on `Record<K, V>`. This guards against a future refactor
      // accidentally mutating a profile in place.
      expect(() => {
        (DISPATCH_PROFILES as Record<string, DispatchProfile>).poller = {
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
    it("includes the standard agent built-ins so API callers always get Read/Bash/etc.", () => {
      // Any agent dispatched via /api/launch or /api/resume must have the
      // standard built-in tool surface available regardless of what the
      // caller listed in body.allow_tools. This is what lets the agent
      // follow through on large MCP responses the harness spills to disk
      // (>2KB preview truncation) — without Read/Bash the spill file is
      // unreachable — and perform the basic filesystem/shell work every
      // non-trivial agent needs.
      for (const t of [
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "Bash",
        "TodoWrite",
      ]) {
        expect(DISPATCH_PROFILES["http-launch"].allowTools).toContain(t);
      }
    });

    it("does NOT include mcp__danxbot__danxbot_complete", () => {
      // Same invariant as the poller: danxbot_complete is auto-injected
      // as infrastructure by the resolver. Listing it in the baseline
      // would double-emit through the registry lookup path.
      expect(DISPATCH_PROFILES["http-launch"].allowTools).not.toContain(
        "mcp__danxbot__danxbot_complete",
      );
    });

    it("does NOT include any mcp__* entry in the baseline", () => {
      // API callers opt into MCP servers via body.allow_tools. Baking one
      // in (say, mcp__trello__*) would activate that server on every API
      // dispatch and spawn its subprocess unnecessarily.
      for (const t of DISPATCH_PROFILES["http-launch"].allowTools) {
        expect(t.startsWith("mcp__")).toBe(false);
      }
    });

    it("does NOT include Agent or Task (sub-agent dispatch is opt-in per call)", () => {
      // The http-launch baseline is narrower than the poller baseline by
      // design: Agent/Task are sub-agent dispatch built-ins that callers
      // must request explicitly via body.allow_tools. A future refactor
      // that unifies the poller + http-launch baselines into one shared
      // constant would silently add these; this test catches that.
      expect(DISPATCH_PROFILES["http-launch"].allowTools).not.toContain(
        "Agent",
      );
      expect(DISPATCH_PROFILES["http-launch"].allowTools).not.toContain(
        "Task",
      );
    });

    it("preserves this exact declared order — claude's --allowed-tools CSV is order-sensitive", () => {
      // Pinned against literal list (NOT the profile itself) so a silent
      // reorder of HTTP_LAUNCH_ALLOW_TOOLS fails this test. The other
      // http-launch tests use the profile as both source and expectation,
      // which cannot detect a reorder.
      expect([...DISPATCH_PROFILES["http-launch"].allowTools]).toEqual([
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "Bash",
        "TodoWrite",
      ]);
    });
  });

  describe("slack profile", () => {
    it("is exactly the read-only built-ins (Read/Glob/Grep/Bash)", () => {
      // Slack in-process SDK dispatch — the agent answers codebase
      // questions without mutating, and no MCP servers spawn.
      expect(DISPATCH_PROFILES.slack.allowTools).toEqual([
        "Read",
        "Glob",
        "Grep",
        "Bash",
      ]);
    });

    it("does NOT include Edit, Write, or any mcp__* entry", () => {
      // Mutating tools are forbidden for Slack; MCP servers would spawn
      // npx subprocesses on every Slack message.
      const tools = DISPATCH_PROFILES.slack.allowTools;
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Write");
      for (const t of tools) {
        expect(t.startsWith("mcp__")).toBe(false);
      }
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

  describe("mergeProfileWithBody", () => {
    // The HTTP launch path merges the named profile's baseline with the
    // caller's per-request allowlist. This helper is the one place that
    // merge is defined — profile entries first, body entries second,
    // first appearance wins on dedupe. Phase 4 of the agent-isolation
    // epic (Trello 7ha2CSpc) — these tests document the merge contract.

    it("prepends the profile baseline to body entries", () => {
      const profile: DispatchProfile = {
        allowTools: ["Read", "Bash"],
      };
      expect(mergeProfileWithBody(profile, ["Grep", "Edit"])).toEqual([
        "Read",
        "Bash",
        "Grep",
        "Edit",
      ]);
    });

    it("returns the body unchanged when the profile baseline is empty", () => {
      const profile: DispatchProfile = {
        allowTools: [],
      };
      expect(mergeProfileWithBody(profile, ["Read", "mcp__trello__*"])).toEqual(
        ["Read", "mcp__trello__*"],
      );
    });

    it("returns the profile baseline when the body allowlist is empty", () => {
      const profile: DispatchProfile = {
        allowTools: ["Read", "Bash", "mcp__trello__*"],
      };
      expect(mergeProfileWithBody(profile, [])).toEqual([
        "Read",
        "Bash",
        "mcp__trello__*",
      ]);
    });

    it("dedupes overlap with first-appearance-wins (profile first)", () => {
      // When the body repeats a profile entry, the merged list keeps the
      // profile's position (earlier) and drops the duplicate from the body.
      // Mirrors the resolver's own dedupe semantics so the merged array
      // is already canonical when it reaches `resolveDispatchTools`.
      const profile: DispatchProfile = {
        allowTools: ["Read", "Bash"],
      };
      expect(
        mergeProfileWithBody(profile, ["Bash", "Grep", "Read", "Edit"]),
      ).toEqual(["Read", "Bash", "Grep", "Edit"]);
    });

    it("dedupes duplicate entries within the body alone", () => {
      const profile: DispatchProfile = {
        allowTools: [],
      };
      expect(mergeProfileWithBody(profile, ["Read", "Read", "Bash"])).toEqual([
        "Read",
        "Bash",
      ]);
    });

    it("dedupes duplicate entries within the profile alone", () => {
      // Profiles are frozen today so this shouldn't happen in production,
      // but the helper is total — it must not emit duplicates regardless
      // of how the inputs arrived.
      const profile: DispatchProfile = {
        allowTools: ["Read", "Read", "Bash"],
      };
      expect(mergeProfileWithBody(profile, [])).toEqual(["Read", "Bash"]);
    });

    it("returns an empty array when both profile and body are empty", () => {
      const profile: DispatchProfile = {
        allowTools: [],
      };
      expect(mergeProfileWithBody(profile, [])).toEqual([]);
    });

    it("does not mutate the inputs", () => {
      const profile: DispatchProfile = {
        allowTools: ["Read", "Bash"],
      };
      const body = ["Grep", "Read"];
      const profileSnapshot = [...profile.allowTools];
      const bodySnapshot = [...body];
      mergeProfileWithBody(profile, body);
      expect(profile.allowTools).toEqual(profileSnapshot);
      expect(body).toEqual(bodySnapshot);
    });

    it("drops duplicates that appear interleaved between profile and overrides", () => {
      // Regression guard: the other dedupe tests land duplicates adjacent
      // to the profile entry (`["Bash", "Grep", "Read", ...]` after
      // profile `["Read", "Bash"]`). This test interleaves a profile-dup
      // into the middle of the override list and asserts the profile's
      // earlier position wins — i.e. `A` does NOT re-appear after `C`
      // just because it's reached during the second-pass iteration.
      const profile: DispatchProfile = {
        allowTools: ["A", "B"],
      };
      expect(mergeProfileWithBody(profile, ["C", "A", "D"])).toEqual([
        "A",
        "B",
        "C",
        "D",
      ]);
    });
  });

  describe("dispatchAllowTools", () => {
    // The single entry point every dispatcher (poller, HTTP handlers,
    // Slack listener) goes through. Resolves the named profile + merges
    // overrides in one call. These tests pin the contract against the
    // REAL registry entries (not ad-hoc profiles) so a registry-swap
    // regression can't pass the isolated mergeProfileWithBody tests
    // while breaking the live surface.

    it("returns the poller profile's baseline verbatim when given no overrides", () => {
      expect(dispatchAllowTools("poller")).toEqual([
        ...DISPATCH_PROFILES.poller.allowTools,
      ]);
    });

    it("returns the http-launch baseline (standard built-ins) when given no overrides", () => {
      expect(dispatchAllowTools("http-launch")).toEqual([
        ...DISPATCH_PROFILES["http-launch"].allowTools,
      ]);
    });

    it("merges http-launch baseline with overrides — trello opt-in shape prepended with baseline", () => {
      // The canonical HTTP shape: body asks for mcp__trello__*, profile
      // contributes the standard built-in baseline. Merged output is
      // [baseline..., override] in that order per the profile-first merge
      // contract.
      expect(dispatchAllowTools("http-launch", ["mcp__trello__*"])).toEqual([
        ...DISPATCH_PROFILES["http-launch"].allowTools,
        "mcp__trello__*",
      ]);
    });

    it("keeps the baseline even when the body lists only MCP tools — the gpt-manager Schema Builder shape", () => {
      // Regression guard for the bug this change fixes. Before the
      // baseline existed, a caller like gpt-manager passing
      // ["mcp__schema__*"] would produce an effective allowlist of
      // [mcp__schema__..., mcp__danxbot__danxbot_complete] — NO Read,
      // NO Bash — so the agent could not access the spill files the
      // harness writes for >2KB MCP responses. The baseline prevents
      // that class of failure at the profile seam.
      const merged = dispatchAllowTools("http-launch", ["mcp__schema__*"]);
      for (const t of ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]) {
        expect(merged).toContain(t);
      }
      expect(merged).toContain("mcp__schema__*");
    });

    it("throws fail-loud on an unknown profile name (same gate as resolveProfile)", () => {
      expect(() =>
        // @ts-expect-error — intentional invalid name
        dispatchAllowTools("no-such-profile"),
      ).toThrow(/Unknown dispatch profile/);
    });
  });
});
