import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * DX-227 — repo-level guard for the "no client-side polling for server
 * state" rule (`.claude/rules/dashboard.md` § Real-time Updates Are
 * Mandatory). Server state flows through `/api/stream` (SSE) into the
 * composables that subscribe via `useStream`. A `setInterval` inside a
 * composable is the canonical regression signal — pre-DX-226 every
 * server-state composable owned its own 30s reload tick.
 *
 * Two surfaces are swept:
 *
 *   - `dashboard/src/composables/*.ts` (the canonical server-state
 *     layer — useDispatches, useAgents, useIssues, etc.)
 *   - `dashboard/src/components/**\/*.vue` (components could regress
 *     too — `CriticalFailureBanner.vue` has a legitimate cosmetic
 *     countdown; a future panel doing `setInterval(() => fetchFoo())`
 *     must NOT slip through).
 *
 * Two checks per file:
 *
 *   1. `setInterval(` — banned outright unless the file is on the
 *      cosmetic-timer allowlist (currently `useNowTick.ts` +
 *      `CriticalFailureBanner.vue`). Allowlisted files are subjected
 *      to a static-OR-dynamic api-import lock: a cosmetic timer that
 *      ever reaches into `api.ts` becomes polling.
 *   2. `setTimeout(... fetch|reload|refresh|poll ...)` — banned in
 *      every swept file. Legitimate `setTimeout` uses (SSE reconnect
 *      backoff in `useStream.ts`, debounce) don't match the verb list;
 *      a deferred reload call does.
 *
 * Dual-layer rationale: each server-state composable still carries its
 * own per-file source-check (`useDispatches.test.ts:183`,
 * `useAgents.test.ts:239`, `useIssues.test.ts:229`). The per-file
 * checks give the composable author an immediate, file-local failure
 * message; this directory-level sweep catches new composables nobody
 * remembered to lock down. Removing either layer reduces signal.
 */

const SWEEP_ROOT = resolve(__dirname, "..");
const COMPOSABLES_DIR = join(SWEEP_ROOT, "composables");
const COMPONENTS_DIR = join(SWEEP_ROOT, "components");

// Files allowed to call setInterval. The set is conditional: each
// allowlisted file must ALSO be free of any `api.ts` import (static
// or dynamic). A cosmetic timer that ever fetches becomes polling.
const SETINTERVAL_EXEMPT_FILES = new Set<string>([
  "useNowTick.ts",
  "CriticalFailureBanner.vue",
]);

// Matches `from "<...>/api"`, `from "<...>/api/whatever"`, AND
// `import("<...>/api")` / `import("<...>/api/whatever")`. Tight enough
// to skip unrelated paths (`./api-helpers/foo`), broad enough to catch
// the api-as-directory shape if `api.ts` is ever promoted to `api/`.
const API_IMPORT_RE = /(?:from\s+|import\s*\()\s*["'][^"']*\/api(?:["']|\/)/;

// Bounded look-ahead so the lazy quantifier doesn't drift across the
// rest of the file — `[\s\S]*?` without a cap finds "poll" in a comment
// 50 lines below a debounce setTimeout (false positive on useStream.ts +
// ACTab.vue). Cap at 100 chars: enough for typical callback bodies
// `() => fetchFoo()` (~20) and even `() => { runX(); fetchY(); }` (~30),
// short enough not to escape the call.
const POLLING_SETTIMEOUT_RE =
  /setTimeout\s*\([\s\S]{0,100}?(fetch|reload|refresh|poll)/i;

function listSourceFiles(dir: string, exts: readonly string[]): string[] {
  const results: string[] = [];
  function walk(current: string, relPrefix: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, relPrefix ? `${relPrefix}/${entry}` : entry);
        continue;
      }
      if (!stat.isFile()) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (!exts.some((ext) => entry.endsWith(ext))) continue;
      results.push(relPrefix ? `${relPrefix}/${entry}` : entry);
    }
  }
  walk(dir, "");
  return results;
}

const composableSources = listSourceFiles(COMPOSABLES_DIR, [".ts"]);
const componentSources = listSourceFiles(COMPONENTS_DIR, [".vue"]);

