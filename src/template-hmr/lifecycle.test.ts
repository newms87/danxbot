import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  startTemplateHmrForDispatch,
  stopTemplateHmrForDispatch,
} from "./lifecycle.js";
import {
  listActiveHmr,
  shutdownAllHmr,
  clearHmrStateForTesting,
} from "./server.js";

async function writeFakeVite(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  const body = `#!/bin/sh
echo "VITE v5.0.0 ready in 5 ms"
trap "exit 0" TERM INT
while true; do sleep 0.1; done
`;
  await writeFile(join(binDir, "vite"), body, { mode: 0o755 });
}

describe("template-hmr lifecycle", () => {
  let workDir: string;
  let depsBase: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hmr-lifecycle-test-"));
    depsBase = join(workDir, "deps");
    await writeFakeVite(join(depsBase, "1.0.0", "node_modules", ".bin"));
  });

  afterEach(async () => {
    await shutdownAllHmr();
    clearHmrStateForTesting();
    await rm(workDir, { recursive: true, force: true });
  });

  async function makeSource(sid: number, tid: number): Promise<string> {
    const dir = join(
      workDir,
      "schemas",
      String(sid),
      "templates",
      String(tid),
      "source",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.ts"), "// SG-189 lifecycle test\n");
    return dir;
  }

  it("no-ops when stagedFilePaths contain no template/source segments", async () => {
    const started = await startTemplateHmrForDispatch({
      dispatchId: "d-1",
      stagedFilePaths: [
        "/tmp/schemas/9/schema.json",
        "/tmp/schemas/9/annotations/notes.json",
      ],
    });
    expect(started).toEqual([]);
    expect(listActiveHmr()).toHaveLength(0);
  });

  it("starts one HMR entry per distinct templateId in the staged paths", async () => {
    const srcA = await makeSource(9, 11);
    const srcB = await makeSource(9, 22);
    const started = await startTemplateHmrForDispatch({
      dispatchId: "d-1",
      stagedFilePaths: [
        `${srcA}/App.vue`,
        `${srcA}/main.ts`,
        `${srcB}/App.vue`,
      ],
      acquireOverrides: {
        depsBaseDir: depsBase,
        shellVersion: "1.0.0",
      },
    });
    expect(started.map((e) => e.templateId).sort()).toEqual(["11", "22"]);
    expect(listActiveHmr()).toHaveLength(2);
  });

  it("stopTemplateHmrForDispatch drops the dispatch's refs from every entry; entries STAY ALIVE for idle-TTL reuse", async () => {
    const srcA = await makeSource(9, 11);
    const srcB = await makeSource(9, 22);
    await startTemplateHmrForDispatch({
      dispatchId: "d-1",
      stagedFilePaths: [`${srcA}/App.vue`, `${srcB}/App.vue`],
      acquireOverrides: { depsBaseDir: depsBase, shellVersion: "1.0.0" },
    });
    expect(listActiveHmr()).toHaveLength(2);

    await stopTemplateHmrForDispatch("d-1");
    const after = listActiveHmr();
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.refDispatchIds.length === 0)).toBe(true);
  });

  it("stop is idempotent — double-call on the same dispatchId does not throw", async () => {
    const src = await makeSource(9, 11);
    await startTemplateHmrForDispatch({
      dispatchId: "d-1",
      stagedFilePaths: [`${src}/App.vue`],
      acquireOverrides: { depsBaseDir: depsBase, shellVersion: "1.0.0" },
    });
    await stopTemplateHmrForDispatch("d-1");
    await stopTemplateHmrForDispatch("d-1");
    // Entry still alive (refs empty); idempotent stop is safe.
    expect(listActiveHmr()).toHaveLength(1);
    expect(listActiveHmr()[0].refDispatchIds).toEqual([]);
  });

  it("a per-template acquire failure does NOT block siblings (warn + continue)", async () => {
    // Genuine failure isolation: point the depsBaseDir at a path that
    // exists for one shellVersion but NOT another. Then arrange the
    // SECOND template's source dir to need a DIFFERENT shell version —
    // impossible with the current API surface, so instead we exercise
    // a process-level env failure for ONE call by forcing the fake vite
    // to crash mid-startup. The two template IDs share the same deps
    // base, so we make template 22's source dir lack the vite binary
    // entry it needs by giving it a NESTED bogus path that doesn't
    // align with the symlink target.
    const srcA = await makeSource(9, 11);
    const srcB = await makeSource(9, 22);

    // Pre-symlink a BROKEN node_modules into srcB so the dispatch's
    // `acquire` finds a node_modules but vite isn't reachable.
    await writeFile(join(srcB, "main.ts"), "// genuine fail target\n");
    const { symlink: nodeSymlink } = await import("fs/promises");
    await nodeSymlink(
      "/nonexistent-deps-path",
      join(srcB, "node_modules"),
      "dir",
    );

    const started = await startTemplateHmrForDispatch({
      dispatchId: "d-1",
      stagedFilePaths: [`${srcA}/App.vue`, `${srcB}/App.vue`],
      acquireOverrides: {
        depsBaseDir: depsBase,
        shellVersion: "1.0.0",
        readyTimeoutMs: 2_000,
      },
    });

    // Template A succeeded; B failed without taking A down.
    expect(started.map((e) => e.templateId)).toEqual(["11"]);
    expect(listActiveHmr().map((e) => e.templateId)).toEqual(["11"]);
  });
});
