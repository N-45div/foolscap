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
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { judge, segmentsFor } from "./outcome.mjs";

/** Archives copied between machines carry both line endings. */
const LINE_BREAK = /\r?\n/;

// Viewer parses in the browser; a 200MB rollout would hang the tab.
export const MAX_SESSION_BYTES = 50 * 1024 * 1024;

/**
 * dsh persists sessions zstd-compressed by default. Node grew built-in
 * zstd in 22.15/23.8 — feature-detect so older Nodes still serve every
 * other source and fail with a useful message only on .zstd files.
 */
const hasZstd = typeof zlib.zstdDecompressSync === "function";

/** Read a session file as text, decompressing .jsonl.zstd when needed. */
export async function readSessionText(file) {
  if (!file.endsWith(".zstd")) return readFile(file, "utf8");
  if (!hasZstd) {
    throw new Error(
      "this dsh session is zstd-compressed — reading it needs Node 22.15+ (built-in zstd)",
    );
  }
  const raw = await readFile(file);
  return zlib.zstdDecompressSync(raw).toString("utf8");
}

/**
 * Resolve archive roots. FOOLSCAP_ROOT points at a curated archive and,
 * when set, is the ONLY thing scanned. Layouts:
 *   <root>/claude + <root>/codex + <root>/dsh   per-source subdirs
 *   <root>/...                                  legacy: claude-style projects
 * @param {string | undefined} fixtureRoot
 * @returns {{ claudeRoot: string, codexRoot: string | null, dshRoot: string | null }}
 */
export function resolveRoots(fixtureRoot) {
  if (fixtureRoot) {
    const c = join(fixtureRoot, "claude");
    const x = join(fixtureRoot, "codex");
    const d = join(fixtureRoot, "dsh");
    return {
      claudeRoot: existsSync(c) ? c : fixtureRoot,
      codexRoot: existsSync(x) ? x : null,
      dshRoot: existsSync(d) ? d : null,
    };
  }
  return {
    claudeRoot: join(homedir(), ".claude", "projects"),
    codexRoot: join(homedir(), ".codex", "sessions"),
    // dsh honors DSH_HOME the same way dsh itself does.
    dshRoot: process.env.DSH_HOME || join(homedir(), ".dsh"),
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

/** DeepSeek Harness: {~/.dsh|$DSH_HOME}/…/<sessionId>/session.jsonl[.zstd],
    grouped by the cwd in each log's header line. */
async function scanDsh(root) {
  const byCwd = new Map();

  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name !== "session.jsonl" && e.name !== "session.jsonl.zstd")
        continue;
      const s = await stat(full);
      if (s.size === 0) continue;

      // The header (line 1) carries cwd; for .zstd that means a full
      // decompress, so cap what we're willing to inflate during a scan.
      let cwd = "(unknown project)";
      try {
        let head = "";
        if (full.endsWith(".zstd")) {
          if (!hasZstd || s.size > 8 * 1024 * 1024) throw new Error("skip");
          head = zlib
            .zstdDecompressSync(await readFile(full))
            .toString("utf8", 0, 4096);
        } else {
          const fh = await open(full, "r");
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await fh.read(buf, 0, 4096, 0);
          await fh.close();
          head = buf.toString("utf8", 0, bytesRead);
        }
        const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (raw) cwd = JSON.parse(`"${raw}"`);
      } catch {
        // unreadable header — keep the unknown-project bucket
      }

      // Directory name is encodeSegment(sessionId) — the stable id.
      const id = dir.split(/[\\/]/).pop() ?? e.name;
      const key = cwd.toLowerCase();
      const group = byCwd.get(key) ?? { display: cwd, sessions: [] };
      group.sessions.push({ id, file: full, bytes: s.size, modified: s.mtimeMs });
      byCwd.set(key, group);
    }
  }

  await walk(root, 0);
  return [...byCwd.values()].map(({ display, sessions }) => {
    sessions.sort((a, b) => b.modified - a.modified);
    return { source: "dsh", dir: display, sessions };
  });
}

