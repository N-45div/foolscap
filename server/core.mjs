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
import { handleFleetApi } from "./fleet-api.mjs";
import { acpArchiveDir } from "./acp.mjs";
import {
  opencodeDataDir,
  opencodeDb,
  parseOpencodeRef,
  readOpencodeSession,
  scanOpencode,
} from "./opencode.mjs";

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
  // OpenCode sessions live in SQLite; the reference names the row.
  const oc = parseOpencodeRef(file);
  if (oc) return readOpencodeSession(oc.db, oc.id);
  if (!file.endsWith(".zstd")) return readFile(file, "utf8");
  if (!hasZstd) {
    throw new Error(
      "this dsh session is zstd-compressed — reading it needs Node 22.15+ (built-in zstd)",
    );
  }
  const raw = await readFile(file);
  return zlib.zstdDecompressSync(raw).toString("utf8");
}

// ── Session titles ───────────────────────────────────────────────────
// A session is easier to find by what you asked than by a hex id. Each
// scanner reads the head of the file and takes the first real prompt.

const MAX_TITLE = 90;
const oneLine = (t) => {
  const s = String(t).replace(/\s+/g, " ").trim();
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1) + "…" : s;
};

/** The first 64KB of a file — enough to find the first prompt. */
async function readHead(file, bytes = 65536) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Walk the head's lines (a truncated last line just fails to parse). */
function titleFromLines(head, pick) {
  for (const line of head.split(LINE_BREAK)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = pick(e);
    if (t) return oneLine(t);
  }
  return undefined;
}

const synthetic = (t) => !t || t.startsWith("<") || t.startsWith("[");

const claudeTitle = (head) =>
  titleFromLines(head, (e) => {
    if (e?.type !== "user" || e.isSidechain) return undefined;
    const c = e.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c))
      text = c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(" ");
    text = text.trim();
    return synthetic(text) ? undefined : text;
  });

const CODEX_IDE_MARKER = "## My request for Codex:";
const codexTitle = (head) =>
  titleFromLines(head, (e) => {
    const p = e?.payload;
    if (e?.type !== "response_item" || p?.type !== "message" || p.role !== "user") return undefined;
    if (!Array.isArray(p.content)) return undefined;
    let t = p.content.map((b) => b?.text ?? "").join(" ").trim();
    if (t.startsWith("# Context from my IDE setup")) {
      const i = t.indexOf(CODEX_IDE_MARKER);
      t = i === -1 ? "" : t.slice(i + CODEX_IDE_MARKER.length).trim();
    }
    return synthetic(t) ? undefined : t;
  });

const dshTitle = (head) =>
  titleFromLines(head, (e) => {
    if (e?.type !== "user/message") return undefined;
    const m = e.data?.message;
    let text = "";
    if (typeof m === "string") text = m;
    else if (typeof m?.text === "string") text = m.text;
    else if (typeof m?.content === "string") text = m.content;
    else if (Array.isArray(m?.content))
      text = m.content.map((b) => (typeof b === "string" ? b : (b?.text ?? ""))).join(" ");
    text = text.trim();
    return synthetic(text) ? undefined : text;
  });

const acpTitle = (head) =>
  titleFromLines(head, (e) => {
    if (e?.type === "foolscap-acp") return e.name || undefined;
    if (e?.dir !== "c2a") return undefined;
    const m = e.msg ?? {};
    if (m.method === "session/prompt") {
      return (m.params?.prompt ?? []).map((b) => b?.text ?? "").join(" ").trim() || undefined;
    }
    if (m.type === "user") {
      const c = m.message?.content;
      const t = Array.isArray(c) ? c.map((b) => b?.text ?? "").join(" ") : String(c ?? "");
      return t.trim() || undefined;
    }
    if (m.type === "devin/prompt") return String(m.text ?? "").trim() || undefined;
    return undefined;
  });

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
    const a = join(fixtureRoot, "acp");
    const o = join(fixtureRoot, "opencode");
    return {
      claudeRoot: existsSync(c) ? c : fixtureRoot,
      codexRoot: existsSync(x) ? x : null,
      dshRoot: existsSync(d) ? d : null,
      acpRoot: existsSync(a) ? a : null,
      opencodeRoot: opencodeDb(o) ? o : null,
    };
  }
  const opencode = opencodeDataDir();
  return {
    claudeRoot: join(homedir(), ".claude", "projects"),
    codexRoot: join(homedir(), ".codex", "sessions"),
    // dsh honors DSH_HOME the same way dsh itself does.
    dshRoot: process.env.DSH_HOME || join(homedir(), ".dsh"),
    // Sessions foolscap itself ran, through the fleet or the bridge.
    acpRoot: acpArchiveDir(),
    // OpenCode: a SQLite database under its data dir, if it's installed.
    opencodeRoot: opencodeDb(opencode) ? opencode : null,
  };
}

