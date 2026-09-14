import { useEffect, useRef, useState } from "react";
import {
  answerRun,
  cancelRun,
  fetchRuns,
  startRun,
  type CoordinatorRun,
  type CoordinatorStatus,
  type RunEvent,
} from "./model";

const ACTIVE = new Set(["planning", "working", "needs-you"]);

/** Plain words for a run's state. */
const WORDS: Record<CoordinatorRun["status"], string> = {
  planning: "planning",
  working: "working",
  "needs-you": "needs you",
  done: "finished",
  failed: "hit a problem",
  cancelled: "stopped",
  interrupted: "interrupted",
};

const money = (value: number | null | undefined) => (typeof value === "number" ? `$${value.toFixed(2)}` : "cost unknown");

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** One line per event, in the run's own words where it has them. */
function EventRow({ e, onOpenAgents }: { e: RunEvent; onOpenAgents: () => void }) {
  switch (e.kind) {
    case "message":
      return <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink">{e.text}</p>;
    case "task":
      return <p className="font-mono text-[11px] text-ink-2">+ task <span className="text-ink">{e.title}</span></p>;
    case "call": {
      const a = (e.args ?? {}) as Record<string, unknown>;
      const what = typeof a.query === "string" ? `“${a.query}”` : typeof a.question === "string" ? "" : typeof a.title === "string" ? `“${a.title}”` : "";
      if (e.name === "dispatch_task" || e.name === "create_task" || e.name === "ask_user") return null; // shown by their own events
      return <p className="font-mono text-[11px] text-ink-3">→ {e.name?.replaceAll("_", " ")} {what}</p>;
    }
    case "dispatch":
      return (
        <p className="font-mono text-[11px] text-ink-2">
          ▶ <span className="text-ink">{e.title}</span> → {e.agent}
          <span className="text-ink-3"> · {e.reason}</span>{" "}
          <button type="button" onClick={onOpenAgents} className="text-brass-bright hover:underline">open agents ↗</button>
        </p>
      );
    case "blocked":
      return <p className="font-mono text-[11px] text-oxide">⚠ {e.text}</p>;
    case "evidence": {
      const red = (e.testsFailed ?? 0) > 0 || (e.errors ?? 0) > 0;
      const bits = [
        (e.testsFailed ?? 0) > 0 ? `${e.testsFailed} failing test run${e.testsFailed === 1 ? "" : "s"}` : (e.testsPassed ?? 0) > 0 ? `tests passed (${e.testsPassed})` : "no test run seen",
        (e.errors ?? 0) > 0 ? `${e.errors} error${e.errors === 1 ? "" : "s"}` : null,
        `${e.edited ?? 0} file${e.edited === 1 ? "" : "s"} edited`,
      ].filter(Boolean);
      return (
        <p className={`font-mono text-[11px] ${red ? "text-oxide" : "text-moss"}`}>
          {red ? "✗" : "✓"} <span className="text-ink">{e.title}</span> · {e.agent} · {bits.join(" · ")}
        </p>
      );
    }
    case "policy":
      return <p className={`font-mono text-[11px] ${e.phase === "failed" ? "text-oxide" : e.phase === "complete" ? "text-moss" : "text-brass-bright"}`}>policy · {e.text}</p>;
    case "question":
      return <p className="font-mono text-[11px] text-brass-bright">? {e.text}</p>;
    case "answer":
      return <p className="font-mono text-[11px] text-ink-2">you: {e.text}</p>;
    case "retry":
      return <p className="font-mono text-[11px] text-ink-3">retrying ({e.status})</p>;
    case "model-fallback":
      return <p className="font-mono text-[11px] text-brass-bright">model fallback · {e.from} → {e.model}</p>;
    case "error":
      return <p className="font-mono text-[11px] text-oxide">{e.text}</p>;
    case "done":
      return null; // the summary is the last message, already shown
    case "cancelled":
      return <p className="font-mono text-[11px] text-ink-3">stopped</p>;
    default:
      return null;
  }
}

