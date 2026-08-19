import { useEffect, useRef, useState } from "react";
import { parseSession } from "./model";
import type { Cell, SessionDoc, ToolInteraction } from "./model";
import { downloadSessionHtml } from "./export";
import { Markdown } from "./markdown";

/**
 * A session rendered as a document: each prompt opens a numbered cell,
 * the agent's work nests inside it. Density rules: mono for machine
 * output, tabular numerals, hairline rules, one accent.
 */

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Tool rendering ────────────────────────────────────────────────────

/** One-line summary of a tool call — the ledger row. */
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
      return first("command").split("\n")[0].slice(0, 120);
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
      return s === "{}" ? "" : s.slice(0, 120);
    }
  }
}

function EditDiff({ input }: { input: Record<string, unknown> }) {
  const oldS = typeof input.old_string === "string" ? input.old_string : "";
  const newS = typeof input.new_string === "string" ? input.new_string : "";
  if (!oldS && !newS) return null;
  return (
    <div className="mt-2 overflow-x-auto border border-rule font-mono text-xs leading-relaxed">
      {oldS && (
        <pre className="whitespace-pre-wrap bg-oxide-wash px-3 py-2 text-oxide">
          {oldS.slice(0, 4000)}
        </pre>
      )}
      {newS && (
        <pre className="whitespace-pre-wrap border-t border-rule bg-moss-wash px-3 py-2 text-moss">
          {newS.slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}

function ToolBlock({
  tool,
  at,
  sessionFile,
}: {
  tool: ToolInteraction;
  at?: string;
  sessionFile?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(tool);
  const hasBody =
    tool.name === "Edit" ||
    tool.name === "Write" ||
    Boolean(tool.result) ||
    Object.keys(tool.input).length > 0;

  return (
    <div className="border-b border-rule last:border-b-0">
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        className="grid w-full grid-cols-[6.5rem_1fr_auto] items-baseline gap-3 px-3 py-1.5 text-left hover:bg-brass-wash"
        aria-expanded={open}
      >
        <span
          className={`font-mono text-xs font-semibold ${
            tool.isError ? "text-oxide" : "text-brass-bright"
          }`}
        >
          {tool.name}
        </span>
        <span className="truncate font-mono text-xs text-ink-2">
          {summary}
        </span>
        <span className="tnum font-mono text-[10px] text-ink-3">
          {tool.isError ? "ERR " : ""}
          {fmtTime(at)}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          {tool.name === "Edit" && <EditDiff input={tool.input} />}
          {tool.name === "Write" && typeof tool.input.content === "string" && (
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap border border-rule bg-moss-wash px-3 py-2 font-mono text-xs text-moss">
              {tool.input.content.slice(0, 4000)}
            </pre>
          )}
          {tool.name !== "Edit" && tool.name !== "Write" && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap border border-rule bg-paper-sunk px-3 py-2 font-mono text-xs text-ink-2">
              {JSON.stringify(tool.input, null, 2).slice(0, 2000)}
            </pre>
          )}
          {tool.result && (
            <pre
              className={`mt-2 max-h-80 overflow-auto whitespace-pre-wrap border border-rule px-3 py-2 font-mono text-xs ${
                tool.isError
                  ? "bg-oxide-wash text-oxide"
                  : "bg-paper-sunk text-ink-2"
              }`}
            >
              {tool.result.slice(0, 8000)}
            </pre>
          )}
          {tool.subagentId && (
            <SubagentSection
              subagentId={tool.subagentId}
              inline={tool.subagent}
              sessionFile={sessionFile}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A subagent's transcript, rendered as a nested document inside the
 * Agent call that launched it. Modern sessions store these as separate
 * files (<session-id>/subagents/agent-<id>.jsonl), so the transcript is
 * fetched on demand; older in-file sidechains arrive pre-parsed.
 */
function SubagentSection({
  subagentId,
  inline,
  sessionFile,
}: {
  subagentId: string;
  inline?: SessionDoc;
  sessionFile?: string;
}) {
  const [doc, setDoc] = useState<SessionDoc | null>(inline ?? null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "missing">("idle");

  const toggle = async () => {
    if (doc) {
      setOpen(!open);
      return;
    }
    if (!sessionFile) return;
    setState("loading");
    // All subagent files live flat under the top session's directory,
    // so the original session file stays the base even when nesting.
    const sep = sessionFile.includes("\\") ? "\\" : "/";
    const base = sessionFile.replace(/\.jsonl$/i, "");
    const path = `${base}${sep}subagents${sep}agent-${subagentId}.jsonl`;
    try {
      const r = await fetch(`/api/session?file=${encodeURIComponent(path)}`);
      if (!r.ok) throw new Error(String(r.status));
      setDoc(parseSession(await r.text()));
      setOpen(true);
      setState("idle");
    } catch {
      setState("missing");
    }
  };

  const toolCount =
    doc?.cells.reduce(
      (n, c) => n + c.parts.filter((p) => p.kind === "tool").length,
      0,
    ) ?? 0;

  if (state === "missing") {
    return (
      <p className="instrument mt-2">
        ⑂ {subagentId.slice(0, 9)} · transcript not found on disk
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="instrument border border-rule-strong px-2.5 py-1 transition-colors hover:border-brass-bright hover:text-brass-bright"
      >
        ⑂ subagent {subagentId.slice(0, 9)}
        {state === "loading" && " · loading…"}
        {doc &&
          ` · ${doc.cells.length} ${doc.cells.length === 1 ? "cell" : "cells"} · ${toolCount} tool calls`}
        {!doc && state === "idle" && " · open transcript"}
      </button>

      {open && doc && (
        <div className="mt-2 border-l-2 border-rule-strong pl-3 text-[0.95em]">
          {doc.cells.map((cell, i) => (
            <CellView
              key={i}
              cell={cell}
              index={i}
              sessionFile={sessionFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Cells ─────────────────────────────────────────────────────────────

function CellView({
  cell,
  index,
  sessionFile,
  anchor,
  active,
  refCb,
}: {
  cell: Cell;
  index: number;
  sessionFile?: string;
  /** Anchor id for permalinks — only top-level cells get one. */
  anchor?: string;
  active?: boolean;
  refCb?: (el: HTMLElement | null) => void;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const toolCount = cell.parts.filter((p) => p.kind === "tool").length;
  const thinkingCount = cell.parts.filter((p) => p.kind === "thinking").length;

  return (
    <article
      id={anchor}
      ref={refCb}
      className={`scroll-mt-10 border-b border-rule border-l-2 ${
        active ? "border-l-brass-bright" : "border-l-transparent"
      }`}
    >
      {/* Prompt — the cell input */}
      <header className="grid grid-cols-[3rem_1fr_auto] gap-3 bg-paper-sunk px-5 py-3">
        {anchor ? (
          <a
            href={`#${anchor}`}
            title="Permalink to this cell (copies link)"
            onClick={() => {
              // Let the hash land first, then copy the full URL.
              setTimeout(() => {
                navigator.clipboard?.writeText(location.href).catch(() => {});
              }, 0);
            }}
            className="tnum pt-0.5 font-mono text-xs text-brass-bright hover:underline"
          >
            [{index + 1}]
          </a>
        ) : (
          <span className="tnum pt-0.5 font-mono text-xs text-brass-bright">
            [{index + 1}]
          </span>
        )}
        <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
          {cell.prompt.length > 2000
            ? cell.prompt.slice(0, 2000) + " …"
            : cell.prompt}
        </p>
        <span className="tnum pt-0.5 font-mono text-[10px] text-ink-3">
          {fmtTime(cell.promptAt)}
        </span>
      </header>

      {/* Output */}
      <div className="px-5 py-1">
        {(toolCount > 0 || thinkingCount > 0) && (
          <div className="flex items-center gap-4 py-1.5">
            <span className="instrument tnum">
              {toolCount} tool {toolCount === 1 ? "call" : "calls"}
              {cell.outputTokens > 0 &&
                ` · ${fmtTokens(cell.outputTokens)} tokens out`}
            </span>
            {thinkingCount > 0 && (
              <button
                type="button"
                onClick={() => setShowThinking(!showThinking)}
                className="instrument hover:text-ink"
              >
                {showThinking ? "hide" : "show"} thinking ({thinkingCount})
              </button>
            )}
          </div>
        )}

        {cell.parts.map((part, i) => {
          if (part.kind === "text") {
            return <Markdown key={i} text={part.text} />;
          }
          if (part.kind === "thinking") {
            if (!showThinking) return null;
            return (
              <p
                key={i}
                className="max-w-[80ch] whitespace-pre-wrap border-l-2 border-rule py-2 pl-3 font-mono text-xs leading-relaxed text-ink-3"
              >
                {part.text.slice(0, 3000)}
              </p>
            );
          }
          return (
            <ToolBlock
              key={part.tool.id}
              tool={part.tool}
              at={part.at}
              sessionFile={sessionFile}
            />
          );
        })}
      </div>
    </article>
  );
}

// ── Document ──────────────────────────────────────────────────────────

export function Notebook({
  doc,
  exportName,
  sessionFile,
}: {
  doc: SessionDoc;
  exportName: string;
  sessionFile?: string;
}) {
  const m = doc.meta;
  const [active, setActive] = useState<number | null>(null);
  const cellRefs = useRef<Array<HTMLElement | null>>([]);

  const cellFromHash = (): number | null => {
    const h = /^#cell-(\d+)$/.exec(location.hash);
    if (!h) return null;
    const i = Number(h[1]) - 1;
    return i >= 0 && i < doc.cells.length ? i : null;
  };

  // New session: reset, then honor a #cell-N deep link if one is set.
  useEffect(() => {
    cellRefs.current.length = doc.cells.length;
    const i = cellFromHash();
    setActive(i);
    if (i !== null) {
      requestAnimationFrame(() => cellRefs.current[i]?.scrollIntoView());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // Clicking a [n] permalink (or pasting a link) moves the active mark.
  useEffect(() => {
    const onHash = () => setActive(cellFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // j/k walk the cells, notebook-style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      )
        return;
      if (e.key !== "j" && e.key !== "k") return;
      e.preventDefault();
      setActive((prev) => {
        const next =
          e.key === "j"
            ? Math.min((prev ?? -1) + 1, doc.cells.length - 1)
            : Math.max((prev ?? 1) - 1, 0);
        cellRefs.current[next]?.scrollIntoView({
          block: "start",
          behavior: "smooth",
        });
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc]);

  return (
    <div>
      {/* Statement header — the provenance line */}
      <header className="sticky top-0 z-10 flex items-baseline gap-4 border-b border-rule bg-paper/90 px-5 py-2 backdrop-blur-sm">
        <p className="instrument tnum flex min-w-0 flex-1 flex-wrap gap-x-4">
          {m.cwd && <span className="truncate">{m.cwd}</span>}
          {m.gitBranch && <span>⎇ {m.gitBranch}</span>}
          <span>{doc.cells.length} cells</span>
          {m.totalOutputTokens > 0 && (
            <span>{fmtTokens(m.totalOutputTokens)} tokens out</span>
          )}
          {m.agent && <span>{m.agent}</span>}
          {m.startedAt && (
            <span>
              {new Date(m.startedAt).toLocaleDateString(undefined, {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </p>
        <span
          className="instrument tnum shrink-0"
          title="Keyboard: j / k step through cells; [n] is a permalink"
        >
          j·k
        </span>
        <button
          type="button"
          onClick={() => downloadSessionHtml(doc, exportName)}
          title="Exports everything in this session, including tool inputs and results — review for secrets before sharing."
          className="instrument shrink-0 border border-rule-strong px-2.5 py-1 transition-colors hover:border-brass-bright hover:text-brass-bright"
        >
          export html
        </button>
      </header>

      {doc.cells.map((cell, i) => (
        <CellView
          key={i}
          cell={cell}
          index={i}
          sessionFile={sessionFile}
          anchor={`cell-${i + 1}`}
          active={active === i}
          refCb={(el) => {
            cellRefs.current[i] = el;
          }}
        />
      ))}

      {doc.cells.length === 0 && (
        <p className="px-5 py-8 font-mono text-sm text-ink-3">
          No renderable turns in this session ({m.entryCount} entries,{" "}
          {m.skippedLines} unparseable lines).
        </p>
      )}
    </div>
  );
}
