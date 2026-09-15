import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Archive, CaretDown, CheckCircle, ClockCounterClockwise, Command, FileText,
  FolderSimple, HardDrives, MagnifyingGlass, Notebook as NotebookIcon, Robot,
  Scroll, Sparkle, SquaresFour, X,
} from "@phosphor-icons/react";
import { prettyProjectName, type SessionDoc, type SessionRef } from "./model";
import { SOURCES, type SourceId } from "./sources";
import { Notebook } from "./Notebook";
import { Shelf } from "./Shelf";
import { Fleet } from "./Fleet";
import { Workspace } from "./workspace/Workspace";
import type { WorkspaceState } from "./workspace/model";

type Group = { source: SourceId; dir: string; sessions: SessionRef[] };
type SearchHit = SessionRef & { source: SourceId; dir: string; count: number; snippet: string };
type Selected = { ref: SessionRef; source: SourceId };
type View = "work" | "archive" | "shelf" | "fleet";
type NavIcon = ComponentType<{ size?: number; weight?: "regular" | "fill" | "bold"; className?: string }>;

async function fetchProjects(): Promise<Group[]> {
  const response = await fetch("/api/projects");
  if (!response.ok) throw new Error(`projects: ${response.status}`);
  return response.json();
}

async function fetchSession(file: string): Promise<string> {
  const response = await fetch(`/api/session?file=${encodeURIComponent(file)}`);
  if (!response.ok) throw new Error(await response.text().catch(() => `session: ${response.status}`));
  return response.text();
}

async function fetchSearch(query: string): Promise<SearchHit[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`search: ${response.status}`);
  return response.json();
}

