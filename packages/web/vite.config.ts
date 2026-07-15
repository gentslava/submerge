/// <reference types="vitest/config" />
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Proxy the API (tRPC + SSE subscriptions both live under /trpc). Target is the
    // local server by default; set VITE_PROXY_TARGET to develop against a remote
    // deployment (e.g. the live instance) with real data + hot reload.
    proxy: {
      "/trpc": {
        target: process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
