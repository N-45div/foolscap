#!/usr/bin/env node
/**
 * `npx foolscap` — the notebook for coding agents, one command.
 *
 * Serves the built viewer + the session API on 127.0.0.1 and opens the
 * browser. Loopback-only on purpose: this reads your private agent
 * sessions, and binding anything else would expose them to the network.
 *
 *   foolscap                 open the viewer on your archive
 *   foolscap skill           install the Claude Code skill
 *   foolscap --root <dir>    view a curated/copied archive
 *   foolscap --port <n>      pick a port (default 4517)
 *   foolscap --no-open       don't launch the browser
 */
import { createServer } from "node:http";
import { cp, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, resolveRoots, scanAll } from "../server/core.mjs";

// ── Terminal dress code: brass on ink, silent when piped or NO_COLOR ──
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const brass = paint("38;5;179");
const dim = paint("2");
const bold = paint("1");
const oxide = paint("38;5;167");

const wordmark = `${bold("fools")}${brass("cap")}`;
const rule = dim("─".repeat(42));

// Legacy conhost often runs a non-UTF8 codepage; Windows Terminal sets
// WT_SESSION. Degrade the typography rather than shipping mojibake.
const unicodeOk =
  process.platform !== "win32" ||
  Boolean(process.env.WT_SESSION ?? process.env.TERM_PROGRAM);
const say = (s) =>
  console.log(
    unicodeOk
      ? s
      : s.replaceAll("·", "-").replaceAll("─", "-").replaceAll("→", ">"),
  );

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── foolscap skill — install the Claude Code skill ────────────────────
if (args[0] === "skill") {
  const src = join(pkgRoot, "skills", "foolscap");
  const dest = join(homedir(), ".claude", "skills", "foolscap");
  try {
    await cp(src, dest, { recursive: true, force: true });
    say(`
  ${wordmark} ${dim("· skill installed")}

  ${dim("→")} ${dest}

  Your Claude Code agent can now recall, summarize and export
  past sessions. Try asking it:

    ${brass('"what did we do in yesterday\'s session?"')}
`);
  } catch (err) {
    console.error(`${oxide("skill install failed:")} ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  say(`
  ${wordmark} ${dim("· the notebook for coding agents")}

  ${bold("foolscap")}                 open the viewer on your archive
  ${bold("foolscap skill")}           install the Claude Code skill
  ${bold("foolscap --root")} ${dim("<dir>")}    view a curated or copied archive
  ${bold("foolscap --port")} ${dim("<n>")}      pick a port ${dim("(default 4517)")}
  ${bold("foolscap --no-open")}       don't launch the browser

  ${dim("Reads Claude Code (~/.claude) and Codex CLI (~/.codex).")}
  ${dim("Read-only · 127.0.0.1 only · github.com/N-45div/foolscap")}
`);
  process.exit(0);
}

// ── Serve ─────────────────────────────────────────────────────────────
const rootArg = flag("--root");
const roots = resolveRoots(
  rootArg ? resolve(rootArg) : process.env.FOOLSCAP_ROOT,
);
const basePort = Number(flag("--port") ?? 4517);

const distDir = join(pkgRoot, "dist");
try {
  await stat(join(distDir, "index.html"));
} catch {
  console.error(
    `${oxide("foolscap: built frontend not found.")}\n` +
      `If you're running from a clone, build it first:  ${bold("pnpm install && pnpm build")}`,
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

/** The boot banner is an instrument statement: what was found, where it
    serves, what it will never do. */
async function banner(url) {
  const groups = await scanAll(roots);
  const bySource = new Map();
  for (const g of groups) {
    const s = bySource.get(g.source) ?? { sessions: 0, projects: 0 };
    s.sessions += g.sessions.length;
    s.projects += 1;
    bySource.set(g.source, s);
  }

  const lines = [...bySource.entries()].map(([source, s]) => {
    const label = (source === "claude" ? "claude code" : source).padEnd(13);
    return `  ${label}${String(s.sessions).padStart(4)} sessions ${dim("·")} ${s.projects} project${s.projects === 1 ? "" : "s"}`;
  });

  say(`
  ${wordmark} ${dim("· the notebook for coding agents")}
  ${rule}
${lines.length > 0 ? lines.join("\n") : `  ${dim("no sessions found yet — run your agent once, then reopen")}`}
  ${rule}
  ${dim("→")} ${bold(url)}
  ${dim(rootArg ? `archive: ${resolve(rootArg)} (curated root)` : "read-only · 127.0.0.1 only · ctrl+c to stop")}

  ${dim("tip:")} ${brass("foolscap skill")} ${dim('teaches your Claude Code agent to answer')}
  ${dim('"what did we do yesterday?" from this archive')}
`);
}

function listen(port, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`${oxide("foolscap:")} ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", async () => {
    const url = `http://localhost:${port}`;
    await banner(url);
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