function basename(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

describe("no-poll regex self-test (meta — load-bearing patterns)", () => {
  it("polling-setTimeout regex catches the arrow-callback form", () => {
    expect("setTimeout(() => fetchFoo(), 5000)").toMatch(POLLING_SETTIMEOUT_RE);
    expect("setTimeout(() => reload(), 30_000)").toMatch(POLLING_SETTIMEOUT_RE);
    expect("setTimeout(refresh, 1000)").toMatch(POLLING_SETTIMEOUT_RE);
  });
  it("polling-setTimeout regex ignores legitimate non-polling uses", () => {
    expect("setTimeout(() => commitInput(), 50)").not.toMatch(
      POLLING_SETTIMEOUT_RE,
    );
    expect("reconnectTimer = setTimeout(() => { void connect(); }, delay)")
      .not.toMatch(POLLING_SETTIMEOUT_RE);
  });
  it("api-import regex catches static, subdir, and dynamic shapes", () => {
    expect('from "../api"').toMatch(API_IMPORT_RE);
    expect('from "../../api"').toMatch(API_IMPORT_RE);
    expect('from "../api/agents"').toMatch(API_IMPORT_RE);
    expect('await import("../api")').toMatch(API_IMPORT_RE);
  });
  it("api-import regex ignores look-alike paths", () => {
    expect('from "./api-helpers"').not.toMatch(API_IMPORT_RE);
    expect('from "./types"').not.toMatch(API_IMPORT_RE);
  });
});

describe("dashboard/src/composables — no client-side polling", () => {
  it("the sweep inspects more than zero files (smoke check)", () => {
    expect(composableSources.length).toBeGreaterThan(0);
  });

  it.each(composableSources)(
    "%s: no setInterval (server state flows via SSE, not a clock)",
    (relPath) => {
      const source = readFileSync(join(COMPOSABLES_DIR, relPath), "utf-8");
      if (SETINTERVAL_EXEMPT_FILES.has(basename(relPath))) {
        expect(
          source,
          `${relPath} is exempt as a cosmetic-only timer; it MUST NOT import from api.ts. ` +
            `If this fails, drop the api import or remove the exemption entry.`,
        ).not.toMatch(API_IMPORT_RE);
        return;
      }
      expect(
        source,
        `${relPath} calls setInterval — server-state composables subscribe to /api/stream via useStream, not a clock. ` +
          `If the timer is purely cosmetic (no api.ts import), add the file to SETINTERVAL_EXEMPT_FILES and document it in dashboard.md.`,
      ).not.toMatch(/setInterval\s*\(/);
      expect(
        source,
        `${relPath} schedules a fetch/reload/refresh/poll via setTimeout — that's polling with extra steps. Subscribe via SSE instead.`,
      ).not.toMatch(POLLING_SETTIMEOUT_RE);
    },
  );
});

describe("dashboard/src/components — no client-side polling", () => {
  it("the sweep inspects more than zero components (smoke check)", () => {
    expect(componentSources.length).toBeGreaterThan(0);
  });

  it.each(componentSources)(
    "%s: no setInterval outside the cosmetic-timer allowlist",
    (relPath) => {
      const source = readFileSync(join(COMPONENTS_DIR, relPath), "utf-8");
      if (SETINTERVAL_EXEMPT_FILES.has(basename(relPath))) {
        expect(
          source,
          `${relPath} is exempt as a cosmetic-only timer; it MUST NOT import from api.ts.`,
        ).not.toMatch(API_IMPORT_RE);
        return;
      }
      expect(
        source,
        `${relPath} calls setInterval — components must NOT poll. If the timer is cosmetic (no api.ts import), add to SETINTERVAL_EXEMPT_FILES and document in dashboard.md.`,
      ).not.toMatch(/setInterval\s*\(/);
      expect(
        source,
        `${relPath} schedules a fetch/reload/refresh/poll via setTimeout — that's polling. Subscribe via SSE.`,
      ).not.toMatch(POLLING_SETTIMEOUT_RE);
    },
  );
});
