/** The new-task line: which repo, which agent, what to do, and what comes after. */
import { useEffect, useState } from "react";
import { api, type AppState } from "./api";
import { Mic } from "./icons";

const PICK = "__pick__";

export function Composer({ state }: { state: AppState }) {
  const { settings, agents } = state;
  const locked = state.licence.plan === "expired";
  const ready = agents.filter((a) => a.available);
  const [repo, setRepo] = useState(settings.repos[0]?.path ?? "");
  const [agent, setAgent] = useState(settings.defaultAgent);
  const [prompt, setPrompt] = useState("");
  const [thens, setThens] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo && settings.repos[0]) setRepo(settings.repos[0].path);
  }, [settings.repos, repo]);
  useEffect(() => {
    if (ready.length && !ready.some((a) => a.id === agent)) setAgent(ready[0].id);
  }, [ready, agent]);

  const pickRepo = async () => {
    const result = await api().pickRepo();
    if ("ok" in result && result.picked) setRepo(result.picked);
  };

  const start = async () => {
    if (!prompt.trim() || busy) return;
    if (!repo) return pickRepo();
    setBusy(true);
    const result = await api().start({ agent, cwd: repo, prompt, queue: thens.map((t) => t.trim()).filter(Boolean) });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    setError(null);
    setPrompt("");
    setThens([]);
    api().setSettings({ defaultAgent: agent });
  };

  const coding = ready.filter((a) => !a.assistant);
  const assistants = ready.filter((a) => a.assistant);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <div className="pickers">
        <label className="sr-only" htmlFor="repo">Repo folder</label>
        <select id="repo" value={repo || PICK} onChange={(e) => (e.target.value === PICK ? pickRepo() : setRepo(e.target.value))}>
          {!repo && <option value={PICK}>Pick a folder…</option>}
          {settings.repos.map((r) => (
            <option key={r.path} value={r.path} title={r.path}>{r.name}</option>
          ))}
          {repo && <option value={PICK}>Add folder…</option>}
        </select>
        <label className="sr-only" htmlFor="agent">Agent</label>
        <select id="agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {!ready.length && <option value="">No agents found</option>}
          {coding.length > 0 && (
            <optgroup label="Coding agents">
              {coding.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </optgroup>
          )}
          {assistants.length > 0 && (
            <optgroup label="Assistants">
              {assistants.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </optgroup>
          )}
        </select>
      </div>
      <div className="prompt-row">
        <label className="sr-only" htmlFor="prompt">What should the agent do?</label>
        <textarea
          id="prompt"
          rows={1}
          value={prompt}
          placeholder="What should the agent do?"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              start();
            }
          }}
        />
        <button type="button" className="square" disabled title="Voice comes with foolscap Cloud, soon" aria-label="Voice (coming with foolscap Cloud)">
          <Mic />
        </button>
      </div>
      {thens.length > 0 && (
        <div className="then">
          {thens.map((t, i) => (
            <input
              key={i}
              value={t}
              aria-label={`Then, step ${i + 1}`}
              placeholder="Then, once the tests pass…"
              onChange={(e) => setThens(thens.map((x, j) => (j === i ? e.target.value : x)))}
            />
          ))}
        </div>
      )}
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn quiet" onClick={() => setThens([...thens, ""])}>+ Then…</button>
        <button type="submit" className="btn primary" disabled={!prompt.trim() || busy || !ready.length || locked}>
          {locked ? "Trial ended" : busy ? "Starting…" : "Start"}
        </button>
      </div>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
