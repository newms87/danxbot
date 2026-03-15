#!/bin/bash
# Platform patches applied after repo clone.
# These add DANX_USE_NPM support so flytebot can run without the local danx symlink.
# Remove this script once these changes are merged into the platform repo.

REPO="/flytebot/repos/platform"

# Patch danx-local.sh: skip symlink when DANX_USE_NPM is set
if ! grep -q "DANX_USE_NPM" "$REPO/mva/danx-local.sh" 2>/dev/null; then
    cat > "$REPO/mva/danx-local.sh" << 'DANX'
#!/bin/bash

set +x

# Skip local symlink when DANX_USE_NPM is set (e.g., in CI or isolated Docker environments)
if [ -n "$DANX_USE_NPM" ]; then
  printf "DANX_USE_NPM is set, using npm package instead of local symlink\n"
  exit 0
fi

# Resolve path to quasar-ui-danx (can be up 1 or 2 directories)
DANX_PATH="$(realpath $(find ../.. -maxdepth 2 -type d -name "quasar-ui-danx" | head -n 1))/ui/src"
MODULE_PATH="$(pwd)/node_modules/quasar-ui-danx"

# symlink ../quasar-ui-danx to node_modules/quasar-ui-danx if the directory exists
if [ -d "$DANX_PATH" ]; then
  rm -r node_modules/quasar-ui-danx
  ln -s "$DANX_PATH" "$MODULE_PATH"
  printf "Symlinked $DANX_PATH --> $MODULE_PATH\n"
fi
DANX
    echo "    Patched mva/danx-local.sh"
fi

# Patch vite.config.ts: respect DANX_USE_NPM env var
if ! grep -q "DANX_USE_NPM" "$REPO/mva/vite.config.ts" 2>/dev/null; then
    cat > "$REPO/mva/vite.config.ts" << 'VITE'
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import { defineConfig } from "vite";
import svgLoader from "vite-svg-loader";

// https://vitejs.dev/config/
export default ({ command, mode }) => {

  // For development w/ HMR, load the danx-legacy library + styles directly from the directory
  // NOTE: Inside the docker container, quasar-ui-danx-legacy is mounted at /home/node/quasar-ui-danx
  // Set DANX_USE_NPM=1 to skip local resolution and use the npm package instead
  const useLocalDanx = command === "serve" && !process.env.DANX_USE_NPM;
  const danx = (useLocalDanx ? {
    "quasar-ui-danx": resolve(__dirname, "../quasar-ui-danx/src"),
    "quasar-ui-danx-styles": resolve(__dirname, "../quasar-ui-danx/src/styles/index.scss"),
    "quasar-ui-danx-legacy": resolve(__dirname, "../quasar-ui-danx/src")
  } : {
    // Import from quasar-ui-danx module for production (npm alias to quasar-ui-danx-legacy)
    "quasar-ui-danx-styles": resolve(__dirname, "node_modules/quasar-ui-danx/dist/style.css")
  });

  console.log("Danx", command, danx);

  return defineConfig({
    base: mode === "production" ? "/build/" : "",
    publicDir: "public",
    plugins: [vue(), svgLoader()],
    server: {
      host: "0.0.0.0",
      port: 9090,
      hmr: {
        host: mode === "ci" ? "e2e-mva" : "localhost"
      }
    },
    preview: {
      host: "0.0.0.0",
      port: 9090
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        app: resolve(__dirname, "./"),
        src: resolve(__dirname, "./src"),
        components: resolve(__dirname, "./src/components"),
        consts: resolve(__dirname, "./src/consts"),
        layouts: resolve(__dirname, "./src/layouts"),
        helpers: resolve(__dirname, "./src/helpers"),
        pages: resolve(__dirname, "./src/pages"),
        assets: resolve(__dirname, "./src/assets"),
        boot: resolve(__dirname, "./src/boot"),
        stores: resolve(__dirname, "./src/stores"),
        routes: resolve(__dirname, "./src/routes"),
        ...danx
      },
      extensions: [".mjs", ".js", ".ts", ".mts", ".jsx", ".tsx", ".json", ".vue"]
    },
    build: {
      manifest: true,
      outDir: "public/build",
      rollupOptions: {
        input: "src/main.ts"
      }
    }
  });
}
VITE
    echo "    Patched mva/vite.config.ts"
fi

echo "    Platform patches applied."
