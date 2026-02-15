import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

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
      "/api": "http://localhost:5555",
      "/health": "http://localhost:5555",
    },
  },
});
