#!/usr/bin/env node
/**
 * foolscap CLI — the agent-facing surface.
 *
 *   node cli.ts list [--project <substr>]     recent sessions, newest first
 *   node cli.ts export <id-prefix|latest> [-o out.html] [--project <substr>]
 *   node cli.ts path <id-prefix|latest>       print a session's JSONL path
 *
 * Pure Node (24+ runs TypeScript directly), read-only, no dependencies
 * beyond the repo's own parser and exporter. Exports from the CLI render
 * assistant text as escaped plain text — markdown rendering is
 * browser-only, where sanitization is available.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSession, prettyProjectName } from "./src/model.ts";
import { exportSessionHtml } from "./src/export.ts";

const ROOT = join(homedir(), ".claude", "projects");

type Row = {
  id: string;
  file: string;
  project: string;
  bytes: number;
  modified: number;
};

async function scan(projectFilter?: string): Promise<Row[]> {
  const rows: Row[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir(ROOT);
  } catch {
    return rows;
  }
  for (const dir of dirs) {
    if (projectFilter && !dir.toLowerCase().includes(projectFilter.toLowerCase()))
      continue;
    let entries;
    try {
      entries = await readdir(join(ROOT, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const file = join(ROOT, dir, e.name);
      const s = await stat(file);
      if (s.size === 0) continue;
      rows.push({
        id: e.name.replace(/\.jsonl$/, ""),
        file,
        project: dir,
        bytes: s.size,
        modified: s.mtimeMs,
      });
    }
  }
  rows.sort((a, b) => b.modified - a.modified);
  return rows;
}

function pick(rows: Row[], ref: string): Row | undefined {
  if (ref === "latest") return rows[0];
  return rows.find((r) => r.id.startsWith(ref));
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

if (cmd === "list") {
  const rows = await scan(arg("--project"));
  if (rows.length === 0) {
    console.log("no sessions found under ~/.claude/projects");
    process.exit(0);
  }
  for (const r of rows.slice(0, 30)) {
    const when = new Date(r.modified).toISOString().slice(0, 16).replace("T", " ");
    const kb = String(Math.round(r.bytes / 1024)).padStart(6);
    console.log(
      `${r.id.slice(0, 8)}  ${when}  ${kb} KB  ${prettyProjectName(r.project)}`,
    );
  }
} else if (cmd === "export" || cmd === "path") {
  const ref = process.argv[3];
  if (!ref) {
    console.error(`usage: cli.ts ${cmd} <id-prefix|latest>`);
    process.exit(1);
  }
  const rows = await scan(arg("--project"));
  const row = pick(rows, ref);
  if (!row) {
    console.error(`no session matching "${ref}"`);
    process.exit(1);
  }
  if (cmd === "path") {
    console.log(row.file);
  } else {
    const doc = parseSession(await readFile(row.file, "utf8"));
    const out = resolve(arg("-o") ?? `foolscap-${row.id.slice(0, 8)}.html`);
    await writeFile(out, exportSessionHtml(doc, `${row.id.slice(0, 8)} — foolscap`));
    console.log(
      `exported ${doc.cells.length} cells (${doc.meta.totalOutputTokens} tokens out) -> ${out}`,
    );
    console.log(
      "note: exports include tool inputs/results verbatim — review for secrets before sharing.",
    );
  }
} else {
  console.log("foolscap — the notebook for coding agents");
  console.log("  node cli.ts list [--project <substr>]");
  console.log("  node cli.ts export <id-prefix|latest> [-o out.html]");
  console.log("  node cli.ts path <id-prefix|latest>");
}
