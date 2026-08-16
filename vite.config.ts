import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dev backend: discovers and serves agent sessions over localhost.
 *
 * Harness-agnostic: each source contributes {source, dir, sessions[]}
 * groups; parsing happens client-side via the matching adapter. In the
 * Tauri build these endpoints become invoke() commands; the frontend is
 * unchanged. Read-only by construction.
 */

type SessionEntry = { id: string; file: string; bytes: number; modified: number };
type Group = { source: string; dir: string; sessions: SessionEntry[] };

// Viewer parses in the browser; a 200MB rollout would hang the tab.
const MAX_SESSION_BYTES = 50 * 1024 * 1024;

/** Claude Code: ~/.claude/projects/<dir>/<uuid>.jsonl */
async function scanClaude(root: string): Promise<Group[]> {
  const out: Group[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = await readdir(root);
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    const sessions: SessionEntry[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const file = join(root, dir, e.name);
      const s = await stat(file);
      if (s.size === 0) continue;
      sessions.push({
        id: e.name.replace(/\.jsonl$/, ""),
        file,
        bytes: s.size,
        modified: s.mtimeMs,
      });
    }
    if (sessions.length > 0) {
      sessions.sort((a, b) => b.modified - a.modified);
      out.push({ source: "claude", dir, sessions });
    }
  }
  return out;
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, grouped by
    the cwd recorded in each file's session_meta first line. */
async function scanCodex(root: string): Promise<Group[]> {
  // Key case-insensitively (Windows paths), display the first-seen form.
  const byCwd = new Map<string, { display: string; sessions: SessionEntry[] }>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const s = await stat(full);
      if (s.size === 0) continue;

      // session_meta's first line can exceed any fixed buffer (it embeds
      // the full system prompt), so pull cwd out of the head by regex —
      // it appears within the first few hundred bytes.
      let cwd = "(unknown project)";
      try {
        const fh = await open(full, "r");
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const head = buf.toString("utf8", 0, bytesRead);
        const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (raw) cwd = JSON.parse(`"${raw}"`); // unescape \\ etc.
      } catch {
        // unreadable head — keep the unknown-project bucket
      }

      const id =
        /rollout-[\d T:-]+-([0-9a-f-]{36})\.jsonl$/i.exec(e.name)?.[1] ??
        e.name.replace(/\.jsonl$/, "");
      const key = cwd.toLowerCase();
      const group = byCwd.get(key) ?? { display: cwd, sessions: [] };
      group.sessions.push({ id, file: full, bytes: s.size, modified: s.mtimeMs });
      byCwd.set(key, group);
    }
  }

  await walk(root);
  return [...byCwd.values()].map(({ display, sessions }) => {
    sessions.sort((a, b) => b.modified - a.modified);
    return { source: "codex", dir: display, sessions };
  });
}

function sessionApi(): Plugin {
  // FOOLSCAP_ROOT points the viewer at a curated archive (fixtures,
  // copies from another machine). When set, ONLY that root is scanned —
  // no other source can leak into a curated view. Layouts:
  //   <root>/claude/... + <root>/codex/...   per-source subdirs
  //   <root>/...                             legacy: claude-style projects
  const fixtureRoot = process.env.FOOLSCAP_ROOT;
  let claudeRoot: string;
  let codexRoot: string | null;
  if (fixtureRoot) {
    const c = join(fixtureRoot, "claude");
    const x = join(fixtureRoot, "codex");
    claudeRoot = existsSync(c) ? c : fixtureRoot;
    codexRoot = existsSync(x) ? x : null;
  } else {
    claudeRoot = join(homedir(), ".claude", "projects");
    codexRoot = join(homedir(), ".codex", "sessions");
  }

  const allowed = (file: string): boolean =>
    file.endsWith(".jsonl") &&
    (file.startsWith(claudeRoot) ||
      (codexRoot !== null && file.startsWith(codexRoot)));

  return {
    name: "foolscap-session-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          if (url.pathname === "/api/projects") {
            const groups = [
              ...(await scanClaude(claudeRoot)),
              ...(codexRoot ? await scanCodex(codexRoot) : []),
            ];
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(groups));
            return;
          }

          if (url.pathname === "/api/session") {
            const file = url.searchParams.get("file") ?? "";
            if (!allowed(file)) {
              res.statusCode = 403;
              res.end("forbidden");
              return;
            }
            const s = await stat(file);
            if (s.size > MAX_SESSION_BYTES) {
              res.statusCode = 413;
              res.end(
                `session is ${Math.round(s.size / 1048576)} MB — too large for the v0.1 viewer`,
              );
              return;
            }
            res.setHeader("content-type", "application/x-ndjson");
            res.end(await readFile(file, "utf8"));
            return;
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sessionApi()],
  clearScreen: false,
});
