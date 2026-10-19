import { defineConfig } from "vite";
export default defineConfig({
  publicDir: "../firmware/web/shared",
  server: { proxy: { "/relay": { target: "ws://127.0.0.1:8787", ws: true } } },
  build: { outDir: "dist" },
});
