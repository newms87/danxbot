import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CLAUDE_PROJECTS_BASE,
  encodeRepoCwd,
  computeDashboardJsonlPath,
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

// ---------------------------------------------------------------------------
// encodeRepoCwd
// ---------------------------------------------------------------------------

describe("encodeRepoCwd", () => {
  it("encodes danxbot CWD", () => {
    expect(encodeRepoCwd("danxbot")).toBe("-danxbot-app-repos-danxbot");
  });

  it("encodes gpt-manager CWD", () => {
    expect(encodeRepoCwd("gpt-manager")).toBe("-danxbot-app-repos-gpt-manager");
  });

  it("encodes platform CWD", () => {
    expect(encodeRepoCwd("platform")).toBe("-danxbot-app-repos-platform");
  });
});

// ---------------------------------------------------------------------------
// computeDashboardJsonlPath
// ---------------------------------------------------------------------------

describe("computeDashboardJsonlPath", () => {
  it("produces the expected deterministic path", () => {
    const path = computeDashboardJsonlPath("danxbot", "abc-123-session");
    expect(path).toBe(
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/abc-123-session.jsonl`,
    );
  });

  it("namespaces by repoName so different repos don't collide", () => {
    const a = computeDashboardJsonlPath("danxbot", "uuid");
    const b = computeDashboardJsonlPath("gpt-manager", "uuid");
    expect(a).not.toBe(b);
    expect(a).toContain("/danxbot/");
    expect(b).toContain("/gpt-manager/");
  });
});

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

  it("falls back to stored path when it does not match worker prefix (host-mode)", () => {
    const hostPath = "/home/newms/.claude/projects/-some-cwd/sess.jsonl";
    const dispatch = makeDispatch({ jsonlPath: hostPath });
    expect(expectedJsonlPath(dispatch)).toBe(hostPath);
  });

  it("computes from sessionUuid when jsonlPath is null", () => {
    const dispatch = makeDispatch({ sessionUuid: "my-session-uuid" });
    const result = expectedJsonlPath(dispatch);
    expect(result).toBe(
      `${DASHBOARD_CLAUDE_PROJECTS_BASE}/danxbot/-danxbot-app-repos-danxbot/my-session-uuid.jsonl`,
    );
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

  it("resolves via sessionUuid computation (strategy 3) when prior strategies fail", async () => {
    const sessionUuid = "my-fallback-session";
    const expectedComputed = computeDashboardJsonlPath("danxbot", sessionUuid);

    // Use the injectable existsFn to simulate: only the computed path exists.
    const existsFn = async (p: string) => p === expectedComputed;

    // jsonlPath is null — only sessionUuid is available
    const dispatch = makeDispatch({ sessionUuid });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(expectedComputed);
  });

  it("falls back to sessionUuid (strategy 3) when jsonlPath is set but stored+translated paths are absent", async () => {
    // jsonlPath is set, so strategies 1 (stored) and 2 (translated worker path) are both
    // attempted and both fail. Strategy 3 (sessionUuid computation) should win.
    const sessionUuid = "uuid-only-strategy-3-works";
    const expectedComputed = computeDashboardJsonlPath("danxbot", sessionUuid);

    const existsFn = async (p: string) => p === expectedComputed;

    const dispatch = makeDispatch({
      jsonlPath:
        "/home/danxbot/.claude/projects/-danxbot-app-repos-danxbot/old-path.jsonl",
      sessionUuid,
    });
    expect(await resolveJsonlPath(dispatch, existsFn)).toBe(expectedComputed);
  });
});
