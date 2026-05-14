import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@backend": resolve(__dirname, "../src"),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    // dashboard/package.json pins vitest to ~4.0.x. vitest 4.1.x pulls
    // rolldown which imports `styleText` from `node:util` (Node ≥20.12);
    // the host runs Node 18.19.1, so 4.1.x crashes at startup. Bumping
    // the pin without raising the Node floor (or rolldown-free vitest)
    // reintroduces DX-358. Absolute setupFiles path also needed —
    // vitest 4.0.x resolves "./vitest.setup.ts" against the wrong root.
    setupFiles: [resolve(__dirname, "vitest.setup.ts")],
    restoreMocks: true,
    // Full-suite runs do a cold transform+import of every test file's
    // graph. The first `mount()` after the cold import can blow past 5s
    // (App.vue + every dashboard SFC in its tree). Bumping the floor
    // gives the slowest first-test of the suite headroom; isolated runs
    // are unaffected. See DX-253.
    testTimeout: 15000,
    // Vitest 4's default `useFakeTimers()` toFake list hangs `vi.useRealTimers()`
    // in afterEach (repro: useStream.test.ts). Pin to the standard set.
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
    // danx-ui ships a vendored copy of `yaml` under dist/node_modules/yaml/.
    // Externalized, vite-node loads its browser ESM as CJS → "Named export
    // 'parse' not found". Inlining lets Vite transform danx-ui itself.
    // Match the full scoped package name (`@thehammer/danx-ui`) — the bare
    // `"danx-ui"` form does not match the resolved import path and the
    // externalized build leaked the vendored browser-ESM yaml back into
    // vite-node's ESM resolver (Phase 2 of ISS-99 root-caused this).
    server: {
      deps: {
        inline: ["@thehammer/danx-ui"],
      },
    },
  },
});
