import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  runTemplateBuild,
  validateBody,
  checkAuth,
  clearRecentBuilds,
  getRecentBuilds,
  handleTemplateBuild,
  handleRecentBuilds,
  type TemplateBuildInput,
  type TemplateBuildDeps,
} from "./handler.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { createTarballBuffer } from "./tarball.js";

/**
 * Build a fake shared-deps dir on disk with a stub `vite` binary that
 * mimics a successful build by writing dist/index.html.
 */
async function makeFakeDepsDir(root: string): Promise<string> {
  const depsDir = join(root, "deps", "node_modules");
  await mkdir(join(depsDir, ".bin"), { recursive: true });
  const viteBin = join(depsDir, ".bin", "vite");
  await writeFile(
    viteBin,
    `#!/bin/sh
# args: build --outDir dist
out="dist"
shift
while [ $# -gt 0 ]; do
  if [ "$1" = "--outDir" ]; then out="$2"; shift 2; else shift; fi
done
mkdir -p "$out"
echo "<html><body>built</body></html>" > "$out/index.html"
echo "fake vite build complete" 1>&2
exit 0
`,
    { mode: 0o755 },
  );
  return depsDir;
}

async function makeFakeFailingDepsDir(root: string): Promise<string> {
  const depsDir = join(root, "deps-fail", "node_modules");
  await mkdir(join(depsDir, ".bin"), { recursive: true });
  await writeFile(
    join(depsDir, ".bin", "vite"),
    `#!/bin/sh
echo "compile error in App.vue" 1>&2
exit 7
`,
    { mode: 0o755 },
  );
  return depsDir;
}

async function makeSourceTarball(root: string): Promise<Buffer> {
  const src = join(root, "src-fixture");
  await mkdir(src, { recursive: true });
  await writeFile(
    join(src, "App.vue"),
    `<template><div>hello</div></template>\n`,
  );
  await writeFile(
    join(src, "package.json"),
    JSON.stringify({ name: "fixture-template", version: "0.0.0" }),
  );
  return createTarballBuffer(src);
}

function makeFetchImpl(
  sourceTar: Buffer | null,
  options: { uploadFails?: boolean; sourceStatus?: number } = {},
): { fetchImpl: typeof fetch; uploaded: Buffer[] } {
  const uploaded: Buffer[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("source")) {
      if (options.sourceStatus && options.sourceStatus >= 400) {
        return new Response(null, {
          status: options.sourceStatus,
          statusText: "fail",
        });
      }
      if (!sourceTar) {
        throw new Error("source fetch was supposed to fail before this");
      }
      return new Response(new Uint8Array(sourceTar), { status: 200 });
    }
    if (u.includes("dist")) {
      if (init?.body instanceof Buffer) uploaded.push(init.body);
      else if (init?.body) uploaded.push(Buffer.from(init.body as Uint8Array));
      if (options.uploadFails) {
        return new Response(null, { status: 500, statusText: "S3 fail" });
      }
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, uploaded };
}

function makeInput(overrides: Partial<TemplateBuildInput> = {}): TemplateBuildInput {
  return {
    template_id: 42,
    build_id: "build-abc",
    source_get_url: "https://s3.example/source.tar.gz?sig=1",
    dist_put_url: "https://s3.example/dist.tar.gz?sig=2",
    shell_version: "1.0.0",
    ...overrides,
  };
}

