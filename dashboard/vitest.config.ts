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
    restoreMocks: true,
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
    server: {
      deps: {
        inline: ["danx-ui"],
      },
    },
  },
});
