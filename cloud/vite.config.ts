import { defineConfig } from "vite";
export default defineConfig({
  // Sonner injects a <style> by default. Ship its published stylesheet as a
  // normal Vite asset so production can retain style-src 'self'.
  plugins: [
    {
      name: "sonner-external-styles",
      enforce: "pre",
      transform(source, id) {
        if (!/\/sonner\/dist\/index\.m?js$/.test(id.split("?")[0])) return;
        return source
          .replace(/^__insertCSS\(.*\);?\s*$/m, "")
          .replace(/^'use client';\s*/, "");
      },
    },
  ],
  optimizeDeps: { exclude: ["sonner"] },
  publicDir: "../firmware/web/shared",
  server: { proxy: { "/relay": { target: "ws://127.0.0.1:8787", ws: true } } },
  build: { outDir: "dist" },
});
