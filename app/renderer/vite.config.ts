import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// The panel and the full window are one page; ?view= picks the layout.
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: fileURLToPath(new URL("../../dist/renderer", import.meta.url)),
    emptyOutDir: true,
    target: "chrome130",
    // The mic's AudioWorklet must be its own file: inlined as a data: URL
    // it is blocked by the page's script-src 'self'.
    assetsInlineLimit: (file) => (file.endsWith(".js") ? false : undefined),
  },
  server: { port: 5199, strictPort: true },
});
