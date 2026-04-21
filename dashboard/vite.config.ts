import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// VITE_API_TARGET lets the docker-compose `dashboard-dev` service point at
// `http://dashboard:5555` on the danxbot-net network. When unset (bare-metal
// `npm run dashboard:dev`), we fall back to localhost.
const apiTarget =
  process.env.VITE_API_TARGET ||
  `http://localhost:${process.env.DASHBOARD_PORT || "5555"}`;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@backend": resolve(__dirname, "../src"),
    },
  },
  server: {
    // Bind on all interfaces so the container's port mapping exposes Vite to
    // the host. The default "localhost" binds only the loopback inside the
    // container, which docker cannot forward out of.
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
});
