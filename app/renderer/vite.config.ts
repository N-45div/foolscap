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
  },
  server: { port: 5199, strictPort: true },
});