export async function scanAll(roots) {
  return [
    ...(await scanClaude(roots.claudeRoot)),
    ...(roots.codexRoot ? await scanCodex(roots.codexRoot) : []),
    ...(roots.dshRoot ? await scanDsh(roots.dshRoot) : []),
  ];
}

// ── The prompt shelf ───────────────────────────────────────
// Every prompt ever sent, derived from the archive itself, deduplicated
// by exact text. Each occurrence carries the evidence of how it turned
// out (see server/outcome.mjs) so the shelf can rank by what actually
// worked rather than by what was typed most recently.

const promptKey = (text) =>
  createHash("sha1").update(text.trim()).digest("hex");

/** Stars live in foolscap's own home — never near session files. */
const starsFile = () => join(homedir(), ".foolscap", "starred.json");

async function readStars() {
  try {
    const v = JSON.parse(await readFile(starsFile(), "utf8"));
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

async function toggleStar(key) {
  const stars = await readStars();
  if (stars.has(key)) stars.delete(key);
  else stars.add(key);
  await mkdir(join(homedir(), ".foolscap"), { recursive: true });
  await writeFile(starsFile(), JSON.stringify([...stars], null, 2));
  return stars.has(key);
}

export async function collectPrompts(roots) {
  const byText = new Map();

  for (const g of await scanAll(roots)) {
    for (const s of g.sessions) {
      if (s.bytes > MAX_SESSION_BYTES) continue;
      let lines;
      try {
        lines = (await readSessionText(s.file)).split(LINE_BREAK);
      } catch {
        continue;
      }

      for (const segment of segmentsFor(g.source, lines)) {
        const text = segment.text.slice(0, 4000);
        const key = promptKey(text);
        const verdict = judge(segment).verdict;

        let p = byText.get(key);
        if (!p) {
          p = {
            key,
            text,
            at: segment.at,
            count: 0,
            verified: 0,
            corrected: 0,
            source: g.source,
            dir: g.dir,
            session: s,
          };
          byText.set(key, p);
        }
        p.count++;
        if (verdict === "verified") p.verified++;
        if (verdict === "corrected") p.corrected++;
        // Keep the most recent occurrence as the one we link to.
        if (segment.at && (!p.at || segment.at > p.at)) {
          p.at = segment.at;
          p.source = g.source;
          p.dir = g.dir;
          p.session = s;
        }
      }
    }
  }

  const stars = await readStars();
  const all = [...byText.values()].map((p) => ({
    ...p,
    starred: stars.has(p.key),
  }));

  // Default order: starred, then proven, then recent. "Proven" means the
  // archive holds evidence it worked and none that it was taken back.
  all.sort(
    (a, b) =>
      Number(b.starred) - Number(a.starred) ||
      Number(b.verified > 0 && b.corrected === 0) -
        Number(a.verified > 0 && a.corrected === 0) ||
      (b.at ?? "").localeCompare(a.at ?? ""),
  );
  return all.slice(0, 1000);
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
    (file.endsWith(".jsonl") || file.endsWith(".jsonl.zstd")) &&
    (file.startsWith(roots.claudeRoot) ||
      (roots.codexRoot !== null && file.startsWith(roots.codexRoot)) ||
      (roots.dshRoot != null && file.startsWith(roots.dshRoot)));

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
          let text;
          try {
            text = (await readSessionText(s.file)).toLowerCase();
          } catch {
            continue; // e.g. .zstd on a Node without zstd
          }
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
      send(res, 200, "application/x-ndjson", await readSessionText(file));
      return true;
    }

    if (url.pathname === "/api/prompts") {
      send(
        res,
        200,
        "application/json",
        JSON.stringify(await collectPrompts(roots)),
      );
      return true;
    }

    if (url.pathname === "/api/prompts/star" && req.method === "POST") {
      const key = url.searchParams.get("key") ?? "";
      if (!/^[0-9a-f]{40}$/.test(key)) {
        send(res, 400, "text/plain", "bad key");
        return true;
      }
      const starred = await toggleStar(key);
      send(res, 200, "application/json", JSON.stringify({ key, starred }));
      return true;
    }
  } catch (err) {
    send(res, 500, "text/plain", String(err));
    return true;
  }

  return false;
}
