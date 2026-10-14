/**
 * OpenCode archive discovery — sessions live in SQLite, not files.
 *
 * OpenCode keeps `opencode.db` under its data directory
 * (`OPENCODE_DATA_DIR`, default `~/.local/share/opencode`): a `session`
 * table (directory, title, tokens…), a `message` table whose `data`
 * column is the message JSON (role, model, tokens, time), and a `part`
 * table whose `data` is a part JSON (text / reasoning / tool with
 * state.{status,input,output,title} / step-start / step-finish).
 *
 * The rest of foolscap thinks in "session text": one file, one string,
 * parsed by an adapter. So a session here is addressed by a reference
 * (`opencode://<id>?db=<path>`) that the server expands into NDJSON —
 * a header line, then each message followed by its parts — and the
 * adapter parses that. The database is opened read-only, through
 * Node's built-in SQLite (22.5+), feature-detected: without it,
 * OpenCode sessions are simply absent rather than an error.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let sqlite = null;
try {
  // node:sqlite prints an ExperimentalWarning on import; the boot banner
  // is not the place for it.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w).includes("SQLite")) return undefined;
    return emit.call(process, w, ...rest);
  };
  try {
    sqlite = await import("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
} catch {
  sqlite = null;
}

export const hasSqlite = sqlite !== null;

export const opencodeDataDir = () =>
  process.env.OPENCODE_DATA_DIR || join(homedir(), ".local", "share", "opencode");

/** The database path under a data dir, or null if OpenCode isn't there. */
export function opencodeDb(root) {
  const p = join(root, "opencode.db");
  return existsSync(p) ? p : null;
}

export const OPENCODE_SCHEME = "opencode://";

export const opencodeRef = (dbPath, id) =>
  `${OPENCODE_SCHEME}${id}?db=${encodeURIComponent(dbPath)}`;

/** @returns {{id: string, db: string} | null} */
export function parseOpencodeRef(file) {
  if (typeof file !== "string" || !file.startsWith(OPENCODE_SCHEME)) return null;
  const rest = file.slice(OPENCODE_SCHEME.length);
  const q = rest.indexOf("?db=");
  if (q === -1) return null;
  return { id: rest.slice(0, q), db: decodeURIComponent(rest.slice(q + 4)) };
}

function open(dbPath) {
  return new sqlite.DatabaseSync(dbPath, { readOnly: true });
}

/** Group top-level sessions by their project directory. */
export function scanOpencode(root) {
  const dbPath = opencodeDb(root);
  if (!dbPath || !hasSqlite) return [];
  let db;
  try {
    db = open(dbPath);
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `select s.id, s.directory, s.title, s.time_updated, s.time_created,
           (select coalesce(sum(length(p.data)), 0) from part p where p.session_id = s.id)
           + (select coalesce(sum(length(m.data)), 0) from message m where m.session_id = s.id) as bytes
         from session s
         where s.parent_id is null
         order by s.time_updated desc`,
      )
      .all();
    const byDir = new Map();
    for (const r of rows) {
      if (!r.bytes) continue;
      const dir = r.directory || "(unknown project)";
      const key = dir.toLowerCase();
      const group = byDir.get(key) ?? { display: dir, sessions: [] };
      group.sessions.push({
        id: r.id,
        title: r.title || undefined,
        file: opencodeRef(dbPath, r.id),
        bytes: Number(r.bytes),
        modified: Number(r.time_updated ?? r.time_created ?? 0),
      });
      byDir.set(key, group);
    }
    return [...byDir.values()].map(({ display, sessions }) => ({
      source: "opencode",
      dir: display,
      sessions,
    }));
  } finally {
    db.close();
  }
}

const jsonOr = (v, fallback) => {
  if (typeof v !== "string") return v ?? fallback;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** Expand one session into NDJSON the adapter can parse. */
export function readOpencodeSession(dbPath, id) {
  if (!hasSqlite) throw new Error("reading OpenCode sessions needs Node 22.5+ (built-in SQLite)");
  const db = open(dbPath);
  try {
    const s = db
      .prepare(
        `select id, parent_id, directory, title, version, model, agent, cost,
                tokens_input, tokens_output, time_created, time_updated
         from session where id = ?`,
      )
      .get(id);
    if (!s) throw new Error(`no OpenCode session ${id}`);
    const lines = [
      JSON.stringify({
        type: "opencode-session",
        id: s.id,
        parentID: s.parent_id,
        directory: s.directory,
        title: s.title,
        version: s.version,
        model: jsonOr(s.model, null),
        agent: s.agent,
        cost: s.cost,
        tokens: { input: s.tokens_input, output: s.tokens_output },
        time: { created: s.time_created, updated: s.time_updated },
      }),
    ];
    const messages = db
      .prepare(`select id, time_created, data from message where session_id = ? order by time_created, id`)
      .all(id);
    const partsByMessage = new Map();
    for (const p of db
      .prepare(`select id, message_id, time_created, data from part where session_id = ? order by time_created, id`)
      .all(id)) {
      const list = partsByMessage.get(p.message_id) ?? [];
      list.push(p);
      partsByMessage.set(p.message_id, list);
    }
    // The stored JSON has its own `type` (text, tool, …); the line's
    // `type` says what the line is, so the part's becomes `partType`.
    for (const m of messages) {
      const data = jsonOr(m.data, {});
      lines.push(JSON.stringify({ ...data, type: "message", id: m.id, time_created: m.time_created }));
      for (const p of partsByMessage.get(m.id) ?? []) {
        const pd = jsonOr(p.data, {});
        lines.push(
          JSON.stringify({
            ...pd,
            type: "part",
            partType: pd.type ?? "other",
            id: p.id,
            messageID: m.id,
            time_created: p.time_created,
          }),
        );
      }
    }
    return lines.join("\n") + "\n";
  } finally {
    db.close();
  }
}
