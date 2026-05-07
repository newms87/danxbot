import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

const mockGetActiveJob = vi.fn();

vi.mock("./dispatch.js", () => ({
  getActiveJob: (...args: unknown[]) => mockGetActiveJob(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleRestage } from "./restage-route.js";

let tempRoot: string;

function makeRunningJob(stagingPaths: readonly string[], overlay: Record<string, string>) {
  return {
    id: "dispatch-x",
    status: "running",
    summary: "",
    startedAt: new Date(),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    stop: vi.fn(),
    restageContext: { stagingPaths, overlay },
  };
}

describe("handleRestage", () => {
  beforeEach(() => {
    mockGetActiveJob.mockReset();
    tempRoot = mkdtempSync(join(tmpdir(), "danxbot-restage-"));
  });

  it("404s when dispatch is unknown", async () => {
    mockGetActiveJob.mockReturnValueOnce(undefined);
    const req = createMockReqWithBody("POST", { staged_files: [] });
    const res = createMockRes();

    await handleRestage(req, res, "missing-dispatch");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("missing-dispatch");
  });

  it("404s when dispatch is terminal", async () => {
    mockGetActiveJob.mockReturnValueOnce({
      ...makeRunningJob([tempRoot + "/"], {}),
      status: "completed",
    });
    const req = createMockReqWithBody("POST", { staged_files: [] });
    const res = createMockRes();

    await handleRestage(req, res, "completed-dispatch");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("completed");
  });

  it("404s when job has no restage context", async () => {
    mockGetActiveJob.mockReturnValueOnce({
      ...makeRunningJob([tempRoot + "/"], {}),
      restageContext: undefined,
    });
    const req = createMockReqWithBody("POST", { staged_files: [] });
    const res = createMockRes();

    await handleRestage(req, res, "no-context");

    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("staging-paths");
  });

  it("400s when staged_files field is missing or non-array", async () => {
    mockGetActiveJob.mockReturnValueOnce(
      makeRunningJob([tempRoot + "/"], {}),
    );
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleRestage(req, res, "x");

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("staged_files");
  });

  it("returns 200 with restaged: 0 on empty payload", async () => {
    mockGetActiveJob.mockReturnValueOnce(
      makeRunningJob([tempRoot + "/"], {}),
    );
    const req = createMockReqWithBody("POST", { staged_files: [] });
    const res = createMockRes();

    await handleRestage(req, res, "x");

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ restaged: 0 });
  });

  it("writes a content-kind staged file under the allowlist root", async () => {
    const allowlistRoot = tempRoot + "/";
    mockGetActiveJob.mockReturnValueOnce(
      makeRunningJob([allowlistRoot], {}),
    );
    const targetPath = `${tempRoot}/schema.json`;
    const req = createMockReqWithBody("POST", {
      staged_files: [{ path: targetPath, content: '{"hello":"world"}' }],
    });
    const res = createMockRes();

    await handleRestage(req, res, "x");

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.restaged).toBe(1);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe('{"hello":"world"}');

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("substitutes placeholders against the stored overlay", async () => {
    const allowlistRoot = `${tempRoot}/schemas/42/`;
    mockGetActiveJob.mockReturnValueOnce(
      makeRunningJob([allowlistRoot], { SCHEMA_DEFINITION_ID: "42" }),
    );

    const req = createMockReqWithBody("POST", {
      staged_files: [
        {
          // Placeholder must be substituted to land under the allowlist.
          // Without substitution the ${SCHEMA_DEFINITION_ID} segment
          // would reject as a literal string mismatch.
          path: `${tempRoot}/schemas/\${SCHEMA_DEFINITION_ID}/blueprints/3.json`,
          content: "{}",
        },
      ],
    });
    const res = createMockRes();

    await handleRestage(req, res, "x");

    expect(res._getStatusCode()).toBe(200);
    const written = JSON.parse(res._getBody()).paths[0];
    expect(written).toBe(`${tempRoot}/schemas/42/blueprints/3.json`);
    expect(existsSync(written)).toBe(true);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("400s when a path escapes the allowlist", async () => {
    mockGetActiveJob.mockReturnValueOnce(
      makeRunningJob([`${tempRoot}/schemas/42/`], {}),
    );

    const req = createMockReqWithBody("POST", {
      staged_files: [
        {
          path: `${tempRoot}/schemas/42/../../../etc/passwd`,
          content: "x",
        },
      ],
    });
    const res = createMockRes();

    await handleRestage(req, res, "x");

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toBeTruthy();

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