function fmtBytes(bytes: number): string {
  if (bytes > 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

const VIEWS: Array<{ id: View; label: string; tip: string; icon: NavIcon }> = [
  { id: "work", label: "Work", tip: "Coordinate work and inspect live evidence", icon: SquaresFour },
  { id: "archive", label: "History", tip: "Read every recorded agent session", icon: ClockCounterClockwise },
  { id: "shelf", label: "Prompts", tip: "Find prompts and outcomes", icon: Sparkle },
  { id: "fleet", label: "Agents", tip: "Open the local agent fleet", icon: Robot },
];

function Welcome({ onPick, onClose }: { onPick: (view: View) => void; onClose: () => void }) {
  const cards: Array<[View, string, string, NavIcon]> = [
    ["work", "Coordinate work", "Brief agents, watch execution, and inspect the evidence they return.", SquaresFour],
    ["archive", "Read history", "Open prior agent sessions as searchable, replayable documents.", Archive],
    ["shelf", "Reuse prompts", "Find what you asked before and what happened next.", Sparkle],
    ["fleet", "Manage agents", "See local agent availability and the work each one is handling.", Robot],
  ];
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-paper/95 p-6 backdrop-blur-md">
      <div className="w-full max-w-2xl rounded-xl border border-rule-strong bg-paper-raised p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <span className="grid h-10 w-10 place-items-center rounded-lg border border-brass/40 bg-brass-wash text-brass-bright"><Scroll size={22} /></span>
          <div className="min-w-0 flex-1"><h1 className="text-lg font-semibold tracking-tight">Your agent work, in one place.</h1><p className="mt-1 text-sm leading-relaxed text-ink-2">Foolscap runs locally, coordinates the agents you choose, and keeps the work connected to its source.</p></div>
          <button type="button" onClick={onClose} aria-label="Close welcome" className="rounded-md p-1.5 text-ink-3 hover:bg-paper-sunk hover:text-ink"><X size={18} /></button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {cards.map(([id, label, detail, Icon]) => <button key={id} type="button" onClick={() => onPick(id)} className="group rounded-lg border border-rule bg-paper-sunk/60 p-4 text-left transition hover:border-brass/60 hover:bg-brass-wash"><Icon size={18} className="text-brass-bright" /><span className="mt-4 block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-relaxed text-ink-3">{detail}</span></button>)}
        </div>
      </div>
    </div>
  );
}

function SourceList({ workspace }: { workspace: WorkspaceState | null }) {
  const sources = workspace?.sources ?? [];
  return (
    <section className="mt-5 min-h-0 px-3">
      <div className="flex items-center px-2"><p className="instrument text-[9px]">Sources</p><span className="tnum ml-auto font-mono text-[9px] text-ink-3">{sources.length}</span></div>
      <div className="mt-2 space-y-1">
        {sources.slice(0, 8).map((source) => (
          <div key={source.id} title={source.path} className="group flex items-center gap-2 rounded-md px-2 py-2 text-ink-2 hover:bg-paper-raised hover:text-ink">
            {source.kind === "document" || source.kind === "decision" ? <FileText size={16} className="shrink-0 text-ink-3" /> : <FolderSimple size={16} className="shrink-0 text-ink-3" />}
            <span className="min-w-0 flex-1 truncate text-xs">{source.label}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${source.status === "indexed" ? "bg-moss" : source.status === "syncing" ? "bg-brass-bright" : "bg-oxide"}`} />
          </div>
        ))}
        {!sources.length && <p className="px-2 py-3 text-[11px] leading-relaxed text-ink-3">Connect a repository or notes folder from Work.</p>}
      </div>
    </section>
  );
}

export function App() {
  const [projects, setProjects] = useState<Group[] | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [parsing, setParsing] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<View>("work");

  useEffect(() => {
    fetchProjects().then((next) => {
      setProjects(next);
      const first = next[0];
      if (first?.sessions[0]) setSelected({ ref: first.sessions[0], source: first.source });
    }).catch((reason) => setLoadError(String(reason)));
  }, []);

  useEffect(() => {
    if (!selected || view !== "archive") return;
    let stale = false;
    setParsing(true);
    setLoadError(null);
    fetchSession(selected.ref.file).then((raw) => {
      if (!stale) setDoc(SOURCES[selected.source].parse(raw));
    }).catch((reason) => {
      if (!stale) { setDoc(null); setLoadError(String(reason)); }
    }).finally(() => { if (!stale) setParsing(false); });
    return () => { stale = true; };
  }, [selected, view]);

  useEffect(() => {
    if (view !== "archive") return;
    fetchProjects().then(setProjects).catch(() => {});
  }, [view]);

  const sessionCount = useMemo(() => projects?.reduce((sum, project) => sum + project.sessions.length, 0) ?? 0, [projects]);
  const runSearch = () => {
    const term = query.trim();
    if (term.length < 2) { setHits(null); return; }
    setSearching(true);
    fetchSearch(term).then(setHits).catch((reason) => setLoadError(String(reason))).finally(() => setSearching(false));
  };
  const clearSearch = () => { setQuery(""); setHits(null); };

  return (
    <div className="flex h-dvh min-w-[860px] bg-paper text-ink">
      <aside className="flex w-[244px] shrink-0 flex-col border-r border-rule bg-paper-sunk">
        <header className="px-5 pb-4 pt-5">
          <button type="button" onClick={() => setView("work")} className="flex items-center gap-2 text-left" title="Open Work">
            <span className="grid h-7 w-7 place-items-center rounded-md border border-brass/40 bg-brass-wash text-brass-bright"><Scroll size={16} weight="bold" /></span>
            <span className="text-[15px] font-semibold tracking-[-0.02em]">fools<span className="text-brass-bright">cap</span></span>
          </button>
          <button type="button" onClick={() => setView("work")} className="mt-5 flex w-full items-center gap-3 rounded-lg border border-rule bg-paper-raised px-3 py-2.5 text-left shadow-sm hover:border-rule-strong">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-paper-sunk text-ink-2"><HardDrives size={16} /></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{workspace?.name || "Local workspace"}</span><span className="instrument mt-0.5 block text-[8px]">Local</span></span>
            <CaretDown size={13} className="text-ink-3" />
          </button>
        </header>

        <nav className="px-3" aria-label="Main navigation">
          {VIEWS.map(({ id, label, tip, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id} title={tip} className={`mb-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs transition ${view === id ? "bg-brass-wash text-brass-bright" : "text-ink-2 hover:bg-paper-raised hover:text-ink"}`}>
              <Icon size={17} weight={view === id ? "fill" : "regular"} /><span className="font-medium">{label}</span>{id === "archive" && <span className="tnum ml-auto font-mono text-[9px] text-ink-3">{sessionCount}</span>}
            </button>
          ))}
        </nav>

        {view === "archive" ? (
          <div className="mt-4 min-h-0 flex-1 border-t border-rule">
            <search className="flex items-center gap-2 px-4 py-3">
              <MagnifyingGlass size={15} className="text-ink-3" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") runSearch(); if (event.key === "Escape") clearSearch(); }} placeholder="Search history" aria-label="Search all sessions" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-3" />
              {query && <button type="button" onClick={clearSearch} aria-label="Clear search" className="text-ink-3 hover:text-ink"><X size={13} /></button>}
            </search>
            <nav className="h-[calc(100%-45px)] overflow-y-auto border-t border-rule">
              {searching && <p className="instrument px-4 py-5">Searching…</p>}
              {!searching && hits !== null && <ul>{hits.map((hit) => <li key={hit.file}><button type="button" onClick={() => setSelected({ ref: hit, source: hit.source })} className={`block w-full border-b border-rule px-4 py-3 text-left hover:bg-brass-wash ${selected?.ref.file === hit.file ? "bg-brass-wash" : ""}`}><span className="block truncate text-xs font-medium">{hit.title ?? hit.id.slice(0, 8)}</span><span className="mt-1 line-clamp-2 block font-mono text-[9px] leading-relaxed text-ink-3">{hit.snippet}</span></button></li>)}</ul>}
              {!searching && hits === null && projects?.map((project) => <section key={`${project.source}:${project.dir}`}><h2 className="flex items-center gap-2 border-b border-rule px-4 py-2"><span className="min-w-0 flex-1 truncate text-[10px] font-medium text-ink-3">{project.source === "claude" ? prettyProjectName(project.dir) : project.dir}</span><span className="font-mono text-[8px] uppercase text-ink-3">{SOURCES[project.source]?.label ?? project.source}</span></h2><ul>{project.sessions.map((session) => <li key={session.file}><button type="button" onClick={() => setSelected({ ref: session, source: project.source })} className={`block w-full border-b border-rule px-4 py-2.5 text-left hover:bg-paper-raised ${selected?.ref.file === session.file ? "bg-brass-wash" : ""}`}><span className="line-clamp-2 block text-[11px] leading-snug">{session.title ?? `session ${session.id.slice(0, 8)}`}</span><span className="tnum mt-1 block font-mono text-[9px] text-ink-3">{fmtWhen(session.modified)} · {fmtBytes(session.bytes)}</span></button></li>)}</ul></section>)}
              {!searching && hits === null && projects?.length === 0 && <p className="px-4 py-5 text-[11px] leading-relaxed text-ink-3">Agent sessions appear here after your first run.</p>}
            </nav>
          </div>
        ) : <div className="min-h-0 flex-1 overflow-y-auto"><SourceList workspace={workspace} /></div>}

        <footer className="border-t border-rule px-4 py-3">
          <div className="flex items-center gap-2 text-[10px] text-ink-3"><CheckCircle size={14} className="text-moss" /><span>Local · Your keys</span><button type="button" onClick={() => setHelp(true)} aria-label="About Foolscap" className="ml-auto rounded p-1 hover:bg-paper-raised hover:text-ink"><Command size={14} /></button></div>
        </footer>
      </aside>

      <main className="relative min-w-0 flex-1 overflow-y-auto">
        {help && <Welcome onPick={(next) => { setView(next); setHelp(false); }} onClose={() => setHelp(false)} />}
        {view === "work" && <Workspace onOpenAgents={() => setView("fleet")} onStateChange={setWorkspace} />}
        {view === "fleet" && <Fleet />}
        {view === "shelf" && <Shelf onOpen={(ref, source) => { setSelected({ ref, source }); setView("archive"); }} />}
        {view === "archive" && parsing && <p className="instrument px-8 py-6">Opening…</p>}
        {view === "archive" && !parsing && doc && <Notebook doc={doc} exportName={selected?.ref.id.slice(0, 8) ?? "session"} sessionFile={selected?.ref.file} />}
        {view === "archive" && !parsing && !doc && loadError && <p className="px-8 py-6 font-mono text-sm text-oxide">{loadError}</p>}
        {view === "archive" && !parsing && !doc && !loadError && <div className="flex h-full items-center justify-center"><div className="text-center"><NotebookIcon size={26} className="mx-auto text-ink-3" /><p className="mt-3 max-w-[36ch] text-sm leading-relaxed text-ink-3">Choose a session from History to read the complete agent record.</p></div></div>}
      </main>
    </div>
  );
}
