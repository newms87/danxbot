import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { Readable } from "stream";

import {
  extractTarballToDir,
  createTarballBuffer,
  countTarballFiles,
  TarballError,
} from "./tarball.js";

/**
 * List entry names inside a gzipped tarball via `tar -tz`. Returned
 * names are exactly the strings tar wrote to each member's header — the
 * regression assertion below checks that NONE of them carry a `./`
 * prefix, because PHP's PharData (which gpt-manager uses to extract the
 * dist tarball) silently iterates ZERO entries when members are stored
 * with that prefix (SG-174).
 */
async function listTarballEntries(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tz"], { stdio: ["pipe", "pipe", "pipe"] });
    let listing = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (listing += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tar -tz exited ${code}: ${stderr}`));
        return;
      }
      resolve(listing.split("\n").filter((l) => l.length > 0));
    });
    child.stdin.end(buf);
  });
}

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

    /**
     * SG-174 regression. Production failure mode: tar entries written as
     * `./index.html` are invisible to PHP's PharData, so gpt-manager's
     * SfcBuildTransport::extractDistTarball iterates zero entries and
     * throws "missing index.html — invalid bundle". Strip the prefix at
     * tar-write time so PharData enumerates the members.
     */
    it("stores file entries WITHOUT a leading './' prefix (SG-174)", async () => {
      const src = join(workDir, "src-sg174");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "index.html"), "<html></html>");
      await mkdir(join(src, "assets"), { recursive: true });
      await writeFile(join(src, "assets", "app.js"), "x");

      const buf = await createTarballBuffer(src);
      const entries = await listTarballEntries(buf);
      const fileEntries = entries.filter((e) => !e.endsWith("/"));

      expect(fileEntries).toContain("index.html");
      expect(fileEntries).toContain("assets/app.js");
      for (const entry of fileEntries) {
        expect(entry).not.toMatch(/^\.\//);
      }
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
