import { useEffect, useMemo, useState } from "react";
import { prettyProjectName, type SessionRef } from "./model";
import { SOURCES, type SourceId } from "./sources";

/**
 * The prompt shelf — your prompt library, derived from the archive.
 * Every prompt ever sent, across harnesses, deduplicated with reuse
 * counts. Stars persist in ~/.foolscap (never near session files).
 */

export type ShelfPrompt = {
  key: string;
  text: string;
  at?: string;
  count: number;
  source: SourceId;
  dir: string;
  session: SessionRef;
  starred: boolean;
};

/** A reused prompt is a workflow that hasn't been written down yet.
    Draft it as a skill the user can drop into ~/.claude/skills. */
function skillDraft(p: ShelfPrompt): string {
  const FILLER = new Set([
    "whatever", "anything", "everything", "something", "please", "make",
    "sure", "just", "also", "that", "this", "with", "from", "into",
    "then", "when", "what", "have", "been", "will", "your", "does",
  ]);
  const words = p.text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !FILLER.has(w))
    .slice(0, 4);
  const name = words.join("-") || "recurring-task";
  const firstLine = p.text.split(String.fromCharCode(10))[0].slice(0, 120);
  return `---
name: ${name}
description: ${firstLine}
---

# ${name}

You have asked for this ${p.count} times, most recently on ${p.at?.slice(0, 10) ?? "an earlier session"}.
Written as a skill so you can invoke it instead of retyping it.

## The request

${p.text}

## Notes

- Derived by foolscap from your ${SOURCES[p.source]?.label ?? p.source} history.
- Edit before use: add the steps, files and checks that made it work.
`;
}

function fmtDay(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}

export function Shelf({
  onOpen,
}: {
  onOpen: (session: SessionRef, source: SourceId) => void;
}) {
  const [prompts, setPrompts] = useState<ShelfPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShelfPrompt | null>(null);

  useEffect(() => {
    fetch("/api/prompts")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`prompts: ${r.status}`)),
      )
      .then(setPrompts)
      .catch((e) => setError(String(e)));
  }, []);

  const shown = useMemo(() => {
    if (!prompts) return null;
    const t = q.trim().toLowerCase();
    if (!t) return prompts;
    return prompts.filter((p) => p.text.toLowerCase().includes(t));
  }, [prompts, q]);

  const toggleStar = (p: ShelfPrompt) => {
    setPrompts(
      (cur) =>
        cur?.map((x) =>
          x.key === p.key ? { ...x, starred: !x.starred } : x,
        ) ?? null,
    );
    fetch(`/api/prompts/star?key=${encodeURIComponent(p.key)}`, {
      method: "POST",
    }).catch(() => {});
  };

  const copy = (p: ShelfPrompt) => {
    navigator.clipboard
      ?.writeText(p.text)
      .then(() => {
        setCopied(p.key);
        setTimeout(() => setCopied(null), 1200);
      })
      .catch(() => {});
  };

  const starredCount = prompts?.filter((p) => p.starred).length ?? 0;

  return (
    <div>
      <header className="sticky top-0 z-10 flex items-baseline gap-4 border-b border-rule bg-paper/90 px-5 py-2 backdrop-blur-sm">
        <span className="font-mono text-sm font-bold">prompt shelf</span>
        <span className="instrument tnum">
          {prompts ? `${prompts.length} distinct` : "reading…"}
          {starredCount > 0 && ` · ${starredCount} starred`}
        </span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter prompts…"
          aria-label="Filter prompts"
          className="ml-auto min-w-0 flex-1 max-w-72 bg-transparent text-right font-mono text-xs text-ink outline-none placeholder:text-ink-3"
        />
      </header>

      {error && (
        <p className="px-5 py-6 font-mono text-xs text-oxide">{error}</p>
      )}
      {!error && shown === null && (
        <p className="instrument px-5 py-6">deriving your prompt library…</p>
      )}
      {shown !== null && shown.length === 0 && (
        <p className="px-5 py-8 font-mono text-sm text-ink-3">
          {q ? "No prompts match." : "No prompts found in the archive yet."}
        </p>
      )}

      {draft && (
        <section className="border-b border-rule bg-paper-sunk px-5 py-4">
          <p className="instrument mb-2 flex items-baseline gap-3">
            <span className="text-brass-bright">skill draft</span>
            <span>
              asked {draft.count}× — save as ~/.claude/skills/&lt;name&gt;/SKILL.md
            </span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(skillDraft(draft)).catch(() => {});
                setCopied(`draft:${draft.key}`);
                setTimeout(() => setCopied(null), 1200);
              }}
              className="ml-auto hover:text-brass-bright"
            >
              {copied === `draft:${draft.key}` ? "copied ✓" : "copy skill"}
            </button>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="hover:text-brass-bright"
            >
              close
            </button>
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border border-rule bg-paper px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
            {skillDraft(draft)}
          </pre>
        </section>
      )}

      {shown?.map((p) => (
        <article key={p.key} className="group border-b border-rule">
          <div className="grid grid-cols-[2rem_1fr] gap-2 px-5 py-3">
            <button
              type="button"
              onClick={() => toggleStar(p)}
              aria-label={p.starred ? "Unstar prompt" : "Star prompt"}
              title={p.starred ? "unstar" : "star — starred prompts sort first"}
              className={`pt-0.5 text-left font-mono text-sm ${
                p.starred
                  ? "text-brass-bright"
                  : "text-ink-3 opacity-40 transition-opacity hover:opacity-100 group-hover:opacity-70"
              }`}
            >
              {p.starred ? "★" : "☆"}
            </button>

            <div className="min-w-0">
              <button
                type="button"
                onClick={() =>
                  setExpanded(expanded === p.key ? null : p.key)
                }
                className={`block w-full whitespace-pre-wrap text-left font-mono text-[13px] leading-relaxed ${
                  expanded === p.key ? "" : "line-clamp-3"
                }`}
              >
                {p.text}
              </button>

              <p className="instrument tnum mt-1.5 flex flex-wrap items-baseline gap-x-3">
                <span className="rounded-sm border border-rule-strong px-1.5 py-px text-[9px]">
                  {SOURCES[p.source]?.label ?? p.source}
                </span>
                {p.count > 1 && (
                  <span className="text-brass-bright">{p.count}× used</span>
                )}
                {p.count > 1 && (
                  <button
                    type="button"
                    onClick={() => setDraft(p)}
                    title="A prompt you keep retyping is a workflow — draft it as a skill"
                    className="text-brass-bright hover:underline"
                  >
                    write as skill
                  </button>
                )}
                <span>{fmtDay(p.at)}</span>
                <span className="hidden max-w-64 truncate sm:inline">
                  {p.source === "claude" ? prettyProjectName(p.dir) : p.dir}
                </span>
                <button
                  type="button"
                  onClick={() => copy(p)}
                  className="hover:text-brass-bright"
                >
                  {copied === p.key ? "copied ✓" : "copy"}
                </button>
                <button
                  type="button"
                  onClick={() => onOpen(p.session, p.source)}
                  className="hover:text-brass-bright"
                >
                  open session
                </button>
              </p>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
