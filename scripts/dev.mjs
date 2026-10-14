/**
 * Development: the renderer on Vite's dev server, the app in Electron.
 *
 * Editors built on Electron (VS Code among them) export
 * ELECTRON_RUN_AS_NODE to everything they launch, which would make our
 * Electron run as plain Node, so it is removed for the child.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ configFile: fileURLToPath(new URL("../app/renderer/vite.config.ts", import.meta.url)) });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5199/";
console.log(`renderer on ${url}`);

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env, VITE_DEV_SERVER_URL: url.replace(/\/$/, "") };
delete env.ELECTRON_RUN_AS_NODE;

const app = spawn(electron, [root], { stdio: "inherit", env });
app.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