describe("validateBody", () => {
  const wellFormed = {
    template_id: 1,
    build_id: "build-abc",
    source_get_url: "https://s3.example/source.tar.gz?sig=1",
    dist_put_url: "https://s3.example/dist.tar.gz?sig=2",
    shell_version: "1.0.0",
  };

  it("accepts a well-formed body", () => {
    expect(validateBody(wellFormed).ok).toBe(true);
  });

  it.each([
    ["build_id"],
    ["source_get_url"],
    ["dist_put_url"],
    ["shell_version"],
  ])("rejects missing %s", (field) => {
    const body: Record<string, unknown> = { ...wellFormed };
    delete body[field];
    const r = validateBody(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });

  it("rejects non-number template_id", () => {
    const r = validateBody({ ...wellFormed, template_id: "1" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object body", () => {
    expect(validateBody(null).ok).toBe(false);
    expect(validateBody("string").ok).toBe(false);
  });

  it.each(["build_id", "shell_version"])(
    "rejects unsafe characters in %s",
    (field) => {
      const r = validateBody({ ...wellFormed, [field]: "../etc/passwd" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(field);
    },
  );

  it.each([
    ["source_get_url"],
    ["dist_put_url"],
  ])("rejects non-https URL in %s", (field) => {
    const r = validateBody({ ...wellFormed, [field]: "http://internal/x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });

  it.each([
    ["source_get_url"],
    ["dist_put_url"],
  ])("rejects file:// URL in %s", (field) => {
    const r = validateBody({ ...wellFormed, [field]: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["source_get_url"],
    ["dist_put_url"],
  ])("rejects malformed URL in %s", (field) => {
    const r = validateBody({ ...wellFormed, [field]: "not-a-url" });
    expect(r.ok).toBe(false);
  });
});

describe("checkAuth", () => {
  it("passes when no token configured", () => {
    expect(checkAuth(undefined, undefined).ok).toBe(true);
    expect(checkAuth("Bearer anything", undefined).ok).toBe(true);
  });

  it("requires bearer when token configured", () => {
    const r = checkAuth(undefined, "secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("rejects wrong bearer", () => {
    const r = checkAuth("Bearer wrong", "secret");
    expect(r.ok).toBe(false);
  });

  it("accepts correct bearer", () => {
    expect(checkAuth("Bearer secret", "secret").ok).toBe(true);
  });

  it("rejects non-Bearer auth scheme", () => {
    const r = checkAuth("Basic xxx", "secret");
    expect(r.ok).toBe(false);
  });
});

describe("runTemplateBuild", () => {
  let workDir: string;
  let scratchRoot: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tbuild-test-"));
    scratchRoot = join(workDir, "scratch");
    await mkdir(scratchRoot, { recursive: true });
    clearRecentBuilds();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("happy path: round-trips source → dist with success response", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl, uploaded } = makeFetchImpl(sourceTar);

    const deps: TemplateBuildDeps = {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    };

    const outcome = await runTemplateBuild(makeInput(), deps);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.build_id).toBe("build-abc");
      expect(outcome.duration_ms).toBeGreaterThanOrEqual(0);
      expect(outcome.file_count).toBeGreaterThan(0);
    }
    expect(uploaded.length).toBe(1);
    expect(uploaded[0].length).toBeGreaterThan(0);
    expect(uploaded[0][0]).toBe(0x1f);
    expect(uploaded[0][1]).toBe(0x8b);
  });

  it("returns deps_missing when shared deps dir is absent", async () => {
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    const outcome = await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => join(workDir, "nope", "node_modules"),
      scratchRoot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("deps_missing");
  });

  it("returns source_download_failed on HTTP error", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const { fetchImpl } = makeFetchImpl(null, { sourceStatus: 403 });

    const outcome = await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("source_download_failed");
  });

  it("returns source_download_failed on malformed tarball", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const garbage = Buffer.from("not a tarball");
    const { fetchImpl } = makeFetchImpl(garbage);

    const outcome = await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("source_download_failed");
  });

  it("returns vite_build_failed when vite exits non-zero", async () => {
    const depsDir = await makeFakeFailingDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    const outcome = await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("vite_build_failed");
      expect(outcome.stderr).toContain("compile error");
    }
  });

  it("returns dist_upload_failed when PUT to S3 fails", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar, { uploadFails: true });

    const outcome = await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("dist_upload_failed");
  });

  it("cleans up scratch dir on success", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    const remaining = await readdir(scratchRoot);
    expect(remaining).toEqual([]);
  });

  it("cleans up scratch dir on vite failure", async () => {
    const depsDir = await makeFakeFailingDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    const remaining = await readdir(scratchRoot);
    expect(remaining).toEqual([]);
  });

  it("cleans up scratch dir on source download failure", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const { fetchImpl } = makeFetchImpl(null, { sourceStatus: 500 });

    await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    const remaining = await readdir(scratchRoot);
    expect(remaining).toEqual([]);
  });

  it("cleans up scratch dir on dist upload failure", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar, { uploadFails: true });

    await runTemplateBuild(makeInput(), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    const remaining = await readdir(scratchRoot);
    expect(remaining).toEqual([]);
  });

  it("appends every outcome to the recent-builds ring buffer", async () => {
    const depsDir = await makeFakeDepsDir(workDir);
    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    await runTemplateBuild(makeInput({ build_id: "b1" }), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });
    await runTemplateBuild(makeInput({ build_id: "b2" }), {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    const recent = getRecentBuilds();
    expect(recent.length).toBe(2);
    expect(recent.map((b) => b.build_id)).toEqual(["b1", "b2"]);
  });

  it("respects SFC_DEPS_BASE_DIR env override in defaultResolveDepsDir", async () => {
    const customBase = join(workDir, "custom-sfc-deps");
    const depsDir = join(customBase, "1.0.0", "node_modules");
    await mkdir(join(depsDir, ".bin"), { recursive: true });
    const viteBin = join(depsDir, ".bin", "vite");
    await writeFile(
      viteBin,
      `#!/bin/sh
mkdir -p dist
echo "<html><body>custom built</body></html>" > dist/index.html
echo "custom vite build complete" 1>&2
exit 0
`,
      { mode: 0o755 },
    );

    const sourceTar = await makeSourceTarball(workDir);
    const { fetchImpl } = makeFetchImpl(sourceTar);

    // Set the env var and verify it's honored
    const origEnv = process.env.SFC_DEPS_BASE_DIR;
    try {
      process.env.SFC_DEPS_BASE_DIR = customBase;

      const outcome = await runTemplateBuild(
        makeInput({ shell_version: "1.0.0" }),
        {
          fetchImpl,
          scratchRoot,
          // No resolveDepsDir override — should use defaultResolveDepsDir which reads the env
        },
      );

      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.file_count).toBeGreaterThan(0);
      }
    } finally {
      if (origEnv === undefined) {
        delete process.env.SFC_DEPS_BASE_DIR;
      } else {
        process.env.SFC_DEPS_BASE_DIR = origEnv;
      }
    }
  });

});

