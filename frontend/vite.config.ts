import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Mirror the production nginx setup so relative `/api/...` calls
    // (CSV / accounting export) reach the FastAPI backend in dev too.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        // Accounting/CSV exports fan out over many branches and pages and can
        // run long; mirror the production nginx `proxy_read_timeout 300s` so the
        // dev proxy doesn't drop the connection ("failed to fetch") mid-export.
        timeout: 300000,
        proxyTimeout: 300000,
      },
    },
  },
});
