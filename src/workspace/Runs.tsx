import { useEffect, useRef, useState } from "react";
import { CheckCircle, CurrencyDollar, Microphone, PaperPlaneTilt, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import { answerRun, cancelRun, fetchRuns, startRun, type CoordinatorRun, type CoordinatorStatus, type RunEvent } from "./model";

const ACTIVE = new Set(["planning", "working", "needs-you"]);
const WORDS: Record<CoordinatorRun["status"], string> = { planning: "Planning", working: "In progress", "needs-you": "Needs you", done: "Completed", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted" };
const money = (value: number | null | undefined) => typeof value === "number" ? `$${value.toFixed(2)}` : "Cost unknown";

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function EventRow({ event, onOpenAgents }: { event: RunEvent; onOpenAgents: () => void }) {
  switch (event.kind) {
    case "message": return <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{event.text}</p>;
    case "task": return <p className="font-mono text-[11px] text-ink-2">Task created · <span className="text-ink">{event.title}</span></p>;
    case "call": {
      const args = event.args ?? {};
      const detail = typeof args.query === "string" ? `“${args.query}”` : typeof args.title === "string" ? `“${args.title}”` : "";
      if (["dispatch_task", "create_task", "ask_user"].includes(event.name ?? "")) return null;
      return <p className="font-mono text-[11px] text-ink-3">{event.name?.replaceAll("_", " ")} {detail}</p>;
    }
    case "dispatch": return <p className="font-mono text-[11px] text-ink-2"><span className="text-ink">{event.title}</span> → {event.agent}<span className="text-ink-3"> · {event.reason}</span> <button type="button" onClick={onOpenAgents} className="text-brass-bright hover:underline">Open agents</button></p>;
    case "blocked": return <p className="flex items-start gap-2 font-mono text-[11px] text-oxide"><WarningCircle size={14} className="mt-px shrink-0" />{event.text}</p>;
    case "evidence": {
      const failed = (event.testsFailed ?? 0) > 0 || (event.errors ?? 0) > 0;
      const tests = failed ? `${event.testsFailed ?? 0} failed` : (event.testsPassed ?? 0) > 0 ? `${event.testsPassed} passed` : "No tests observed";
      return <p className={`flex items-start gap-2 font-mono text-[11px] ${failed ? "text-oxide" : "text-moss"}`}>{failed ? <XCircle size={14} className="mt-px shrink-0" /> : <CheckCircle size={14} className="mt-px shrink-0" />}<span><span className="text-ink">{event.title}</span> · {event.agent} · {tests} · {event.edited ?? 0} files</span></p>;
    }
    case "policy": return <p className={`font-mono text-[11px] ${event.phase === "failed" ? "text-oxide" : event.phase === "complete" ? "text-moss" : "text-brass-bright"}`}>{event.text}</p>;
    case "question": return <p className="font-mono text-[11px] text-brass-bright">Question · {event.text}</p>;
    case "answer": return <p className="font-mono text-[11px] text-ink-2">You · {event.text}</p>;
    case "retry": return <p className="font-mono text-[11px] text-ink-3">Retrying ({event.status})</p>;
    case "model-fallback": return <p className="font-mono text-[11px] text-brass-bright">Model fallback · {event.from} → {event.model}</p>;
    case "error": return <p className="font-mono text-[11px] text-oxide">{event.text}</p>;
    case "cancelled": return <p className="font-mono text-[11px] text-ink-3">Run stopped</p>;
    default: return null;
  }
}

function RunCard({ run, open, onToggle, onOpenAgents, onChanged }: { run: CoordinatorRun; open: boolean; onToggle: () => void; onOpenAgents: () => void; onChanged: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ACTIVE.has(run.status);
  const tone = run.status === "needs-you" ? "text-brass-bright" : run.status === "failed" ? "text-oxide" : run.status === "done" ? "text-moss" : "text-ink-3";
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return (
    <article className={`overflow-hidden rounded-lg border bg-paper-raised ${run.status === "needs-you" ? "border-brass" : "border-rule"}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-paper-sunk/40">
        <span className={`h-2 w-2 shrink-0 rounded-full ${run.status === "done" ? "bg-moss" : run.status === "failed" ? "bg-oxide" : active ? "animate-pulse bg-brass-bright" : "bg-ink-3"}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{run.goal}</span>
        <span className={`instrument shrink-0 text-[8px] ${tone}`}>{WORDS[run.status]}</span>
        <span className="tnum hidden shrink-0 font-mono text-[9px] text-ink-3 lg:inline">{money(run.costUsd)} · {run.turns} turns · {ago(run.updatedAt)}</span>
      </button>
      {open && <div className="space-y-2 border-t border-rule px-5 py-4">{run.events.map((event, index) => <EventRow key={`${run.id}-${index}`} event={event} onOpenAgents={onOpenAgents} />)}
        {run.status === "needs-you" && run.question && <form className="mt-3 flex gap-2 rounded-lg border border-brass bg-brass-wash p-3" onSubmit={(event) => { event.preventDefault(); if (!answer.trim()) return; void act(() => answerRun(run.id, answer.trim())).then(() => setAnswer("")); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Your answer…" autoFocus aria-label="Answer the coordinator" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-3" /><button type="submit" disabled={busy || !answer.trim()} className="rounded-md border border-brass px-3 py-1 text-xs text-brass-bright disabled:opacity-50">Answer</button></form>}
        {active && <div className="flex justify-end"><button type="button" disabled={busy} onClick={() => void act(() => cancelRun(run.id))} className="text-[10px] text-oxide hover:underline disabled:opacity-50">Stop run</button></div>}
        {error && <p className="font-mono text-[10px] text-oxide">{error}</p>}
      </div>}
    </article>
  );
}

export function Runs({ onOpenAgents, onOpenVoice, onChanged }: { onOpenAgents: () => void; onOpenVoice: () => void; onChanged: () => void }) {
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
    const next = await fetchRuns(); setData(next); setModel((current) => current || next.model);
    const latest = next.runs.map((run) => run.updatedAt).join(",");
    if (latest !== stamp.current) { stamp.current = latest; onChanged(); }
  };
  useEffect(() => { load().catch((reason) => setError(String(reason))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!active) return; const timer = window.setInterval(() => { load().catch(() => {}); }, 1200); return () => window.clearInterval(timer); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    const text = goal.trim(); if (!text || busy) return;
    setBusy(true); setError(null);
    try { const run = await startRun(text, Number(budget), model || data?.model); setGoal(""); setOpen(run.id); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const ready = data?.ready ?? false;
  return (
    <section>
      <div className="overflow-hidden rounded-xl border border-rule-strong bg-paper-raised shadow-[0_18px_50px_rgba(0,0,0,0.18)] transition focus-within:border-brass/70">
        <div className="flex items-start gap-3 px-5 pb-3 pt-4">
          <textarea value={goal} onChange={(event) => setGoal(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} placeholder={ready ? "Tell Foolscap what needs doing…" : data ? "Set OPENAI_API_KEY and restart Foolscap to coordinate work" : "Checking coordinator…"} disabled={!ready} rows={2} aria-label="What needs doing" className="min-h-14 min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-ink-3 disabled:opacity-60" />
          <button type="button" onClick={onOpenVoice} aria-label="Open voice command" title="Open voice command" className="mt-0.5 rounded-lg border border-rule p-2 text-ink-3 hover:border-brass/60 hover:bg-brass-wash hover:text-brass-bright"><Microphone size={18} /></button>
        </div>
        <form className="flex flex-wrap items-center gap-2 border-t border-rule bg-paper-sunk/40 px-4 py-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <select value={model || data?.model || ""} onChange={(event) => setModel(event.target.value)} disabled={!ready} aria-label="Coordinator model" className="rounded-md border border-rule bg-paper px-2.5 py-2 font-mono text-[10px] text-ink-2 outline-none disabled:opacity-60">{(data?.models ?? [data?.model ?? ""]).filter(Boolean).map((name) => <option key={name} value={name}>{name}</option>)}</select>
          <label className="flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1.5 font-mono text-[10px] text-ink-3"><CurrencyDollar size={13} /><input value={budget} onChange={(event) => setBudget(event.target.value)} type="number" min="0.25" max="50" step="0.25" aria-label="Coordinator observed budget" className="w-12 bg-transparent text-ink outline-none" /></label>
          <span className="hidden text-[10px] text-ink-3 xl:inline">Foolscap plans, delegates, and checks the result.</span>
          <button type="submit" disabled={!ready || busy || !goal.trim()} className="ml-auto flex items-center gap-2 rounded-md border border-brass bg-brass px-4 py-2 text-xs font-medium text-[#15100a] transition hover:bg-brass-bright disabled:cursor-not-allowed disabled:opacity-40">{busy ? <SpinnerGap size={15} className="animate-spin" /> : <PaperPlaneTilt size={15} weight="fill" />}{busy ? "Starting" : "Start run"}</button>
        </form>
        {error && <p className="border-t border-rule px-4 py-2 font-mono text-[10px] text-oxide">{error}</p>}
        {data && !ready && <p className="border-t border-rule px-4 py-2 font-mono text-[10px] text-ink-3">The coordinator needs your OpenAI key. Restart with <code>OPENAI_API_KEY=… npx foolscap</code>.</p>}
      </div>
      {!!data?.runs.length && <div className="mt-3 space-y-2">{data.runs.slice(0, 12).map((run) => <RunCard key={run.id} run={run} open={open === run.id} onToggle={() => setOpen(open === run.id ? null : run.id)} onOpenAgents={onOpenAgents} onChanged={() => { load().catch(() => {}); }} />)}</div>}
    </section>
  );
}
