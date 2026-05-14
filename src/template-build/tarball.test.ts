import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";

import {
  extractTarballToDir,
  createTarballBuffer,
  countTarballFiles,
  TarballError,
} from "./tarball.js";

describe("tarball helpers", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tarball-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("createTarballBuffer", () => {
    it("packs a directory into a gzipped tarball", async () => {
      const src = join(workDir, "src");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "index.html"), "<html></html>");
      await mkdir(join(src, "nested"), { recursive: true });
      await writeFile(join(src, "nested", "app.js"), "console.log('x');");

      const buf = await createTarballBuffer(src);
      expect(buf.length).toBeGreaterThan(0);
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it("throws TarballError when source dir does not exist", async () => {
      await expect(
        createTarballBuffer(join(workDir, "missing")),
      ).rejects.toBeInstanceOf(TarballError);
    });
  });

  describe("extractTarballToDir + round-trip", () => {
    it("round-trips a directory through tarball create + extract", async () => {
      const src = join(workDir, "src");
      const dest = join(workDir, "dest");
      await mkdir(src, { recursive: true });
      await mkdir(dest, { recursive: true });
      await writeFile(join(src, "a.txt"), "alpha");
      await mkdir(join(src, "sub"), { recursive: true });
      await writeFile(join(src, "sub", "b.txt"), "beta");

      const buf = await createTarballBuffer(src);
      await extractTarballToDir(Readable.from(buf), dest);

      expect((await readFile(join(dest, "a.txt"))).toString()).toBe("alpha");
      expect((await readFile(join(dest, "sub", "b.txt"))).toString()).toBe(
        "beta",
      );
    });

    it("throws TarballError on malformed tar input", async () => {
      const dest = join(workDir, "dest");
      await mkdir(dest, { recursive: true });
      const garbage = Buffer.from("not actually a tarball");

      await expect(
        extractTarballToDir(Readable.from(garbage), dest),
      ).rejects.toBeInstanceOf(TarballError);
    });
  });

  describe("countTarballFiles", () => {
    it("counts regular files (not directories)", async () => {
      const src = join(workDir, "src");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "a.txt"), "alpha");
      await writeFile(join(src, "b.txt"), "beta");
      await mkdir(join(src, "sub"), { recursive: true });
      await writeFile(join(src, "sub", "c.txt"), "gamma");

      const buf = await createTarballBuffer(src);
      const count = await countTarballFiles(buf);

      expect(count).toBe(3);
    });
  });
});
