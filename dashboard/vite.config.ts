import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const apiPort = process.env.DASHBOARD_PORT || "5555";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@backend": resolve(__dirname, "../src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      "/health": `http://localhost:${apiPort}`,
    },
  },
});
