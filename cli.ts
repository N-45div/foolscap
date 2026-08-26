#!/usr/bin/env node
/**
 * foolscap CLI — the agent-facing surface.
 *
 *   node cli.ts list [--project <substr>] [--source <claude|codex|dsh>]
 *   node cli.ts prompts [--filter <substr>] [--starred] [-n <count>]
 *   node cli.ts export <id-prefix|latest> [-o out.html] [--project <substr>]
 *   node cli.ts path <id-prefix|latest>
 *
 * Pure Node (24+ runs TypeScript directly), read-only, no dependencies
 * beyond the repo's own parser, exporter and scanner. Discovery and
 * decompression come from server/core.mjs — the same code the viewer
 * uses — so every harness the viewer reads, the CLI reads too.
 *
 * Exports from the CLI render assistant text as escaped plain text —
 * markdown rendering is browser-only, where sanitization is available.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSession, prettyProjectName } from "./src/model.ts";
import { parseCodexSession } from "./src/sources/codex.ts";
import { parseDshSession } from "./src/sources/dsh.ts";
import { exportSessionHtml } from "./src/export.ts";
import {
  collectPrompts,
  readSessionText,
  resolveRoots,
  scanAll,
} from "./server/core.mjs";

/** The harness registry, resolved with explicit .ts specifiers: Node
    runs this file directly and does not do bundler-style resolution. */
type SourceId = "claude" | "codex" | "dsh";
const SOURCES = {
  claude: { label: "claude code", parse: parseSession },
  codex: { label: "codex", parse: parseCodexSession },
  dsh: { label: "deepseek dsh", parse: parseDshSession },
} as const;

type Row = {
  id: string;
  file: string;
  source: SourceId;
  project: string;
  bytes: number;
  modified: number;
};

const roots = resolveRoots(process.env.FOOLSCAP_ROOT);

async function scan(projectFilter?: string, sourceFilter?: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (const g of await scanAll(roots)) {
    if (sourceFilter && g.source !== sourceFilter) continue;
    if (
      projectFilter &&
      !g.dir.toLowerCase().includes(projectFilter.toLowerCase())
    )
      continue;
    for (const s of g.sessions) {
      rows.push({ ...s, source: g.source as SourceId, project: g.dir });
    }
  }
  rows.sort((a, b) => b.modified - a.modified);
  return rows;
}

const projectLabel = (r: Row): string =>
  r.source === "claude" ? prettyProjectName(r.project) : r.project;

function pick(rows: Row[], ref: string): Row | undefined {
  if (ref === "latest") return rows[0];
  return rows.find((r) => r.id.startsWith(ref));
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);

const cmd = process.argv[2];

if (cmd === "list") {
  const rows = await scan(arg("--project"), arg("--source"));
  if (rows.length === 0) {
    console.log("no sessions found (looked for claude code, codex and dsh archives)");
    process.exit(0);
  }
  for (const r of rows.slice(0, Number(arg("-n") ?? 30))) {
    const when = new Date(r.modified).toISOString().slice(0, 16).replace("T", " ");
    const kb = String(Math.round(r.bytes / 1024)).padStart(6);
    const src = (SOURCES[r.source]?.label ?? r.source).padEnd(12);
    console.log(`${r.id.slice(0, 8)}  ${when}  ${kb} KB  ${src}  ${projectLabel(r)}`);
  }
} else if (cmd === "prompts") {
  // The prompt shelf, for agents: every prompt ever sent, deduped.
  const filter = (arg("--filter") ?? "").toLowerCase();
  const limit = Number(arg("-n") ?? 40);
  let prompts = await collectPrompts(roots);
  if (has("--starred")) prompts = prompts.filter((p) => p.starred);
  if (filter) prompts = prompts.filter((p) => p.text.toLowerCase().includes(filter));
  if (prompts.length === 0) {
    console.log("no prompts matched");
    process.exit(0);
  }
  for (const p of prompts.slice(0, limit)) {
    const mark = p.starred ? "*" : " ";
    const uses = p.count > 1 ? `${p.count}x` : "  ";
    const day = p.at ? p.at.slice(0, 10) : "          ";
    const src = (SOURCES[p.source as SourceId]?.label ?? p.source).padEnd(12);
    const text = p.text.replace(/\s+/g, " ").slice(0, 96);
    console.log(`${mark} ${day}  ${uses.padStart(4)}  ${src}  ${text}`);
  }
  console.log(`\n${prompts.length} prompt(s); * = starred, Nx = times reused.`);
} else if (cmd === "export" || cmd === "path") {
  const ref = process.argv[3];
  if (!ref) {
    console.error(`usage: cli.ts ${cmd} <id-prefix|latest>`);
    process.exit(1);
  }
  const rows = await scan(arg("--project"), arg("--source"));
  const row = pick(rows, ref);
  if (!row) {
    console.error(`no session matching "${ref}"`);
    process.exit(1);
  }
  if (cmd === "path") {
    console.log(row.file);
  } else {
    const parse = SOURCES[row.source]?.parse;
    if (!parse) {
      console.error(`no adapter for source "${row.source}"`);
      process.exit(1);
    }
    const doc = parse(await readSessionText(row.file));
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
  console.log("  node cli.ts list [--project <substr>] [--source claude|codex|dsh]");
  console.log("  node cli.ts prompts [--filter <substr>] [--starred] [-n 40]");
  console.log("  node cli.ts export <id-prefix|latest> [-o out.html]");
  console.log("  node cli.ts path <id-prefix|latest>");
}
