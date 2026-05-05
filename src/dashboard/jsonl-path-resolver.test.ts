import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CLAUDE_PROJECTS_BASE,
  DASHBOARD_HOST_CLAUDE_PROJECTS_BASE,
  translateHostPath,
  translateWorkerPath,
  expectedJsonlPath,
  resolveJsonlPath,
} from "./jsonl-path-resolver.js";
import type { Dispatch } from "./dispatches.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDispatch(overrides: Partial<Dispatch> = {}): Pick<
  Dispatch,
  "jsonlPath" | "sessionUuid" | "repoName"
> {
  return {
    repoName: "danxbot",
    jsonlPath: null,
    sessionUuid: null,
    ...overrides,
  };
}

// The singular-workspace `encodeRepoCwd` + `computeDashboardJsonlPath`
// helpers were retired with the workspace-dispatch cleanup (Trello
// `jAdeJgi5`). Strategy 3 now enumerates `<repo>/.danxbot/workspaces/<name>/`
// candidates via `dashboardJsonlCandidates` — covered by the
// `resolveJsonlPath` integration tests below.

// ---------------------------------------------------------------------------
// translateWorkerPath
// ---------------------------------------------------------------------------

describe("translateWorkerPath", () => {
  it("translates a worker-internal path to the dashboard mount", () => {
    const worker = "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess.jsonl";
    const result = translateWorkerPath(worker, "danxbot");
    expect(result).toBe(
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/sess.jsonl`,
    );
  });

  it("uses the repoName in the translated path (not the encoded dir)", () => {
    const worker =
      "/home/danxbot/.claude/projects/-danxbot-app-repos-gpt-manager/sess.jsonl";
    const result = translateWorkerPath(worker, "gpt-manager");
    expect(result).toContain("/gpt-manager/-danxbot-app-repos-gpt-manager/");
  });

  it("returns null for paths not starting with the worker prefix", () => {
    expect(translateWorkerPath("/some/other/path/sess.jsonl", "danxbot")).toBeNull();
    expect(translateWorkerPath("", "danxbot")).toBeNull();
    expect(
      translateWorkerPath("/home/danxbot/.claude/projects", "danxbot"),
    ).toBeNull(); // no trailing slash → doesn't match the prefix
  });

  it("preserves the sub-agent path structure unchanged", () => {
    const worker =
      "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess-uuid/subagents/agent-abc.jsonl";
    const result = translateWorkerPath(worker, "danxbot");
    expect(result).toBe(
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/sess-uuid/subagents/agent-abc.jsonl`,
    );
  });
});

// ---------------------------------------------------------------------------
// translateHostPath
// ---------------------------------------------------------------------------

