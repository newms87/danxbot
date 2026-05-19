/**
 * DX-701 — unit tests for `POST /api/test-isolation/pickup-prefix`.
 * Mirrors the `handleClearCriticalFailure` test shape: drive the handler
 * with a fake `req`/`res` pair, assert the resulting drift-file state
 * via `readSettings`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "node:stream";
import { handleSetPickupPrefix } from "./test-isolation-route.js";
import { readSettings, writeSettings } from "../settings-file.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

function fakeReq(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return stream as unknown as IncomingMessage;
}

function fakeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  let statusCode = 0;
  let payload: unknown = undefined;
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(text: string) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => payload,
  };
}

describe("handleSetPickupPrefix (DX-701)", () => {
  let localPath: string;
  let runtimeRoot: string;
  let priorRuntimeRoot: string | undefined;

  beforeEach(() => {
    localPath = mkdtempSync(resolve(tmpdir(), "danxbot-test-isolation-"));
    mkdirSync(resolve(localPath, ".danxbot"), { recursive: true });
    runtimeRoot = mkdtempSync(resolve(tmpdir(), "danxbot-runtime-root-"));
    priorRuntimeRoot = process.env.DANX_RUNTIME_ROOT;
    process.env.DANX_RUNTIME_ROOT = runtimeRoot;
  });

  afterEach(() => {
    if (priorRuntimeRoot === undefined) {
      delete process.env.DANX_RUNTIME_ROOT;
    } else {
      process.env.DANX_RUNTIME_ROOT = priorRuntimeRoot;
    }
    rmSync(localPath, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("writes a non-empty prefix to the drift-side testIsolation block", async () => {
    const { res, status, body } = fakeRes();
    await handleSetPickupPrefix(
      fakeReq({ prefix: "[System Test]" }),
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    expect(status()).toBe(200);
    expect(body()).toEqual({ pickupNamePrefix: "[System Test]" });
    const settings = readSettings(localPath);
    expect(settings.testIsolation?.pickupNamePrefix).toBe("[System Test]");
    // Contract file (overrides) untouched.
    expect(settings.overrides.issuePoller).toEqual({ enabled: null });
  });

  it("clears the prefix when null is passed", async () => {
    await writeSettings(localPath, {
      testIsolation: { pickupNamePrefix: "[seed]" },
      writtenBy: "setup",
    });
    const { res, status, body } = fakeRes();
    await handleSetPickupPrefix(
      fakeReq({ prefix: null }),
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    expect(status()).toBe(200);
    expect(body()).toEqual({ pickupNamePrefix: null });
    expect(readSettings(localPath).testIsolation?.pickupNamePrefix).toBeUndefined();
  });

  it("normalizes empty string to null (no filter active)", async () => {
    const { res, body } = fakeRes();
    await handleSetPickupPrefix(
      fakeReq({ prefix: "" }),
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    expect(body()).toEqual({ pickupNamePrefix: null });
  });

  it("rejects a non-string, non-null prefix with 400", async () => {
    const { res, status, body } = fakeRes();
    await handleSetPickupPrefix(
      fakeReq({ prefix: 42 }),
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    expect(status()).toBe(400);
    expect(body()).toEqual({ error: "prefix must be string or null" });
  });

  it("returns 400 on invalid JSON body", async () => {
    const stream = Readable.from(["not-json"]);
    const { res, status, body } = fakeRes();
    await handleSetPickupPrefix(
      stream as unknown as IncomingMessage,
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    expect(status()).toBe(400);
    expect(body()).toEqual({ error: "Invalid JSON body" });
  });

  it("does NOT clobber operator contract toggles", async () => {
    await writeSettings(localPath, {
      overrides: { issuePoller: { enabled: false } },
      writtenBy: "dashboard:op",
    });
    const { res } = fakeRes();
    await handleSetPickupPrefix(
      fakeReq({ prefix: "[X]" }),
      res,
      makeRepoContext({ localPath, name: "danxbot" }),
    );
    const settings = readSettings(localPath);
    expect(settings.overrides.issuePoller.enabled).toBe(false);
    expect(settings.testIsolation?.pickupNamePrefix).toBe("[X]");
  });
});
