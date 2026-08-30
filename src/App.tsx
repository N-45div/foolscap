import { useEffect, useMemo, useState } from "react";
import {
  prettyProjectName,
  type SessionDoc,
  type SessionRef,
} from "./model";
import { SOURCES, type SourceId } from "./sources";
import { Notebook } from "./Notebook";
import { Shelf } from "./Shelf";
import { Fleet } from "./Fleet";

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
type View = "archive" | "shelf" | "fleet";

/** Plain-language names for the three views; the tooltip says what each is for. */
const VIEWS: Array<[View, string, string]> = [
  ["archive", "History", "Every session your coding agents have run, readable as documents"],
  ["shelf", "☆ Prompts", "Every prompt you've ever sent, with which ones actually worked"],
  ["fleet", "⚡ Agents", "Run several agents at once and see which one needs you"],
];

const WELCOMED_KEY = "foolscap.welcomed";

/**
 * First-run welcome. Non-technical people shouldn't have to guess what
 * "archive", "shelf" and "fleet" mean; this says it in three cards.
 */
function Welcome({ onPick, onClose }: { onPick: (v: View) => void; onClose: () => void }) {
  const cards: Array<[View, string, string, string]> = [
    ["archive", "History", "Everything your agents have done, as documents you can read, search and share.", "Show my history"],
    ["shelf", "Prompts", "Every prompt you've ever sent — and which ones actually worked, from what happened next.", "See my prompts"],
    ["fleet", "Agents", "Run several agents at once. foolscap tells you which one needs you.", "Run agents"],
  ];
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/95 p-8 backdrop-blur-sm">
      <div className="max-w-2xl">
        <p className="font-mono text-lg font-bold">
          Welcome to fools<span className="text-brass-bright">cap</span>.
        </p>
        <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-2">
          It reads what your coding agents already write to this machine — nothing is
          uploaded anywhere — and turns it into three things:
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {cards.map(([id, name, blurb, cta]) => (
            <button
              key={id}
              type="button"
              onClick={() => onPick(id)}
              className="flex flex-col border border-rule bg-paper-sunk p-4 text-left transition-colors hover:border-brass-bright"
            >
              <span className="font-mono text-sm font-bold">{name}</span>
              <span className="mt-1.5 flex-1 text-xs leading-relaxed text-ink-2">{blurb}</span>
              <span className="instrument mt-3 text-brass-bright">{cta} →</span>
            </button>
          ))}
        </div>
        <p className="instrument mt-5">
          tips · press <span className="text-brass-bright">n</span> in Agents for whoever needs you next ·{" "}
          <span className="text-brass-bright">j</span>/<span className="text-brass-bright">k</span> walk a document ·
          the ? at the top brings this back
        </p>
        <button
          type="button"
          onClick={onClose}
          className="instrument mt-4 border border-rule-strong px-3 py-1 hover:border-brass-bright hover:text-brass-bright"
        >
          got it
        </button>
      </div>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [parsing, setParsing] = useState(false);
  const [help, setHelp] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WELCOMED_KEY) !== "1";
    } catch {
      return false;
    }
  });
  const dismissHelp = () => {
    setHelp(false);
    try {
      localStorage.setItem(WELCOMED_KEY, "1");
    } catch {
      /* private mode: fine, it shows again next time */
    }
  };

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
  const [view, setView] = useState<View>("archive");

  // Coming back to the archive picks up sessions the fleet recorded
  // since the page loaded — a finished agent is in the archive at once.
  useEffect(() => {
    if (view !== "archive") return;
    fetchProjects()
      .then(setProjects)
      .catch(() => {});
  }, [view]);

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
          <span
            className="font-mono text-sm font-bold tracking-tight"
            title="Local-first: nothing leaves this machine"
          >
            fools<span className="text-brass-bright">cap</span>
          </span>
          <span className="instrument tnum ml-auto">
            {sessionCount} session{sessionCount === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => setHelp(true)}
            aria-label="What is foolscap?"
            title="What is foolscap?"
            className="instrument border border-rule-strong px-1.5 leading-tight hover:border-brass-bright hover:text-brass-bright"
          >
            ?
          </button>
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
            placeholder="search everything… then Enter"
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
              clear
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
                        <span className="line-clamp-1 font-mono text-xs text-ink" title={h.id}>
                          {h.title ?? h.id.slice(0, 8)}
                        </span>
                        <span className="tnum ml-auto shrink-0 font-mono text-[10px] text-brass-bright">
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
            <p className="instrument px-4 py-6">reading your sessions…</p>
          )}
          {loadError && hits === null && (
            <p className="px-4 py-6 font-mono text-xs text-oxide">
              {loadError}
            </p>
          )}
          {hits === null && projects?.length === 0 && (
            <p className="px-4 py-6 font-mono text-xs leading-relaxed text-ink-3">
              Nothing here yet. Use Claude Code, Codex, OpenCode or dsh once —
              your sessions show up here on their own. Or open{" "}
              <button
                type="button"
                onClick={() => setView("fleet")}
                className="text-brass-bright hover:underline"
              >
                Agents
              </button>{" "}
              and start one from here.
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
                        <span
                          className="line-clamp-2 block font-mono text-xs leading-snug text-ink"
                          title={s.id}
                        >
                          {s.title ?? `session ${s.id.slice(0, 8)}`}
                        </span>
                        <span className="tnum mt-0.5 block font-mono text-[11px] text-ink-3">
                          {fmtWhen(s.modified)} · {fmtBytes(s.bytes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </nav>

        <footer className="border-t border-rule px-4 py-2">
          <nav className="flex justify-between gap-2" aria-label="View">
            {VIEWS.map(([id, label, tip]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-pressed={view === id}
                title={tip}
                className={`instrument transition-colors hover:text-brass-bright ${
                  view === id ? "text-brass-bright" : ""
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </footer>
      </aside>

      {/* ── The document ── */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        {help && (
          <Welcome
            onPick={(v) => {
              setView(v);
              dismissHelp();
            }}
            onClose={dismissHelp}
          />
        )}
        {view === "fleet" && <Fleet />}
        {view === "shelf" && (
          <Shelf
            onOpen={(ref, source) => {
              setSelected({ ref, source });
              setView("archive");
            }}
          />
        )}
        {view === "archive" && parsing && (
          <p className="instrument px-8 py-6">opening…</p>
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
            <p className="max-w-[44ch] text-center font-mono text-sm leading-relaxed text-ink-3">
              Pick a session on the left to read what happened, top to bottom.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