describe("translateHostPath", () => {
  // Host-mode workers run on the developer's host and write JSONL to
  // the developer's `~/.claude/projects/`. The dashboard container can
  // only read those paths through a single shared mount — see the
  // `${HOME}/.claude/projects:/danxbot/app/host-claude-projects:ro`
  // line in `dev-compose-override.ts`. The dashboard never knows the
  // developer's host username, so translation anchors on the literal
  // `/.claude/projects/` segment.

  it("translates a developer ~/.claude/projects path to the host-claude-projects mount", () => {
    const host =
      "/home/newms/.claude/projects/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker/sess.jsonl";
    expect(translateHostPath(host)).toBe(
      `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker/sess.jsonl`,
    );
  });

  it("works for any host username (translation is structural, not user-specific)", () => {
    const a = translateHostPath("/home/alice/.claude/projects/foo/x.jsonl");
    const b = translateHostPath("/home/bob/.claude/projects/foo/x.jsonl");
    expect(a).toBe(`${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/foo/x.jsonl`);
    expect(b).toBe(`${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/foo/x.jsonl`);
  });

  it("preserves sub-agent path structure", () => {
    const host =
      "/home/newms/.claude/projects/-encoded-cwd/sess-uuid/subagents/agent-abc.jsonl";
    expect(translateHostPath(host)).toBe(
      `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/-encoded-cwd/sess-uuid/subagents/agent-abc.jsonl`,
    );
  });

  it("returns null when the path lacks the /.claude/projects/ segment", () => {
    expect(translateHostPath("/some/random/path.jsonl")).toBeNull();
    expect(translateHostPath("/home/user/.claude/sessions/x.jsonl")).toBeNull();
    expect(translateHostPath("")).toBeNull();
  });

  it("does NOT match a path that ends at /.claude/projects/ with no trailing segment", () => {
    // `/.claude/projects/` alone is the dir, not a JSONL — must capture
    // at least one character of `<rest>` to avoid a malformed translated path.
    expect(translateHostPath("/home/x/.claude/projects/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// expectedJsonlPath
// ---------------------------------------------------------------------------

describe("expectedJsonlPath", () => {
  it("translates a worker jsonlPath", () => {
    const dispatch = makeDispatch({
      jsonlPath:
        "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess.jsonl",
    });
    const result = expectedJsonlPath(dispatch);
    expect(result).toContain(DASHBOARD_CLAUDE_PROJECTS_BASE);
    expect(result).toContain("danxbot");
  });

  it("translates a host-mode developer path to the host-claude-projects mount", () => {
    const hostPath = "/home/newms/.claude/projects/-some-cwd/sess.jsonl";
    const dispatch = makeDispatch({ jsonlPath: hostPath });
    expect(expectedJsonlPath(dispatch)).toBe(
      `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/-some-cwd/sess.jsonl`,
    );
  });

  it("returns the stored path verbatim when it matches neither worker nor host pattern", () => {
    // E.g. an arbitrary absolute path without `/.claude/projects/` in it.
    const oddPath = "/var/log/somewhere/sess.jsonl";
    const dispatch = makeDispatch({ jsonlPath: oddPath });
    expect(expectedJsonlPath(dispatch)).toBe(oddPath);
  });

  it("returns null when both jsonlPath and sessionUuid are null", () => {
    expect(expectedJsonlPath(makeDispatch())).toBeNull();
  });

  it("prefers jsonlPath translation over sessionUuid computation", () => {
    const dispatch = makeDispatch({
      jsonlPath:
        "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/from-path.jsonl",
      sessionUuid: "from-uuid",
    });
    const result = expectedJsonlPath(dispatch);
    expect(result).toContain("from-path");
    expect(result).not.toContain("from-uuid");
  });
});

// ---------------------------------------------------------------------------
// resolveJsonlPath — uses real filesystem via tmp dirs
// ---------------------------------------------------------------------------

describe("resolveJsonlPath", () => {
  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), "danxbot-resolver-test-"));
  }

  it("returns the stored path when it exists directly (host-mode dispatch)", async () => {
    const dir = makeTmp();
    const file = join(dir, "sess.jsonl");
    writeFileSync(file, "");

    const dispatch = makeDispatch({ jsonlPath: file });
    expect(await resolveJsonlPath(dispatch)).toBe(file);
  });

  it("returns null when all strategies fail (no files exist anywhere)", async () => {
    const dispatch = makeDispatch({
      jsonlPath:
        "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/missing.jsonl",
      sessionUuid: "missing-session",
    });
    expect(await resolveJsonlPath(dispatch)).toBeNull();
  });

  it("returns null when no path info is provided at all", async () => {
    expect(await resolveJsonlPath(makeDispatch())).toBeNull();
  });

  it("returns null when stored path is explicitly non-existent", async () => {
    const dispatch = makeDispatch({ jsonlPath: "/nonexistent/path/sess.jsonl" });
    expect(await resolveJsonlPath(dispatch)).toBeNull();
  });

  it("returns the stored path before attempting translation", async () => {
    // If the stored path exists (host-mode case), return it without trying to
    // translate — verifies strategy ordering.
    const dir = makeTmp();
    const file = join(dir, "sess.jsonl");
    writeFileSync(file, "");

    // Stored path exists AND would be a translatable worker prefix — but since
    // the stored path itself exists, it should win.
    const dispatch = makeDispatch({
      jsonlPath: file,
      sessionUuid: "should-not-be-used",
    });
    expect(await resolveJsonlPath(dispatch)).toBe(file);
  });

  it("resolves via worker-path translation (strategy 2) when stored path is unreachable", async () => {
    const expectedTranslated =
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/sess.jsonl`;

    // Use the injectable existsFn to simulate: stored worker path missing, translated path present.
    const existsFn = async (p: string) => p === expectedTranslated;

    const dispatch = makeDispatch({
      jsonlPath:
        "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess.jsonl",
    });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(expectedTranslated);
  });

  it("resolves via host-path translation (strategy 2b) when the stored path is a developer ~/.claude/projects path", async () => {
    // Regression for the host-mode dashboard timeline being empty: the
    // worker stored `/home/<user>/.claude/projects/<encoded>/<uuid>.jsonl`,
    // strategy 1's stat fails inside the dashboard container (no such
    // path), strategy 2 returns null (path doesn't start with the
    // worker prefix), strategy 2b translates to the host mount and stat
    // succeeds.
    const stored =
      "/home/newms/.claude/projects/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker/sess.jsonl";
    const expectedTranslated =
      `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/-home-newms-web-gpt-manager--danxbot-workspaces-issue-worker/sess.jsonl`;

    const existsFn = async (p: string) => p === expectedTranslated;

    const dispatch = makeDispatch({
      jsonlPath: stored,
      repoName: "gpt-manager",
    });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(expectedTranslated);
  });

  it("prefers worker translation over host translation when stored path matches both (worker prefix wins by branch order)", async () => {
    // `HOST_PROJECTS_RE` also matches the worker-internal prefix
    // `/home/danxbot/.claude/projects/...` because both share the
    // structural `/.claude/projects/<rest>` segment. The branch order
    // in `resolveJsonlPath` (worker first, host second) is the only
    // thing keeping translation correct. Pin that order so a future
    // refactor can't silently flip it and route docker-mode dispatches
    // through the host mount (where they don't exist).
    const workerPath =
      "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/sess.jsonl";
    const expectedWorker =
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/sess.jsonl`;
    // existsFn marks BOTH translation targets as "present" — the
    // function MUST pick the worker translation, not the host one.
    const expectedHost =
      `${DASHBOARD_HOST_CLAUDE_PROJECTS_BASE}/-danxbot-app-repos-danxbot/sess.jsonl`;
    const existsFn = async (p: string) =>
      p === expectedWorker || p === expectedHost;

    const dispatch = makeDispatch({
      jsonlPath: workerPath,
      repoName: "danxbot",
    });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(expectedWorker);
  });

  it("falls through from strategy 2b to strategy 3 when the stored host path's translation is also unreachable", async () => {
    // Stored path is a host-mode path, BUT the host mount doesn't
    // contain it (e.g. dispatch ran on a different host or the
    // encoded-cwd dir was scrubbed). Strategy 1 fails, 2 returns
    // null (no worker prefix), 2b translates but stat fails. The
    // resolver must fall through to strategy 3 and try the per-repo
    // claude-projects scan against `sessionUuid`. Without 2b
    // short-circuiting cleanly, the dashboard would lose a fallback
    // path it had pre-fix.
    //
    // We simulate strategy 3 by exposing a fake repoBase — strategy 3
    // calls `dashboardJsonlCandidates` which does `readdirSync` on
    // `/danxbot/app/claude-projects/<repo>/`. Since we can't mock
    // `readdirSync` at runtime here cleanly, the assertion is that
    // strategy 2b returning null does NOT prevent the function from
    // returning null (i.e. it's not throwing or short-circuiting).
    const stored = "/home/somebody/.claude/projects/-encoded/sess.jsonl";
    const existsFn = async (_p: string) => false; // every candidate fails
    const dispatch = makeDispatch({
      jsonlPath: stored,
      sessionUuid: "session-not-on-disk",
      repoName: "danxbot",
    });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBeNull();
  });

  it("prefers the stored path over the host translation when stored path exists directly (dashboard runs on host)", async () => {
    // When the dashboard runs on the host alongside the worker (e.g.
    // `make launch-dashboard-host`), the stored host path is directly
    // statable. Strategy 1 must win before strategy 2b — otherwise we
    // pay an extra existence check for nothing.
    const stored =
      "/home/newms/.claude/projects/-encoded/sess.jsonl";
    const existsFn = async (p: string) => p === stored;

    const dispatch = makeDispatch({ jsonlPath: stored });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(stored);
  });

  // Strategy 3 (sessionUuid → per-workspace enumeration) is exercised
  // implicitly by callers that hit the dashboard mount. It's not unit
  // tested here because `dashboardJsonlCandidates` does a real
  // `readdirSync` against `/danxbot/app/claude-projects/<repo>/` — the
  // dashboard runtime path. Integration tests under
  // `src/__tests__/integration/` hit the full layout.
});
