/**
 * DX-540 integration test — closes the loop with DX-539.
 *
 * Drops a fake `shared_deps_lock.json` under a local manifest dir,
 * runs the provisioner against it with a stubbed npm-install that
 * lays down a working `node_modules/.bin/vite` shim, then exercises
 * DX-539's `runTemplateBuild` against the provisioned deps dir end
 * to end. Asserts:
 *
 *   - the provisioner created `/<base>/<v>/node_modules/`
 *   - the provisioner wrote the snapshot file
 *   - DX-539's `deps_missing` gate sees the deps dir and passes
 *   - vite build succeeds against the provisioner's output
 *   - the tarball is PUT to the upstream URL
 *
 * The npm-install stub recreates what a real install would land —
 * just enough that the build endpoint's symlink + spawn flow works.
 * Real `npm install` against the npm registry would also work but
 * is too slow + flaky for CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { provisionSfcDeps } from "./provisioner.js";
import { createLocalManifestSource } from "./manifest-source.js";
import {
  runTemplateBuild,
  clearRecentBuilds,
  type TemplateBuildInput,
} from "../template-build/handler.js";
import { createTarballBuffer } from "../template-build/tarball.js";

describe("DX-540 ↔ DX-539 integration", () => {
  let workDir: string;
  let manifestDir: string;
  let baseDir: string;
  let scratchRoot: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sfc-int-"));
    manifestDir = join(workDir, "manifests");
    baseDir = join(workDir, "srv-sfc-deps");
    scratchRoot = join(workDir, "scratch");
    await mkdir(manifestDir, { recursive: true });
    await mkdir(baseDir, { recursive: true });
    await mkdir(scratchRoot, { recursive: true });
    clearRecentBuilds();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function installViteShim(targetDir: string): Promise<void> {
    const binDir = join(targetDir, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    // Stub vite — writes a dist/index.html so the handler's
    // file_count check finds it + the tarball create has content.
    await writeFile(
      join(binDir, "vite"),
      `#!/bin/sh
out="dist"
shift
while [ $# -gt 0 ]; do
  if [ "$1" = "--outDir" ]; then out="$2"; shift 2; else shift; fi
done
mkdir -p "$out"
echo "<html><body>from provisioned deps</body></html>" > "$out/index.html"
exit 0
`,
      { mode: 0o755 },
    );
  }

  async function makeSourceTarball(): Promise<Buffer> {
    const src = join(workDir, "src-fixture");
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "App.vue"),
      `<template><div>provisioned</div></template>\n`,
    );
    await writeFile(
      join(src, "package.json"),
      JSON.stringify({ name: "integration-template", version: "0.0.0" }),
    );
    return createTarballBuffer(src);
  }

  it("provisioner output satisfies DX-539's deps_missing gate and vite build round-trips", async () => {
    // 1. Publish a manifest under the local source dir.
    await mkdir(join(manifestDir, "1.0.0"), { recursive: true });
    await writeFile(
      join(manifestDir, "1.0.0", "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.13" } }),
    );

    // 2. Run the provisioner with a stubbed install that creates
    //    node_modules/.bin/vite. This is what `npm install --omit=dev`
    //    against `{vue: "3.5.13"}` would land at the .bin step.
    const source = createLocalManifestSource(manifestDir);
    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        await installViteShim(dir);
      },
    });
    expect(result.provisioned).toEqual(["1.0.0"]);
    expect(result.failed).toEqual([]);

    const depsDir = join(baseDir, "1.0.0", "node_modules");
    expect((await stat(depsDir)).isDirectory()).toBe(true);
    expect(
      (await stat(join(baseDir, "1.0.0", "shared_deps_lock.json"))).isFile(),
    ).toBe(true);
    expect((await stat(join(depsDir, ".bin", "vite"))).isFile()).toBe(true);

    // 3. Drive DX-539's runTemplateBuild against the provisioned deps.
    const sourceTar = await makeSourceTarball();
    const uploaded: Buffer[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("source")) {
        return new Response(new Uint8Array(sourceTar), { status: 200 });
      }
      if (u.includes("dist")) {
        if (init?.body instanceof Buffer) uploaded.push(init.body);
        else if (init?.body)
          uploaded.push(Buffer.from(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const input: TemplateBuildInput = {
      template_id: 1,
      build_id: "build-integration",
      source_get_url: "https://s3.example/source.tar.gz?sig=1",
      dist_put_url: "https://s3.example/dist.tar.gz?sig=2",
      shell_version: "1.0.0",
    };

    const outcome = await runTemplateBuild(input, {
      fetchImpl,
      resolveDepsDir: () => depsDir,
      scratchRoot,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.file_count).toBeGreaterThan(0);
      expect(outcome.build_id).toBe("build-integration");
    }
    expect(uploaded.length).toBe(1);
    expect(uploaded[0][0]).toBe(0x1f); // gzip magic
    expect(uploaded[0][1]).toBe(0x8b);
  });

  it("DX-539's deps_missing fires when DX-540 has not yet provisioned the requested shell_version", async () => {
    // No manifest published, no provisioner run. The base dir is
    // empty. DX-539 hits the gate and returns deps_missing.
    const sourceTar = await makeSourceTarball();
    const fetchImpl = (async (url: string | URL) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("source"))
        return new Response(new Uint8Array(sourceTar), { status: 200 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await runTemplateBuild(
      {
        template_id: 1,
        build_id: "build-deps-missing",
        source_get_url: "https://s3.example/source.tar.gz?sig=1",
        dist_put_url: "https://s3.example/dist.tar.gz?sig=2",
        shell_version: "9.9.9",
      },
      {
        fetchImpl,
        resolveDepsDir: (v) => join(baseDir, v, "node_modules"),
        scratchRoot,
      },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("deps_missing");
  });
});
