import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage } from "http";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

const mockReadSettings = vi.fn();
const mockWriteSettings = vi.fn();

vi.mock("../settings-file.js", async () => {
  const actual = await vi.importActual<typeof import("../settings-file.js")>(
    "../settings-file.js",
  );
  return {
    ...actual,
    readSettings: (...args: unknown[]) => mockReadSettings(...args),
    writeSettings: (...args: unknown[]) => mockWriteSettings(...args),
    DASHBOARD_PREFIX: "dashboard:",
  };
});

vi.mock("../critical-failure.js", () => ({
  readFlag: vi.fn().mockReturnValue(null),
}));

const mockCountDispatchesByRepo = vi.fn().mockResolvedValue({});
vi.mock("./dispatches-db.js", () => ({
  countDispatchesByRepo: (...args: unknown[]) =>
    mockCountDispatchesByRepo(...args),
  findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
  agentBusyOn: vi.fn().mockResolvedValue(new Map()),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: { publish: (...args: unknown[]) => mockEventBusPublish(...args) },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../issue-tracker/load-issue-prefix.js", () => ({
  loadIssuePrefix: vi.fn().mockReturnValue("ISS"),
}));

vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t) return { ok: false, status: 401 };
    if (!t.startsWith("user-")) return { ok: false, status: 401 };
    return {
      ok: true,
      user: { userId: 1, username: t.slice("user-".length) },
    };
  },
}));

import { handlePatchEffortSettings } from "./agents-effort.js";
import {
  DEFAULT_EFFORT_LEVELS,
  DEFAULT_EFFORT_ASSIGNMENT_PROMPT,
  type EffortLevelMapping,
} from "../settings-file.js";
import { deps, settings } from "./agents-test-fixtures.js";

const VALID_LEVELS: EffortLevelMapping[] = DEFAULT_EFFORT_LEVELS.map((r) => ({
  ...r,
}));

function fullSettings() {
  return {
    ...settings(),
    effortLevels: VALID_LEVELS.map((r) => ({ ...r })),
    effortAssignmentPrompt: DEFAULT_EFFORT_ASSIGNMENT_PROMPT,
    agents: {},
  };
}

function authReq(
  body: Record<string, unknown>,
  token = "user-newms87",
): IncomingMessage {
  const req = createMockReqWithBody("PATCH", body);
  (req.headers as Record<string, string>)["authorization"] = `Bearer ${token}`;
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadSettings.mockReturnValue(fullSettings());
  mockCountDispatchesByRepo.mockResolvedValue({});
});

describe("handlePatchEffortSettings — auth + repo lookup", () => {
  it("returns 401 when the bearer token is missing", async () => {
    const req = createMockReqWithBody("PATCH", { effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 401 when a non-user (dispatch) token is supplied", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS }, "test-dispatch-token");
    const res = createMockRes();
    await handlePatchEffortSettings(
      req,
      res,
      "danxbot",
      deps({ token: "test-dispatch-token" }),
    );

    expect(res._getStatusCode()).toBe(401);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown repo", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "nonexistent", deps());

    expect(res._getStatusCode()).toBe(404);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const req = createMockReqWithBody("PATCH", {});
    req.headers = { authorization: "Bearer user-newms87" };
    Object.defineProperty(req, "read", { value: () => null });
    setTimeout(() => {
      req.emit("data", Buffer.from("not json"));
      req.emit("end");
    }, 0);
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });
});

describe("handlePatchEffortSettings — body validation", () => {
  it("returns 400 when the body contains neither effortLevels nor effortAssignmentPrompt", async () => {
    const req = authReq({});
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels is not an array", async () => {
    const req = authReq({ effortLevels: "not-an-array" });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels has fewer than 7 entries", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS.slice(0, 6) });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels has more than 7 entries", async () => {
    const tooMany = [...VALID_LEVELS, { name: "extra", model: "m", effort: "e" }];
    const req = authReq({ effortLevels: tooMany });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].name is wrong / out of canonical order", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    bad[0] = { ...bad[0], name: "medium" };
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].model is empty", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    bad[3] = { ...bad[3], model: "" };
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].effort is empty / non-string", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    bad[2] = { ...bad[2], effort: "" };
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].model is a non-string (number)", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    (bad[1] as unknown as { model: unknown }).model = 42;
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/model/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].effort is a non-string (null)", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    (bad[5] as unknown as { effort: unknown }).effort = null;
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/effort/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortLevels[i].name has whitespace / wrong casing (strict equality, no normalization)", async () => {
    const bad = VALID_LEVELS.map((r) => ({ ...r }));
    (bad[4] as unknown as { name: string }).name = " high";
    const req = authReq({ effortLevels: bad });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/canonical/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortAssignmentPrompt is not a string", async () => {
    const req = authReq({ effortAssignmentPrompt: 42 });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when effortAssignmentPrompt exceeds the hot-path cap", async () => {
    const req = authReq({ effortAssignmentPrompt: "x".repeat(40_000) });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/too long/);
    expect(mockWriteSettings).not.toHaveBeenCalled();
  });
});

