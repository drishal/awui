import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";

const backend = `http://127.0.0.1:${process.env.PORT ?? "4783"}`;

export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    // No inline scripts or styles: the CSP allows only 'self'.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/web/index.html"),
        "terminal-shell": resolve(import.meta.dirname, "src/web/terminal-shell.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: false },
    },
  },
});
