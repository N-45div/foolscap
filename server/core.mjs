/**
 * The session API core — framework-free, plain Node.
 *
 * One implementation, three consumers: the Vite dev middleware, the
 * standalone `npx foolscap` server, and (later) the Tauri sidecar. Plain
 * .mjs on purpose: a distributed CLI must run on any supported Node with
 * no build step and no type-stripping requirements.
 *
 * Read-only by construction — nothing here ever writes to session files.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Viewer parses in the browser; a 200MB rollout would hang the tab.
export const MAX_SESSION_BYTES = 50 * 1024 * 1024;

/**
 * Resolve archive roots. FOOLSCAP_ROOT points at a curated archive and,
 * when set, is the ONLY thing scanned. Layouts:
 *   <root>/claude/... + <root>/codex/...   per-source subdirs
 *   <root>/...                             legacy: claude-style projects
 * @param {string | undefined} fixtureRoot
 * @returns {{ claudeRoot: string, codexRoot: string | null }}
 */
export function resolveRoots(fixtureRoot) {
  if (fixtureRoot) {
    const c = join(fixtureRoot, "claude");
    const x = join(fixtureRoot, "codex");
    return {
      claudeRoot: existsSync(c) ? c : fixtureRoot,
      codexRoot: existsSync(x) ? x : null,
    };
  }
  return {
    claudeRoot: join(homedir(), ".claude", "projects"),
    codexRoot: join(homedir(), ".codex", "sessions"),
  };
}

/** Claude Code: ~/.claude/projects/<dir>/<uuid>.jsonl */
async function scanClaude(root) {
  const out = [];
  let projectDirs = [];
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
    const sessions = [];
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
    the cwd in each rollout's head, case-insensitively on Windows. */
async function scanCodex(root) {
  const byCwd = new Map();

  async function walk(dir) {
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
      // the system prompt) — regex the head for cwd instead.
      let cwd = "(unknown project)";
      try {
        const fh = await open(full, "r");
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const head = buf.toString("utf8", 0, bytesRead);
        const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (raw) cwd = JSON.parse(`"${raw}"`);
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

export async function scanAll(roots) {
  return [
    ...(await scanClaude(roots.claudeRoot)),
    ...(roots.codexRoot ? await scanCodex(roots.codexRoot) : []),
  ];
}

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.end(body);
}

/**
 * Handle an /api/* request. Returns true if the request was handled.
 * Works as both a Vite middleware body and a node:http handler.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ claudeRoot: string, codexRoot: string | null }} roots
 * @returns {Promise<boolean>}
 */
export async function handleApi(req, res, roots) {
  const url = new URL(req.url ?? "/", "http://localhost");

  const allowed = (file) =>
    file.endsWith(".jsonl") &&
    (file.startsWith(roots.claudeRoot) ||
      (roots.codexRoot !== null && file.startsWith(roots.codexRoot)));

  try {
    if (url.pathname === "/api/projects") {
      send(res, 200, "application/json", JSON.stringify(await scanAll(roots)));
      return true;
    }

    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      if (q.length < 2) {
        send(res, 200, "application/json", "[]");
        return true;
      }
      const hits = [];
      for (const g of await scanAll(roots)) {
        for (const s of g.sessions) {
          if (s.bytes > MAX_SESSION_BYTES) continue;
          const text = (await readFile(s.file, "utf8")).toLowerCase();
          let count = 0;
          let i = text.indexOf(q);
          const firstHit = i;
          while (i !== -1 && count < 500) {
            count++;
            i = text.indexOf(q, i + q.length);
          }
          if (count === 0) continue;
          hits.push({
            source: g.source,
            dir: g.dir,
            ...s,
            count,
            snippet: text
              .slice(Math.max(0, firstHit - 60), firstHit + q.length + 90)
              .replace(/\\n/g, " ")
              .replace(/\s+/g, " "),
          });
        }
      }
      hits.sort((a, b) => b.count - a.count);
      send(res, 200, "application/json", JSON.stringify(hits.slice(0, 40)));
      return true;
    }

    if (url.pathname === "/api/session") {
      const file = url.searchParams.get("file") ?? "";
      if (!allowed(file)) {
        send(res, 403, "text/plain", "forbidden");
        return true;
      }
      const s = await stat(file);
      if (s.size > MAX_SESSION_BYTES) {
        send(
          res,
          413,
          "text/plain",
          `session is ${Math.round(s.size / 1048576)} MB — too large for the v0.1 viewer`,
        );
        return true;
      }
      send(res, 200, "application/x-ndjson", await readFile(file, "utf8"));
      return true;
    }
  } catch (err) {
    send(res, 500, "text/plain", String(err));
    return true;
  }

  return false;
}
