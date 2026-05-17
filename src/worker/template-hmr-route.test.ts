import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { handleTemplateHmrActive } from "./template-hmr-route.js";
import {
  acquireHmrServer,
  shutdownAllHmr,
  clearHmrStateForTesting,
} from "../template-hmr/server.js";

interface FakeRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: "",
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body ?? "";
    },
  };
  return res;
}

async function writeFakeVite(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const body = `#!/bin/sh
echo "VITE v5.0.0 ready in 5 ms"
trap "exit 0" TERM INT
while true; do sleep 0.1; done
`;
  await writeFile(join(binDir, "vite"), body, { mode: 0o755 });
}

describe("handleTemplateHmrActive", () => {
  let workDir: string;
  let depsBase: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hmr-route-test-"));
    depsBase = join(workDir, "deps");
    await writeFakeVite(join(depsBase, "1.0.0", "node_modules", ".bin"));
  });

  afterEach(async () => {
    await shutdownAllHmr();
    clearHmrStateForTesting();
    await rm(workDir, { recursive: true, force: true });
  });

  async function ensureEntry(templateId: string, dispatchId: string): Promise<number> {
    const dir = join(workDir, "schemas", "1", "templates", templateId, "source");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.ts"), "// route test\n");
    const info = await acquireHmrServer({
      templateId,
      sourceDir: dir,
      dispatchId,
      depsBaseDir: depsBase,
      shellVersion: "1.0.0",
      publicHost: "localhost",
    });
    return info.port;
  }

  it("returns 200 + {url, port, templateId, refDispatchIds[]} for a live entry", async () => {
    const port = await ensureEntry("11", "d-1");
    const res = fakeRes();
    handleTemplateHmrActive(
      {
        url: "/api/template-hmr/active?templateId=11",
      } as unknown as import("http").IncomingMessage,
      res as unknown as import("http").ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.templateId).toBe("11");
    expect(body.port).toBe(port);
    expect(body.url).toBe(`http://localhost:${port}/`);
    expect(body.refDispatchIds).toEqual(["d-1"]);
  });

  it("returns 404 when no entry exists for the templateId", async () => {
    const res = fakeRes();
    handleTemplateHmrActive(
      { url: "/api/template-hmr/active?templateId=999" } as unknown as import("http").IncomingMessage,
      res as unknown as import("http").ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain("999");
  });

  it("returns 400 when templateId is non-numeric", async () => {
    const res = fakeRes();
    handleTemplateHmrActive(
      { url: "/api/template-hmr/active?templateId=abc" } as unknown as import("http").IncomingMessage,
      res as unknown as import("http").ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 200 + list of all active entries when templateId is omitted", async () => {
    await ensureEntry("11", "d-1");
    await ensureEntry("22", "d-1");
    const res = fakeRes();
    handleTemplateHmrActive(
      { url: "/api/template-hmr/active" } as unknown as import("http").IncomingMessage,
      res as unknown as import("http").ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.active.map((e: { templateId: string }) => e.templateId).sort()).toEqual(["11", "22"]);
  });
});
