import { describe, it, expect } from "vitest";
import {
  scopeUnitName,
  buildSystemdRunArgs,
  DANXBOT_DISPATCH_SCOPE_ENV,
} from "./scope.js";

describe("scopeUnitName", () => {
  it("formats the unit name as danxbot-dispatch-<id>", () => {
    expect(scopeUnitName("abc123")).toBe("danxbot-dispatch-abc123");
  });

  it("preserves the literal dispatchId — no slug, no truncation", () => {
    // Dispatch IDs are randomUUIDs; the unit name must be the literal id
    // so `systemctl --user stop danxbot-dispatch-<id>.scope` (Phase 3) can
    // reach the unit using the same id we stamped on the dispatch row.
    const id = "f61863ff-0d15-402f-aa51-4e36705e55e6";
    expect(scopeUnitName(id)).toBe(`danxbot-dispatch-${id}`);
  });

  it("throws on an empty dispatchId", () => {
    // An empty id would produce `danxbot-dispatch-` which collides with
    // every other empty-id dispatch in the same systemd user session.
    // Fail loud at construction time, not at `systemctl stop` time.
    expect(() => scopeUnitName("")).toThrow(
      /scopeUnitName: dispatchId must be non-empty/,
    );
  });
});

describe("buildSystemdRunArgs", () => {
  it("returns the canonical arg array — --user --scope --unit <name> --quiet --collect -- <claude> ...args", () => {
    expect(
      buildSystemdRunArgs({
        dispatchId: "abc",
        claudePath: "claude",
        claudeArgs: ["--dangerously-skip-permissions", "-p", "hi"],
      }),
    ).toEqual([
      "--user",
      "--scope",
      "--unit",
      "danxbot-dispatch-abc",
      "--quiet",
      "--collect",
      "--",
      "claude",
      "--dangerously-skip-permissions",
      "-p",
      "hi",
    ]);
  });

  it("includes --collect so completed dispatches do not leak unit metadata", () => {
    // Without --collect, systemd retains the (failed-or-completed) scope
    // unit in `systemctl --user list-units --all` indefinitely. The reaper
    // (Phase 4) joins live scopes against the `dispatches` table; an
    // unbounded ghost-unit set would balloon both the listing cost and
    // the join.
    const args = buildSystemdRunArgs({
      dispatchId: "x",
      claudePath: "claude",
      claudeArgs: [],
    });
    expect(args).toContain("--collect");
  });

  it("includes --quiet so systemd-run does not write its own scope-started message to claude's stderr", () => {
    // The headless path pipes claude's stderr only for failure summaries.
    // systemd-run's default banner ("Running scope as unit: …") would
    // pollute every failed-job summary with non-claude noise.
    const args = buildSystemdRunArgs({
      dispatchId: "x",
      claudePath: "claude",
      claudeArgs: [],
    });
    expect(args).toContain("--quiet");
  });

  it("uses -- separator between systemd-run flags and the inner command", () => {
    // `--unit <name>` is the last systemd-run flag; without `--` the
    // claude argv's `--mcp-config <paths...>` (variadic) would be parsed
    // as additional values for `--unit`, mangling the unit name.
    const args = buildSystemdRunArgs({
      dispatchId: "x",
      claudePath: "claude",
      claudeArgs: ["--mcp-config", "/tmp/a.json"],
    });
    const sep = args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(args[sep - 1]).toBe("--collect");
    expect(args[sep + 1]).toBe("claude");
  });

  it("accepts an absolute claudePath (callers can pin a specific binary)", () => {
    const args = buildSystemdRunArgs({
      dispatchId: "x",
      claudePath: "/usr/local/bin/claude",
      claudeArgs: ["-p", "hi"],
    });
    expect(args.slice(-3)).toEqual(["/usr/local/bin/claude", "-p", "hi"]);
  });

  it("passes an empty claudeArgs array through unchanged", () => {
    const args = buildSystemdRunArgs({
      dispatchId: "x",
      claudePath: "claude",
      claudeArgs: [],
    });
    expect(args[args.length - 1]).toBe("claude");
  });

  it("throws on an empty dispatchId — refuses to build a colliding unit", () => {
    expect(() =>
      buildSystemdRunArgs({
        dispatchId: "",
        claudePath: "claude",
        claudeArgs: [],
      }),
    ).toThrow(/scopeUnitName: dispatchId must be non-empty/);
  });

  it("throws on an empty claudePath — guards against silent fall-through to PATH lookup of empty string", () => {
    // `spawn("systemd-run", [..., "--", "", "-p", "..."])` would resolve
    // to "execvp: : No such file or directory" deep inside systemd-run's
    // exec, surfacing as a confusing "scope exited 203" instead of a
    // clear "claudePath was empty" at the spawn site.
    expect(() =>
      buildSystemdRunArgs({
        dispatchId: "x",
        claudePath: "",
        claudeArgs: [],
      }),
    ).toThrow(/buildSystemdRunArgs: claudePath must be non-empty/);
  });
});

describe("DANXBOT_DISPATCH_SCOPE_ENV", () => {
  it("is the literal env var name children + observers read to identify their owning scope", () => {
    // Pinned literally so a typo in spawn-preflight.ts (which injects the
    // value) is caught by the test instead of by a future reaper that
    // can't correlate spawned PIDs to their owning unit.
    expect(DANXBOT_DISPATCH_SCOPE_ENV).toBe("DANXBOT_DISPATCH_SCOPE");
  });
});
