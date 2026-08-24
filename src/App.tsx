import { useEffect, useMemo, useState } from "react";
import {
  prettyProjectName,
  type SessionDoc,
  type SessionRef,
} from "./model";
import { SOURCES, type SourceId } from "./sources";
import { Notebook } from "./Notebook";
import { Shelf } from "./Shelf";

type Group = { source: SourceId; dir: string; sessions: SessionRef[] };

type SearchHit = SessionRef & {
  source: SourceId;
  dir: string;
  count: number;
  snippet: string;
};

/**
 * Adapter boundary: everything below talks to these two functions only.
 * In the Tauri build they become invoke() calls; the UI doesn't change.
 */
async function fetchProjects(): Promise<Group[]> {
  const r = await fetch("/api/projects");
  if (!r.ok) throw new Error(`projects: ${r.status}`);
  return r.json();
}

async function fetchSession(file: string): Promise<string> {
  const r = await fetch(`/api/session?file=${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(await r.text().catch(() => `session: ${r.status}`));
  return r.text();
}

async function fetchSearch(q: string): Promise<SearchHit[]> {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`search: ${r.status}`);
  return r.json();
}

function fmtBytes(n: number): string {
  if (n > 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Selected = { ref: SessionRef; source: SourceId };

export function App() {
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    fetchProjects()
      .then((p) => {
        setProjects(p);
        const first = p[0];
        if (first?.sessions[0])
          setSelected({ ref: first.sessions[0], source: first.source });
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setParsing(true);
    setLoadError(null);
    fetchSession(selected.ref.file)
      .then((raw) => {
        if (!stale) setDoc(SOURCES[selected.source].parse(raw));
      })
      .catch((e) => {
        if (!stale) {
          setDoc(null);
          setLoadError(String(e));
        }
      })
      .finally(() => {
        if (!stale) setParsing(false);
      });
    return () => {
      stale = true;
    };
  }, [selected]);

  const sessionCount = useMemo(
    () => projects?.reduce((n, p) => n + p.sessions.length, 0) ?? 0,
    [projects],
  );

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<"archive" | "shelf">("archive");

  const runSearch = () => {
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      return;
    }
    setSearching(true);
    fetchSearch(q)
      .then(setHits)
      .catch((e) => setLoadError(String(e)))
      .finally(() => setSearching(false));
  };

  const clearSearch = () => {
    setQuery("");
    setHits(null);
  };

  return (
    <div className="flex h-dvh">
      {/* ── Sidebar: the archive ── */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-rule bg-paper-sunk">
        <header className="flex items-baseline gap-2 border-b border-rule px-4 py-3">
          <span className="font-mono text-sm font-bold tracking-tight">
            fools<span className="text-brass-bright">cap</span>
          </span>
          <span className="instrument tnum ml-auto">
            {sessionCount} sessions
          </span>
        </header>

        <search className="flex items-center gap-2 border-b border-rule px-4 py-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
              if (e.key === "Escape") clearSearch();
            }}
            placeholder="search the archive…"
            aria-label="Search all sessions"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-3"
          />
          {(hits !== null || query) && (
            <button
              type="button"
              onClick={clearSearch}
              className="instrument hover:text-ink"
              aria-label="Clear search"
            >
              esc
            </button>
          )}
        </search>

        <nav className="min-h-0 flex-1 overflow-y-auto">
          {searching && <p className="instrument px-4 py-6">searching…</p>}
          {!searching && hits !== null && (
            <>
              <p className="instrument tnum border-b border-rule bg-paper px-4 py-2">
                {hits.length === 0
                  ? "no matches"
                  : `${hits.length} session${hits.length === 1 ? "" : "s"} match`}
              </p>
              <ul>
                {hits.map((h) => (
                  <li key={h.file}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected({ ref: h, source: h.source });
                        setView("archive");
                      }}
                      className={`block w-full border-b border-rule px-4 py-2.5 text-left transition-colors hover:bg-brass-wash ${
                        selected?.ref.file === h.file ? "bg-brass-wash" : ""
                      }`}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="tnum font-mono text-xs text-ink-2">
                          {h.id.slice(0, 8)}
                        </span>
                        <span className="tnum ml-auto font-mono text-[10px] text-brass-bright">
                          {h.count}×
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block font-mono text-[11px] leading-relaxed text-ink-3">
                        …{h.snippet}…
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!searching && hits === null && projects === null && !loadError && (
            <p className="instrument px-4 py-6">reading the archive…</p>
          )}
          {loadError && hits === null && (
            <p className="px-4 py-6 font-mono text-xs text-oxide">
              {loadError}
            </p>
          )}
          {hits === null && projects?.length === 0 && (
            <p className="px-4 py-6 font-mono text-xs text-ink-3">
              No sessions found. Run Claude Code once, then reopen.
            </p>
          )}
          {hits === null && projects?.map((p) => {
            const label =
              p.source === "claude" ? prettyProjectName(p.dir) : p.dir;
            return (
              <section key={`${p.source}:${p.dir}`}>
                <h2
                  className="flex items-baseline gap-2 border-b border-rule bg-paper px-4 py-2"
                  title={label}
                >
                  <span className="instrument min-w-0 truncate">{label}</span>
                  <span className="ml-auto shrink-0 rounded-sm border border-rule-strong px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3">
                    {SOURCES[p.source]?.label ?? p.source}
                  </span>
                </h2>
                <ul>
                  {p.sessions.map((s) => (
                    <li key={s.file}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected({ ref: s, source: p.source });
                          setView("archive");
                        }}
                        className={`block w-full border-b border-rule px-4 py-2.5 text-left transition-colors hover:bg-brass-wash ${
                          selected?.ref.file === s.file ? "bg-brass-wash" : ""
                        }`}
                      >
                        <span className="tnum block font-mono text-xs text-ink-2">
                          {fmtWhen(s.modified)}
                        </span>
                        <span className="tnum block font-mono text-[11px] text-ink-3">
                          {fmtBytes(s.bytes)} · {s.id.slice(0, 8)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </nav>

        <footer className="flex items-baseline border-t border-rule px-4 py-2">
          <span className="instrument">read-only · local</span>
          <button
            type="button"
            onClick={() =>
              setView(view === "shelf" ? "archive" : "shelf")
            }
            aria-pressed={view === "shelf"}
            className={`instrument ml-auto transition-colors hover:text-brass-bright ${
              view === "shelf" ? "text-brass-bright" : ""
            }`}
          >
            ☆ prompt shelf
          </button>
        </footer>
      </aside>

      {/* ── The document ── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {view === "shelf" && (
          <Shelf
            onOpen={(ref, source) => {
              setSelected({ ref, source });
              setView("archive");
            }}
          />
        )}
        {view === "archive" && parsing && (
          <p className="instrument px-8 py-6">parsing…</p>
        )}
        {view === "archive" && !parsing && doc && (
          <Notebook
            doc={doc}
            exportName={selected?.ref.id.slice(0, 8) ?? "session"}
            sessionFile={selected?.ref.file}
          />
        )}
        {view === "archive" && !parsing && !doc && loadError && (
          <p className="px-8 py-6 font-mono text-sm text-oxide">{loadError}</p>
        )}
        {view === "archive" && !parsing && !doc && !loadError && (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-sm text-ink-3">
              Select a session to read it as a document.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
