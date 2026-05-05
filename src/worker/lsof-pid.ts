import { execSync } from "node:child_process";

/**
 * Best-effort `lsof -i :<port>` PID lookup. Returns null when `lsof`
 * is unavailable, the port is unbound, or output is unparseable.
 * Shared by the restart route's old-PID guard and the finalizer's
 * new-PID resolution after `/health` 200.
 */
export function lsofPid(port: number): number | null {
  try {
    const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    })
      .toString()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (out.length === 0) return null;
    const pid = Number(out[0]);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
