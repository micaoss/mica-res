import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Served at the root of res.micaos.dev by the Worker's asset binding. The
// bundles live under /_site/, a reserved first segment, so they can never
// collide with a namespace.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: "/",
  build: {
    assetsDir: "_site",
  },
  server: {
    port: 5010,
    proxy: {
      "/.well-known/res.json": { target: process.env.RES_HOME_URL ?? "https://res.micaos.dev", changeOrigin: true },
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
