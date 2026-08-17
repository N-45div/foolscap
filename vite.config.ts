import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { handleApi, resolveRoots } from "./server/core.mjs";

/**
 * Dev server wiring. The actual session API lives in server/core.mjs —
 * one implementation shared by this middleware, the `npx foolscap`
 * standalone server, and (later) the Tauri sidecar.
 */
function sessionApi(): Plugin {
  const roots = resolveRoots(process.env.FOOLSCAP_ROOT);
  return {
    name: "foolscap-session-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!(await handleApi(req, res, roots))) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sessionApi()],
  clearScreen: false,
});