describe("handleTemplateBuild (HTTP shell)", () => {
  let savedSfcDepsBaseDir: string | undefined;

  beforeEach(() => {
    clearRecentBuilds();
    delete process.env.TEMPLATE_BUILD_TOKEN;
    // Isolate from SFC_DEPS_BASE_DIR in .env so the handler sees
    // deps_missing regardless of what the host has provisioned.
    savedSfcDepsBaseDir = process.env.SFC_DEPS_BASE_DIR;
    process.env.SFC_DEPS_BASE_DIR = "/does-not-exist-danxbot-test";
  });

  afterEach(() => {
    delete process.env.TEMPLATE_BUILD_TOKEN;
    if (savedSfcDepsBaseDir === undefined) {
      delete process.env.SFC_DEPS_BASE_DIR;
    } else {
      process.env.SFC_DEPS_BASE_DIR = savedSfcDepsBaseDir;
    }
  });

  it("returns 401 when TEMPLATE_BUILD_TOKEN is set and bearer missing", async () => {
    process.env.TEMPLATE_BUILD_TOKEN = "secret-x";

    const req = createMockReqWithBody("POST", {
      template_id: 1,
      build_id: "b",
      source_get_url: "https://s3.example/src.tar.gz",
      dist_put_url: "https://s3.example/dist.tar.gz",
      shell_version: "1.0.0",
    });
    const res = createMockRes();
    await handleTemplateBuild(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 401 when bearer is wrong", async () => {
    process.env.TEMPLATE_BUILD_TOKEN = "secret-x";
    const req = createMockReqWithBody("POST", {
      template_id: 1,
      build_id: "b",
      source_get_url: "https://s3.example/src.tar.gz",
      dist_put_url: "https://s3.example/dist.tar.gz",
      shell_version: "1.0.0",
    });
    req.headers.authorization = "Bearer wrong";
    const res = createMockRes();
    await handleTemplateBuild(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 400 on missing body fields", async () => {
    const req = createMockReqWithBody("POST", { build_id: "b" });
    const res = createMockRes();
    await handleTemplateBuild(req, res);

    expect(res._getStatusCode()).toBe(400);
    const body = JSON.parse(res._getBody());
    expect(body.error).toMatch(/required/);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = createMockReqWithBody("POST");
    // Inject raw garbage that the parser will reject.
    process.nextTick(() => {
      req.emit("data", Buffer.from("not json {"));
      req.emit("end");
    });
    const res = createMockRes();
    await handleTemplateBuild(req, res);

    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 200 + deps_missing JSON when deps absent (no token)", async () => {
    const req = createMockReqWithBody("POST", {
      template_id: 1,
      build_id: "b",
      source_get_url: "https://s3.example/src.tar.gz",
      dist_put_url: "https://s3.example/dist.tar.gz",
      shell_version: "1.0.0",
    });
    const res = createMockRes();
    await handleTemplateBuild(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body.ok).toBe(false);
    expect(body.error).toBe("deps_missing");
  });
});

describe("handleRecentBuilds (HTTP shell)", () => {
  beforeEach(() => {
    clearRecentBuilds();
    delete process.env.TEMPLATE_BUILD_TOKEN;
  });

  afterEach(() => {
    delete process.env.TEMPLATE_BUILD_TOKEN;
  });

  it("returns the recent-builds list when token is unset", async () => {
    const req = createMockReqWithBody("GET");
    const res = createMockRes();
    handleRecentBuilds(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ builds: [] });
  });

  it("returns 401 when token is set and bearer missing", async () => {
    process.env.TEMPLATE_BUILD_TOKEN = "secret-x";
    const req = createMockReqWithBody("GET");
    const res = createMockRes();
    handleRecentBuilds(req, res);

    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 200 when token is set and bearer matches", async () => {
    process.env.TEMPLATE_BUILD_TOKEN = "secret-x";
    const req = createMockReqWithBody("GET");
    req.headers.authorization = "Bearer secret-x";
    const res = createMockRes();
    handleRecentBuilds(req, res);

    expect(res._getStatusCode()).toBe(200);
  });
});

describe("runTemplateBuild — buffer cap", () => {
  let workDir: string;
  let scratchRoot: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tbuild-cap-test-"));
    scratchRoot = join(workDir, "scratch");
    await mkdir(scratchRoot, { recursive: true });
    clearRecentBuilds();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("caps the recent-builds buffer at 100", async () => {
    for (let i = 0; i < 105; i++) {
      // Use deps_missing branch so we don't pay for a real build per
      // iteration — the ring buffer accepts every outcome shape.
      await runTemplateBuild(makeInput({ build_id: `b${i}` }), {
        resolveDepsDir: () => join(workDir, "absent"),
        scratchRoot,
      });
    }
    const recent = getRecentBuilds();
    expect(recent.length).toBe(100);
    expect(recent[0].build_id).toBe("b5");
    expect(recent[99].build_id).toBe("b104");
  });
});