/** Fleet/bridge recordings: ~/.foolscap/acp/<id>.jsonl, header line
    carries cwd, name and agent. */
async function scanAcp(root) {
  const byCwd = new Map();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const full = join(root, e.name);
    const s = await stat(full);
    if (s.size === 0) continue;

    let cwd = "(unknown project)";
    let title;
    try {
      const head = await readHead(full);
      const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
      if (raw) cwd = JSON.parse(`"${raw}"`);
      title = acpTitle(head);
    } catch {
      // unreadable header — keep the unknown-project bucket
    }

    const key = cwd.toLowerCase();
    const group = byCwd.get(key) ?? { display: cwd, sessions: [] };
    group.sessions.push({
      id: e.name.replace(/\.jsonl$/, ""),
      title,
      file: full,
      bytes: s.size,
      modified: s.mtimeMs,
    });
    byCwd.set(key, group);
  }
  return [...byCwd.values()].map(({ display, sessions }) => {
    sessions.sort((a, b) => b.modified - a.modified);
    return { source: "acp", dir: display, sessions };
  });
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
        title: claudeTitle(await readHead(file).catch(() => "")),
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
      let title;
      try {
        const head = await readHead(full);
        const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (raw) cwd = JSON.parse(`"${raw}"`);
        title = codexTitle(head);
      } catch {
        // unreadable head — keep the unknown-project bucket
      }

      const id =
        /rollout-[\d T:-]+-([0-9a-f-]{36})\.jsonl$/i.exec(e.name)?.[1] ??
        e.name.replace(/\.jsonl$/, "");
      const key = cwd.toLowerCase();
      const group = byCwd.get(key) ?? { display: cwd, sessions: [] };
      group.sessions.push({ id, title, file: full, bytes: s.size, modified: s.mtimeMs });
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
      let title;
      try {
        let head = "";
        if (full.endsWith(".zstd")) {
          if (!hasZstd || s.size > 8 * 1024 * 1024) throw new Error("skip");
          head = zlib
            .zstdDecompressSync(await readFile(full))
            .toString("utf8", 0, 65536);
        } else {
          head = await readHead(full);
        }
        const raw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (raw) cwd = JSON.parse(`"${raw}"`);
        title = dshTitle(head);
      } catch {
        // unreadable header — keep the unknown-project bucket
      }

      // Directory name is encodeSegment(sessionId) — the stable id.
      const id = dir.split(/[\\/]/).pop() ?? e.name;
      const key = cwd.toLowerCase();
      const group = byCwd.get(key) ?? { display: cwd, sessions: [] };
      group.sessions.push({ id, title, file: full, bytes: s.size, modified: s.mtimeMs });
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
    ...(roots.acpRoot ? await scanAcp(roots.acpRoot) : []),
    ...(roots.opencodeRoot ? scanOpencode(roots.opencodeRoot) : []),
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

  const allowed = (file) => {
    const oc = parseOpencodeRef(file);
    if (oc) return roots.opencodeRoot != null && oc.db.startsWith(roots.opencodeRoot);
    return (
      (file.endsWith(".jsonl") || file.endsWith(".jsonl.zstd")) &&
      (file.startsWith(roots.claudeRoot) ||
        (roots.codexRoot !== null && file.startsWith(roots.codexRoot)) ||
        (roots.dshRoot != null && file.startsWith(roots.dshRoot)) ||
        (roots.acpRoot != null && file.startsWith(roots.acpRoot)))
    );
  };

  try {
    // The fleet has its own surface (live stream + verbs that run code).
    // Its recordings land in the archive being viewed, so what you see
    // is where new sessions go.
    const fleetOpts = { recordDir: roots.acpRoot ?? undefined };
    if (await handleFleetApi(req, res, url, fleetOpts)) return true;

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
      if (!parseOpencodeRef(file)) {
        const s = await stat(file);
        if (s.size > MAX_SESSION_BYTES) {
          send(
            res,
            413,
            "text/plain",
            `session is ${Math.round(s.size / 1048576)} MB — too large for the viewer`,
          );
          return true;
        }
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
