import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Write a file only if its content differs from what's already on disk.
 * Returns `true` when a write actually happened. Used so worker-boot and
 * poller-tick calls stay idempotent on unchanged config without bumping
 * inode timestamps on every invocation (downstream watchers care).
 *
 * Lives in its own module so the poller's `injectDanxWorkspaces` helper
 * can reuse the primitive without dragging in the (deleted) singular
 * workspace generator.
 */
export function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    if (current === content) return false;
  }
  writeFileSync(path, content);
  return true;
}
