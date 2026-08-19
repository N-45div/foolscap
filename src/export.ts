import type { Cell, SessionDoc, ToolInteraction } from "./model";

/**
 * Export a session as a single self-contained HTML document.
 *
 * Design constraints: no JavaScript in the output (collapse/expand is
 * native <details>), no external requests, both themes via
 * prefers-color-scheme, and every piece of session content HTML-escaped —
 * transcripts are arbitrary untrusted text.
 *
 * The exported file is the distribution loop: it must read beautifully
 * when opened from disk, hosted anywhere, or screenshotted.
 */

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const clip = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + "\n… [truncated for export]" : s;

const time = (iso?: string): string => {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

const tokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function toolSummary(t: ToolInteraction): string {
  const i = t.input;
  const first = (...keys: string[]) => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  switch (t.name) {
    case "Bash":
    case "PowerShell":
    case "shell_command":
    case "shell":
      return first("command").split("\n")[0].slice(0, 110);
    case "Read":
    case "Write":
    case "Edit":
      return first("file_path");
    case "Glob":
    case "Grep":
      return first("pattern");
    case "WebFetch":
      return first("url");
    case "WebSearch":
      return first("query");
    case "Agent":
      return first("description");
    default: {
      const s = JSON.stringify(i);
      return s === "{}" ? "" : s.slice(0, 110);
    }
  }
}

function toolHtml(t: ToolInteraction, at?: string): string {
  const oldS = typeof t.input.old_string === "string" ? t.input.old_string : "";
  const newS = typeof t.input.new_string === "string" ? t.input.new_string : "";
  const written = typeof t.input.content === "string" ? t.input.content : "";

  let body = "";
  if (t.name === "Edit" && (oldS || newS)) {
    body +=
      (oldS ? `<pre class="d-old">${esc(clip(oldS, 3000))}</pre>` : "") +
      (newS ? `<pre class="d-new">${esc(clip(newS, 3000))}</pre>` : "");
  } else if (t.name === "Write" && written) {
    body += `<pre class="d-new">${esc(clip(written, 3000))}</pre>`;
  } else if (Object.keys(t.input).length > 0) {
    body += `<pre class="io">${esc(clip(JSON.stringify(t.input, null, 2), 1500))}</pre>`;
  }
  if (t.result) {
    body += `<pre class="io${t.isError ? " err" : ""}">${esc(clip(t.result, 6000))}</pre>`;
  }

  return `<details class="tool">
<summary><span class="tname${t.isError ? " terr" : ""}">${esc(t.name)}</span><span class="tsum">${esc(toolSummary(t))}</span><span class="tat">${t.isError ? "ERR " : ""}${time(at)}</span></summary>
${body}
</details>`;
}

/** Optional markdown renderer — the browser injects marked+DOMPurify;
    Node callers omit it and get escaped plain text. Must sanitize. */
type MdRender = (text: string) => string;

function cellHtml(cell: Cell, index: number, md?: MdRender): string {
  const toolCount = cell.parts.filter((p) => p.kind === "tool").length;

  const parts = cell.parts
    .map((p) => {
      if (p.kind === "text")
        return md
          ? `<div class="say md">${md(clip(p.text, 12_000))}</div>`
          : `<div class="say plain">${esc(clip(p.text, 12_000))}</div>`;
      if (p.kind === "thinking")
        return `<details class="think"><summary>thinking</summary><div>${esc(clip(p.text, 3000))}</div></details>`;
      return toolHtml(p.tool, p.at);
    })
    .join("\n");

  const stats =
    toolCount > 0 || cell.outputTokens > 0
      ? `<p class="cellstats">${toolCount} tool ${toolCount === 1 ? "call" : "calls"}${
          cell.outputTokens > 0 ? ` · ${tokens(cell.outputTokens)} tokens out` : ""
        }</p>`
      : "";

  return `<article class="cell" id="cell-${index + 1}">
<header><a class="n" href="#cell-${index + 1}">[${index + 1}]</a><div class="prompt">${esc(clip(cell.prompt, 4000))}</div><span class="at">${time(cell.promptAt)}</span></header>
${stats}
${parts}
</article>`;
}

export function exportSessionHtml(
  doc: SessionDoc,
  title: string,
  md?: MdRender,
): string {
  const m = doc.meta;
  const day = m.startedAt
    ? new Date(m.startedAt).toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";

  const provenance = [
    m.cwd,
    m.gitBranch ? `⎇ ${m.gitBranch}` : "",
    `${doc.cells.length} cells`,
    m.totalOutputTokens > 0 ? `${tokens(m.totalOutputTokens)} tokens out` : "",
    m.agent ?? "",
    day,
  ]
    .filter(Boolean)
    .map((s) => `<span>${esc(String(s))}</span>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--paper:#f1f3f2;--raised:#fff;--sunk:#e7eae9;--ink:#11151a;--ink2:#3d464f;--ink3:#6b767f;--rule:#d3d8d8;--brass:#96601f;--brassb:#a96f2e;--brassw:rgb(150 96 31/.09);--oxide:#a63722;--oxidew:rgb(166 55 34/.08);--moss:#2f6349;--mossw:rgb(47 99 73/.07)}
@media(prefers-color-scheme:dark){:root{--paper:#0f1317;--raised:#171c21;--sunk:#0a0d10;--ink:#edefee;--ink2:#aeb7bc;--ink3:#79848b;--rule:#262d33;--brass:#d6a05c;--brassb:#e3b173;--brassw:rgb(214 160 92/.09);--oxide:#e1745c;--oxidew:rgb(225 116 92/.1);--moss:#6fbf97;--mossw:rgb(111 191 151/.08)}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
.mono,pre,summary,.provenance,.cellstats,.prompt,.n,.at{font-family:ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;font-variant-numeric:lining-nums tabular-nums}
.doc{max-width:900px;margin:0 auto;padding:0 16px 64px}
.provenance{display:flex;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--rule);padding:12px 0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}
.cell{border-bottom:1px solid var(--rule);scroll-margin-top:8px}
.cell:target>header{box-shadow:inset 2px 0 0 var(--brassb)}
a.n{text-decoration:none}
a.n:hover{text-decoration:underline}
.cell>header{display:grid;grid-template-columns:3rem 1fr auto;gap:12px;background:var(--sunk);padding:12px 16px;margin:0 -16px}
.n{color:var(--brassb);font-size:12px;padding-top:2px}
.at{color:var(--ink3);font-size:10px;padding-top:3px}
.prompt{white-space:pre-wrap;font-size:13.5px;margin:0}
.cellstats{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:10px 0 2px}
.say{max-width:80ch;padding:8px 0;font-size:14px}
.say.plain{white-space:pre-wrap}
.md :is(h1,h2,h3,h4){font-weight:700;margin:1.1em 0 .4em;line-height:1.25}
.md h1{font-size:1.25rem}.md h2{font-size:1.1rem}.md h3,.md h4{font-size:1rem}
.md p{margin:.5em 0}
.md a{color:var(--brassb);text-decoration:underline;text-underline-offset:2px}
.md ul,.md ol{margin:.5em 0;padding-left:1.4em}
.md li{margin:.2em 0}
.md code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.86em;background:var(--sunk);border:1px solid var(--rule);padding:.08em .35em;border-radius:2px}
.md pre{background:var(--sunk);color:var(--ink2)}
.md pre code{background:none;border:none;padding:0}
.md blockquote{border-left:2px solid var(--rule);margin:.6em 0;padding-left:1em;color:var(--ink2)}
.md table{border-collapse:collapse;margin:.6em 0;display:block;overflow-x:auto}
.md th,.md td{border:1px solid var(--rule);padding:.3em .7em;font-size:.85rem;text-align:left}
.md th{background:var(--sunk);font-weight:600}
.md :first-child{margin-top:0}.md :last-child{margin-bottom:0}
details.tool{border-bottom:1px solid var(--rule)}
details.tool:last-child{border-bottom:0}
details.tool>summary{display:grid;grid-template-columns:6.5rem 1fr auto;gap:12px;align-items:baseline;padding:6px 4px;cursor:pointer;list-style:none;font-size:12px}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary:hover{background:var(--brassw)}
.tname{color:var(--brassb);font-weight:600}
.terr{color:var(--oxide)}
.tsum{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tat{color:var(--ink3);font-size:10px}
pre{white-space:pre-wrap;overflow-x:auto;border:1px solid var(--rule);padding:8px 12px;margin:6px 0;font-size:12px;line-height:1.55}
pre.io{background:var(--sunk);color:var(--ink2);max-height:420px;overflow-y:auto}
pre.io.err{background:var(--oxidew);color:var(--oxide)}
pre.d-old{background:var(--oxidew);color:var(--oxide);margin-bottom:0}
pre.d-new{background:var(--mossw);color:var(--moss);margin-top:0}
details.think>summary{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);cursor:pointer;padding:4px 0}
details.think>div{white-space:pre-wrap;border-left:2px solid var(--rule);padding:6px 0 6px 12px;color:var(--ink3);font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}
.foot{margin-top:32px;padding-top:12px;border-top:1px solid var(--rule);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);font-family:ui-monospace,Menlo,Consolas,monospace}
.foot a{color:var(--brassb);text-decoration:none}
</style>
</head>
<body>
<div class="doc">
<div class="provenance">${provenance}</div>
${doc.cells.map((c, i) => cellHtml(c, i, md)).join("\n")}
<p class="foot">session document · rendered by <a href="https://github.com/N-45div/foolscap">foolscap</a> — the notebook for coding agents</p>
</div>
</body>
</html>`;
}

/** Trigger a browser download of the exported document. */
export async function downloadSessionHtml(
  doc: SessionDoc,
  name: string,
): Promise<void> {
  // Loaded here, not at module top: keeps exportSessionHtml importable
  // from Node (the CLI), where DOMPurify has no DOM to purify with.
  const { markdownForExport } = await import("./markdown");
  const html = exportSessionHtml(doc, `${name} — foolscap`, markdownForExport);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `foolscap-${name}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
