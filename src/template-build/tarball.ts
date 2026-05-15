/**
 * Tarball helpers used by the template-build pipeline (DX-539).
 *
 * Shells out to the host `tar` binary — system GNU tar is present on every
 * supported danxbot host and the streaming semantics are friendlier than
 * any pure-JS impl. Source extraction reads from a stream (presigned-S3
 * fetch body); dist creation writes the gzipped tarball into a Buffer so
 * it can be PUT to S3 in one call.
 */

import { spawn } from "child_process";
import type { Readable } from "stream";

export class TarballError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
    this.name = "TarballError";
  }
}

/**
 * Stream a gzipped tarball into `destDir`. The caller-supplied `source` is
 * piped into `tar -xz`'s stdin; the destination directory must exist.
 */
export async function extractTarballToDir(
  source: Readable,
  destDir: string,
): Promise<void> {
  // Defense-in-depth against malicious tarball payloads:
  // --no-overwrite-dir   — refuse to replace an existing dir with a non-dir.
  // --no-same-owner      — never honor uid/gid in archive headers.
  // --no-same-permissions — drop suid/sgid bits.
  // GNU tar additionally strips leading "/" from member names by default
  // and rejects paths containing ".." since ~2007.
  const child = spawn(
    "tar",
    [
      "-xz",
      "--no-overwrite-dir",
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      destDir,
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  source.pipe(child.stdin);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // If the source stream errors before tar finishes, kill the child so
    // its file descriptors are released — otherwise a half-piped tar
    // would keep its stdin open until the parent process exits.
    source.on("error", (err) => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      settle(() =>
        reject(
          new TarballError(
            `tar -xz source stream error: ${err instanceof Error ? err.message : String(err)}`,
            stderr,
          ),
        ),
      );
    });

    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      if (code === 0) settle(() => resolve());
      else
        settle(() =>
          reject(new TarballError(`tar -xz exited with code ${code}`, stderr)),
        );
    });
  });
}

/**
 * Create a gzipped tarball of `srcDir` (recursively) and return the bytes
 * as a Buffer.
 *
 * Member names are stored WITHOUT a `./` prefix (`--transform 's,^\./,,'`).
 * PHP's PharData — which gpt-manager's SfcBuildTransport uses to read the
 * dist tarball back — silently iterates ZERO entries when archive members
 * carry the `./` prefix that `tar -cz -C srcDir .` produces by default,
 * so `index.html` lookup never matches and extraction fails with the
 * cryptic "missing index.html — invalid bundle" (SG-174). The transform
 * strips the prefix at tar-write time; the surviving `./` directory entry
 * is harmless because consumers iterate file entries only.
 */
export async function createTarballBuffer(srcDir: string): Promise<Buffer> {
  const child = spawn(
    "tar",
    ["-cz", "--transform", "s,^\\./,,", "-C", srcDir, "."],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const chunks: Buffer[] = [];
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new TarballError(`tar -cz exited with code ${code}`, stderr));
    });
  });
}

/**
 * Count the regular files inside a gzipped tarball. Used for the success
 * response's `file_count` field — cheap sanity number for the orchestrator
 * to confirm the build actually produced output.
 */
export async function countTarballFiles(buf: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tz"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let listing = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      listing += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new TarballError(`tar -tz exited with code ${code}`, stderr));
        return;
      }
      const lines = listing.split("\n").filter((l) => l && !l.endsWith("/"));
      resolve(lines.length);
    });

    child.stdin.end(buf);
  });
}
