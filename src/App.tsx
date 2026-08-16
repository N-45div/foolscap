import { useEffect, useMemo, useState } from "react";
import {
  parseSession,
  prettyProjectName,
  type ProjectRef,
  type SessionDoc,
  type SessionRef,
} from "./model";
import { Notebook } from "./Notebook";

/**
 * Adapter boundary: everything below talks to these two functions only.
 * In the Tauri build they become invoke() calls; the UI doesn't change.
 */
async function fetchProjects(): Promise<ProjectRef[]> {
  const r = await fetch("/api/projects");
  if (!r.ok) throw new Error(`projects: ${r.status}`);
  return r.json();
}

async function fetchSession(file: string): Promise<string> {
  const r = await fetch(`/api/session?file=${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(`session: ${r.status}`);
  return r.text();
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

export function App() {
  const [projects, setProjects] = useState<ProjectRef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRef | null>(null);
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [parsing, setParsing] = useState(false);

  useEffect(() => {
    fetchProjects()
      .then((p) => {
        setProjects(p);
        const first = p[0]?.sessions[0];
        if (first) setSelected(first);
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setParsing(true);
    fetchSession(selected.file)
      .then((raw) => {
        if (!stale) setDoc(parseSession(raw));
      })
      .catch((e) => {
        if (!stale) setLoadError(String(e));
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

        <nav className="min-h-0 flex-1 overflow-y-auto">
          {projects === null && !loadError && (
            <p className="instrument px-4 py-6">reading ~/.claude …</p>
          )}
          {loadError && (
            <p className="px-4 py-6 font-mono text-xs text-oxide">
              {loadError}
            </p>
          )}
          {projects?.length === 0 && (
            <p className="px-4 py-6 font-mono text-xs text-ink-3">
              No sessions found. Run Claude Code once, then reopen.
            </p>
          )}
          {projects?.map((p) => (
            <section key={p.dir}>
              <h2
                className="instrument truncate border-b border-rule bg-paper px-4 py-2"
                title={prettyProjectName(p.dir)}
              >
                {prettyProjectName(p.dir)}
              </h2>
              <ul>
                {p.sessions.map((s) => (
                  <li key={s.file}>
                    <button
                      type="button"
                      onClick={() => setSelected(s)}
                      className={`block w-full border-b border-rule px-4 py-2.5 text-left transition-colors hover:bg-brass-wash ${
                        selected?.file === s.file ? "bg-brass-wash" : ""
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
          ))}
        </nav>

        <footer className="border-t border-rule px-4 py-2">
          <span className="instrument">read-only · local</span>
        </footer>
      </aside>

      {/* ── The document ── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {parsing && <p className="instrument px-8 py-6">parsing…</p>}
        {!parsing && doc && (
          <Notebook doc={doc} exportName={selected?.id.slice(0, 8) ?? "session"} />
        )}
        {!parsing && !doc && !loadError && (
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
