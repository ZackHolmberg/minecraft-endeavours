import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

// Panel UI. `npm run ui:build` → src/web/ui/dist (served by src/web/server).
// `npm run ui:dev` → Vite dev server proxying /api (incl. the WebSocket) to the
// panel's --dev mode. Override the target with PANEL_URL (e.g. the mock server).
const target = process.env.PANEL_URL ?? "https://127.0.0.1:8443";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [preact({ prerender: { enabled: false } })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The default polyfill is fine under CSP, but nothing here needs it.
    modulePreload: { polyfill: false },
    // Keep every asset a real file: CSP `default-src 'self'` forbids data: URIs.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false, secure: false, ws: true },
    },
  },
});