function RunCard({ run, open, onToggle, onOpenAgents, onChanged }: { run: CoordinatorRun; open: boolean; onToggle: () => void; onOpenAgents: () => void; onChanged: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ACTIVE.has(run.status);
  const tone = run.status === "needs-you" ? "text-brass-bright" : run.status === "failed" ? "text-oxide" : run.status === "done" ? "text-moss" : "text-ink-3";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`border bg-paper-raised ${run.status === "needs-you" ? "border-brass-bright" : "border-rule"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-baseline gap-3 px-4 py-3 text-left">
        <span className={`instrument shrink-0 ${tone}`}>{active && run.status !== "needs-you" ? "◌ " : ""}{WORDS[run.status] ?? run.status}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{run.goal}</span>
        <span className="tnum shrink-0 font-mono text-[10px] text-ink-3">{money(run.costUsd)} · {run.turns} turn{run.turns === 1 ? "" : "s"} · {ago(run.updatedAt)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-rule px-4 py-3">
          {run.events.map((e, i) => <EventRow key={`${run.id}-${i}`} e={e} onOpenAgents={onOpenAgents} />)}
          {run.status === "needs-you" && run.question && (
            <form
              className="mt-2 flex gap-2 border border-brass-bright bg-brass-wash p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!answer.trim()) return;
                void act(() => answerRun(run.id, answer.trim())).then(() => setAnswer(""));
              }}
            >
              <input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="your answer…" autoFocus aria-label="Answer the coordinator" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-ink-3" />
              <button type="submit" disabled={busy || !answer.trim()} className="border border-brass-bright px-3 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-brass-bright disabled:opacity-50">answer</button>
            </form>
          )}
          {active && <div className="flex justify-end"><button type="button" disabled={busy} onClick={() => void act(() => cancelRun(run.id))} className="font-mono text-[10px] uppercase tracking-[0.1em] text-oxide hover:underline disabled:opacity-50">stop this run</button></div>}
          {error && <p className="font-mono text-[10px] text-oxide">{error}</p>}
        </div>
      )}
    </article>
  );
}

/**
 * The composer and the feed. "Tell it what needs doing" is the front
 * door of Work; everything below it is what the coordinator did, in
 * present tense while it runs.
 */
export function Runs({ onOpenAgents, onChanged }: { onOpenAgents: () => void; onChanged: () => void }) {
  const [data, setData] = useState<CoordinatorStatus | null>(null);
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState("");
  const [budget, setBudget] = useState("2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const stamp = useRef("");
  const active = data?.runs.some((run) => ACTIVE.has(run.status)) ?? false;

  const load = async () => {
    const next = await fetchRuns();
    setData(next);
    setModel((current) => current || next.model);
    const latest = next.runs.map((run) => run.updatedAt).join(",");
    if (latest !== stamp.current) {
      stamp.current = latest;
      onChanged();
    }
  };
  useEffect(() => { load().catch((reason) => setError(String(reason))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { load().catch(() => {}); }, 1200);
    return () => window.clearInterval(timer);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await startRun(text, Number(budget), model || data?.model);
      setGoal("");
      setOpen(run.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const ready = data?.ready ?? true;
  return (
    <section className="border border-rule bg-paper-raised">
      <div className="p-5">
        <div className="flex items-baseline justify-between gap-3"><p className="instrument text-[9px]">tell it what needs doing</p><span className="font-mono text-[10px] text-ink-3">{data?.model ?? "gpt-6-astra"} plans · your agents work · foolscap checks</span></div>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_88px_auto]"
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
        >
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={ready ? "make the replay tests pass, then have a second agent review the change" : "set OPENAI_API_KEY and restart foolscap to use the coordinator"}
            disabled={!ready}
            aria-label="What needs doing"
            className="min-w-0 flex-1 border-b border-rule-strong bg-transparent px-1 py-2 font-mono text-sm outline-none placeholder:text-ink-3 focus:border-brass-bright disabled:opacity-60"
          />
          <select value={model || data?.model || ""} onChange={(event) => setModel(event.target.value)} disabled={!ready} aria-label="Coordinator model" className="border border-rule-strong bg-paper px-2 py-2 font-mono text-[10px] disabled:opacity-60">
            {(data?.models ?? [data?.model ?? "gpt-6-astra"]).filter(Boolean).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <label className="flex items-center gap-1 border border-rule-strong px-2 font-mono text-[10px] text-ink-3">$<input value={budget} onChange={(event) => setBudget(event.target.value)} type="number" min="0.25" max="50" step="0.25" aria-label="Coordinator observed budget" className="w-full bg-transparent text-ink outline-none" /></label>
          <button type="submit" disabled={!ready || busy || !goal.trim()} className="border border-brass-bright bg-brass-wash px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-brass-bright disabled:opacity-40">{busy ? "starting…" : "run"}</button>
        </form>
        {ready && data?.budget && <p className="mt-2 font-mono text-[9px] text-ink-3">Observed coordinator budget; checked after each response; output capped at {data.budget.maxOutputTokens.toLocaleString()} tokens per turn. Agent costs may be unknown.</p>}
        {error && <p className="mt-2 font-mono text-[10px] text-oxide">{error}</p>}
        {!ready && <p className="mt-2 font-mono text-[10px] text-ink-3">Nothing runs without the key: the coordinator talks to OpenAI, your agents stay here. <code>OPENAI_API_KEY=… npx foolscap</code></p>}
      </div>
      {!!data?.runs.length && (
        <div className="space-y-2 border-t border-rule p-3">
          {data.runs.slice(0, 12).map((run) => (
            <RunCard key={run.id} run={run} open={open === run.id} onToggle={() => setOpen(open === run.id ? null : run.id)} onOpenAgents={onOpenAgents} onChanged={() => { load().catch(() => {}); }} />
          ))}
        </div>
      )}
    </section>
  );
}
