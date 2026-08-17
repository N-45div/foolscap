#!/usr/bin/env node
/**
 * `npx foolscap` — the notebook for coding agents, one command.
 *
 * Serves the built viewer + the session API on 127.0.0.1 and opens the
 * browser. Loopback-only on purpose: this reads your private agent
 * sessions, and binding anything else would expose them to the network.
 *
 *   foolscap                 open the viewer on your archive
 *   foolscap --root <dir>    view a curated/copied archive (FOOLSCAP_ROOT)
 *   foolscap --port <n>      pick a port (default 4517)
 *   foolscap --no-open       don't launch the browser
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, resolveRoots } from "../server/core.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`foolscap — the notebook for coding agents

  foolscap                 open the viewer on your archive
  foolscap --root <dir>    view a curated or copied archive
  foolscap --port <n>      pick a port (default 4517)
  foolscap --no-open       don't launch the browser

Reads Claude Code (~/.claude/projects) and Codex CLI (~/.codex/sessions).
Read-only. Local only. https://github.com/N-45div/foolscap`);
  process.exit(0);
}

const rootArg = flag("--root");
const roots = resolveRoots(
  rootArg ? resolve(rootArg) : process.env.FOOLSCAP_ROOT,
);
const basePort = Number(flag("--port") ?? 4517);

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
try {
  await stat(join(distDir, "index.html"));
} catch {
  console.error(
    "foolscap: built frontend not found.\n" +
      "If you're running from a clone, build it first:  pnpm install && pnpm build",
  );
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  if (await handleApi(req, res, roots)) return;

  // Static frontend, with path-traversal containment and SPA fallback.
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  let filePath = normalize(join(distDir, pathname));
  if (!filePath.startsWith(distDir)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  try {
    if (pathname === "/" || (await stat(filePath)).isDirectory()) {
      filePath = join(distDir, "index.html");
    }
  } catch {
    filePath = join(distDir, "index.html"); // SPA fallback
  }
  try {
    const body = await readFile(filePath);
    res.setHeader(
      "content-type",
      TYPES[extname(filePath)] ?? "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

/** EADDRINUSE → walk up a few ports rather than dying. */
function listen(port, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`foolscap: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`foolscap · ${url}`);
    console.log(
      rootArg
        ? `archive: ${resolve(rootArg)} (curated root)`
        : "archive: ~/.claude + ~/.codex · read-only · local only",
    );
    if (!args.includes("--no-open")) {
      const cmd =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
    }
  });
}

listen(basePort, 10);