describe("handlePatchEffortSettings — mutation + SSE emit", () => {
  it("writes the effortLevels array on a valid PATCH", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    const [localPath, patch] = mockWriteSettings.mock.calls[0];
    expect(localPath).toBe("/repos/danxbot");
    expect(patch).toEqual({
      effortLevels: VALID_LEVELS,
      writtenBy: "dashboard:newms87",
    });
    expect(res._getStatusCode()).toBe(200);
  });

  it("writes the effortAssignmentPrompt on a valid PATCH", async () => {
    const req = authReq({ effortAssignmentPrompt: "Use min for the easiest cards." });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch).toEqual({
      effortAssignmentPrompt: "Use min for the easiest cards.",
      writtenBy: "dashboard:newms87",
    });
    expect(res._getStatusCode()).toBe(200);
  });

  it("accepts both fields in one PATCH", async () => {
    const req = authReq({
      effortLevels: VALID_LEVELS,
      effortAssignmentPrompt: "Custom prompt.",
    });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch).toEqual({
      effortLevels: VALID_LEVELS,
      effortAssignmentPrompt: "Custom prompt.",
      writtenBy: "dashboard:newms87",
    });
  });

  it("accepts effortAssignmentPrompt: '' as the reset-to-default affordance", async () => {
    const req = authReq({ effortAssignmentPrompt: "" });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.effortAssignmentPrompt).toBe("");
  });

  it("publishes agent:updated with the refreshed snapshot after a successful write", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const [event] = mockEventBusPublish.mock.calls[0];
    expect(event.topic).toBe("agent:updated");
    expect(event.data.name).toBe("danxbot");
    expect(event.data.settings.effortLevels).toEqual(VALID_LEVELS);
  });

  it("records the operator's username in writtenBy", async () => {
    const req = authReq({ effortLevels: VALID_LEVELS }, "user-dan");
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    const [, patch] = mockWriteSettings.mock.calls[0];
    expect(patch.writtenBy).toBe("dashboard:dan");
  });

  it("returns 500 when writeSettings throws", async () => {
    mockWriteSettings.mockRejectedValueOnce(new Error("disk full"));
    const req = authReq({ effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(500);
  });

  it("still returns 200 when countDispatchesByRepo rejects (post-write degradation path)", async () => {
    mockCountDispatchesByRepo.mockRejectedValueOnce(new Error("db gone"));
    const req = authReq({ effortLevels: VALID_LEVELS });
    const res = createMockRes();
    await handlePatchEffortSettings(req, res, "danxbot", deps());

    expect(res._getStatusCode()).toBe(200);
    expect(mockWriteSettings).toHaveBeenCalledTimes(1);
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(res._getBody());
    expect(snapshot.counts).toEqual({
      total: { total: 0, slack: 0, trello: 0, api: 0 },
      last24h: { total: 0, slack: 0, trello: 0, api: 0 },
      today: { total: 0, slack: 0, trello: 0, api: 0 },
    });
  });
});
