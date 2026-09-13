import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  cancelWorkspaceTask,
  dispatchWorkspaceTasks,
  fetchWorkspaceAgents,
  fetchWorkspace,
  emptyWorkspace,
  indexWorkspaceSource,
  NODE_COLORS,
  persistWorkspace,
  runWorkspaceTask,
  searchWorkspaceKnowledge,
  spendLabel,
  STATUS_LABELS,
  type TaskStatus,
  type WorkspaceAgent,
  type WorkspaceSearchHit,
  type WorkspaceNode,
  type WorkspaceState,
  type WorkspaceTask,
} from "./model";
import { Voice } from "../voice/Voice";

/** The tabs inside Work. One footer entry outside, five plain words inside. */
export type WorkspaceMode = "overview" | "board" | "graph" | "usage" | "voice";
const MODES: Array<[WorkspaceMode, string, string]> = [
  ["overview", "overview", "Where things stand, and what needs a decision"],
  ["board", "board", "Tasks by state — drag to move, open to run"],
  ["graph", "graph", "Files and links in the folders you connected"],
  ["usage", "usage", "What each task cost and why it went to that agent"],
  ["voice", "voice", "Say what needs doing (needs OPENAI_API_KEY)"],
];
type Props = { onOpenAgents: () => void };
const STATUSES: TaskStatus[] = ["backlog", "ready", "running", "review", "blocked", "done"];
const money = (value: number) => `$${value.toFixed(2)}`;

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="border border-rule bg-paper-raised p-4"><p className="instrument text-[9px]">{label}</p><p className="tnum mt-2 font-mono text-2xl font-bold">{value}</p><p className="mt-1 font-mono text-[10px] text-ink-3">{hint}</p></div>;
}

function TaskCard({ task, state, onMove, onSelect }: { task: WorkspaceTask; state: WorkspaceState; onMove: (status: TaskStatus) => void; onSelect: () => void }) {
  const sources = task.sourceIds.map((id) => state.sources.find((source) => source.id === id)?.label).filter(Boolean).join(" · ");
  return (
    <article draggable onDragStart={(event) => event.dataTransfer.setData("text/task", task.id)} className="border border-rule bg-paper-raised p-3 shadow-sm transition-colors hover:border-brass-bright">
      <button type="button" onClick={onSelect} className="block w-full text-left">
        <div className="flex items-start gap-2"><span className={`mt-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-bold ${task.priority === "P0" ? "border-oxide text-oxide" : "border-rule-strong text-ink-3"}`}>{task.priority}</span><span className="font-mono text-xs font-semibold leading-snug text-ink">{task.title}</span></div>
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-2">{task.detail}</p>
      </button>
      <div className="mt-3 flex items-center gap-2 border-t border-rule pt-2 font-mono text-[10px] text-ink-3"><span className="truncate">{task.agent}</span><span className="tnum ml-auto shrink-0" title={spendLabel(task).note ?? undefined}>{spendLabel(task).text}{spendLabel(task).note ? " ?" : ""}</span></div>
      <div className="mt-2 h-1 overflow-hidden bg-paper-sunk" aria-label={`${task.progress}% complete`}><div className="h-full bg-brass-bright" style={{ width: `${task.progress}%` }} /></div>
      <div className="mt-2 flex items-center gap-2">
        <span className="line-clamp-1 flex-1 font-mono text-[9px] text-ink-3" title={sources}>{sources || "no context attached"}</span>
        <select aria-label={`Move ${task.title}`} value={task.status} onChange={(event) => onMove(event.target.value as TaskStatus)} className="max-w-[92px] bg-transparent font-mono text-[9px] uppercase text-ink-3 outline-none">{STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select>
      </div>
    </article>
  );
}

function TaskInspector({ task, state, agents, busy, onClose, onRun, onCancel, onOpenAgents }: { task: WorkspaceTask | null; state: WorkspaceState; agents: WorkspaceAgent[]; busy: boolean; onClose: () => void; onRun: (agent: string) => void; onCancel: () => void; onOpenAgents: () => void }) {
  const [agent, setAgent] = useState("auto");
  useEffect(() => {
    if (task?.agent && agents.some((item) => item.id === task.agent)) setAgent(task.agent);
    else if (agent !== "auto" && agents.length && !agents.some((item) => item.id === agent)) setAgent("auto");
  }, [agent, agents, task?.agent, task?.id]);
  if (!task) return null;
  const nodes = task.nodeIds.map((id) => state.nodes.find((node) => node.id === id)).filter(Boolean) as WorkspaceNode[];
  const attempt = task.attempts?.at(-1);
  const active = !!attempt && ["starting", "idle", "working", "blocked"].includes(attempt.status);
  const ev = attempt?.evidence;
  return (
    <aside className="fixed bottom-4 right-4 z-20 max-h-[calc(100vh-2rem)] w-[min(390px,calc(100vw-2rem))] overflow-y-auto border border-rule-strong bg-paper-raised p-4 shadow-xl">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><p className="instrument text-[9px]">task inspector</p><h2 className="mt-1 font-mono text-sm font-bold">{task.title}</h2></div><button type="button" onClick={onClose} className="font-mono text-xs text-ink-3 hover:text-ink" aria-label="Close task inspector">×</button></div>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">{task.detail}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-rule pt-3">
        <div><dt className="instrument text-[9px]">execution</dt><dd className="mt-1 font-mono text-xs">{attempt?.agentLabel ?? task.agent}</dd></div><div><dt className="instrument text-[9px]">model</dt><dd className="mt-1 truncate font-mono text-xs" title={attempt?.model ?? task.model}>{attempt?.model ?? task.model}</dd></div><div><dt className="instrument text-[9px]">budget</dt><dd className="tnum mt-1 font-mono text-xs">{spendLabel(task).text}{spendLabel(task).note && <span className="mt-0.5 block text-[9px] font-normal text-ink-3">{spendLabel(task).note}</span>}</dd></div><div><dt className="instrument text-[9px]">state</dt><dd className="mt-1 font-mono text-xs">{STATUS_LABELS[task.status]}</dd></div>
      </dl>
      {attempt && <div className="mt-4 border-t border-rule pt-3"><div className="flex items-center"><p className="instrument text-[9px]">latest attempt</p><button type="button" onClick={onOpenAgents} className="ml-auto font-mono text-[9px] text-brass-bright hover:underline">open agent queue</button></div><div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]"><span>{attempt.status}</span><span className="tnum text-center">{attempt.outputTokens.toLocaleString()} tokens</span><span className="tnum text-right">{ev?.edited ?? 0} files</span></div>{ev && <p className={`mt-2 font-mono text-[10px] ${ev.testsFailed || ev.errors ? "text-oxide" : ev.testsPassed ? "text-moss" : "text-ink-3"}`}>{ev.testsFailed ? `${ev.testsFailed} failing test runs` : ev.testsPassed ? `${ev.testsPassed} passing test runs` : "waiting for validation evidence"}{ev.errors ? ` · ${ev.errors} errors` : ""}</p>}{attempt.error && <p className="mt-2 font-mono text-[10px] text-oxide">{attempt.error}</p>}</div>}
      <div className="mt-4 border-t border-rule pt-3"><p className="instrument text-[9px]">connected context</p><div className="mt-2 flex flex-wrap gap-1.5">{nodes.length ? nodes.map((node) => <span key={node.id} className="rounded-sm border border-rule-strong px-2 py-1 font-mono text-[10px] text-ink-2">{node.label}</span>) : <span className="font-mono text-[10px] text-ink-3">The coordinator will use connected sources and the workspace root.</span>}</div></div>
      <div className="mt-4 flex gap-2 border-t border-rule pt-3">{active ? <button type="button" disabled={busy} onClick={onCancel} className="border border-oxide px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-oxide disabled:opacity-50">cancel run</button> : <><select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Agent for task" className="min-w-0 flex-1 border border-rule-strong bg-paper px-2 py-2 font-mono text-[10px]"><option value="auto">auto · claude code first</option>{(agents.length ? agents : [{ id: "claude", label: "claude code", driver: "claude" }]).map((item) => <option key={item.id} value={item.id}>{item.label} · {item.driver}</option>)}</select><button type="button" disabled={busy || task.spentUsd >= task.budgetUsd} onClick={() => onRun(agent)} className="border border-brass-bright bg-brass-wash px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-brass-bright disabled:opacity-50">{busy ? "starting…" : "run task"}</button></>}</div>
    </aside>
  );
}

function Board({ state, agents, busyTaskId, onChange, selectedId, setSelectedId, onRun, onCancel, onOpenAgents }: { state: WorkspaceState; agents: WorkspaceAgent[]; busyTaskId: string | null; onChange: (state: WorkspaceState) => void; selectedId: string | null; setSelectedId: (id: string | null) => void; onRun: (id: string, agent: string) => void; onCancel: (id: string) => void; onOpenAgents: () => void }) {
  const move = (id: string, status: TaskStatus) => onChange({ ...state, tasks: state.tasks.map((task) => task.id === id ? { ...task, status, updatedAt: new Date().toISOString() } : task) });
  const drop = (event: DragEvent<HTMLElement>, status: TaskStatus) => { event.preventDefault(); const id = event.dataTransfer.getData("text/task"); if (id) move(id, status); };
  return (
    <div className="min-w-0 flex-1 overflow-x-auto p-5">
      <div className="flex min-w-[1120px] gap-3">{STATUSES.map((status) => { const tasks = state.tasks.filter((task) => task.status === status); return (
        <section key={status} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, status)} className="flex min-h-[430px] w-[180px] flex-1 flex-col bg-paper-sunk/50">
          <header className="flex items-center gap-2 border-b border-rule px-3 py-2"><span className={`instrument text-[9px] ${status === "blocked" ? "text-oxide" : ""}`}>{STATUS_LABELS[status]}</span><span className="tnum ml-auto font-mono text-[10px] text-ink-3">{tasks.length}</span></header>
          <div className="flex flex-1 flex-col gap-2 p-2">{tasks.map((task) => <TaskCard key={task.id} task={task} state={state} onMove={(next) => move(task.id, next)} onSelect={() => setSelectedId(task.id)} />)}{!tasks.length && <p className="border border-dashed border-rule-strong p-3 text-center font-mono text-[10px] text-ink-3">drop work here</p>}</div>
        </section>
      ); })}</div>
      {selectedId && <TaskInspector task={state.tasks.find((task) => task.id === selectedId) ?? null} state={state} agents={agents} busy={busyTaskId === selectedId} onRun={(agent) => onRun(selectedId, agent)} onCancel={() => onCancel(selectedId)} onOpenAgents={onOpenAgents} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function Graph({ state }: { state: WorkspaceState }) {
  const [selectedId, setSelectedId] = useState("workspace");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<WorkspaceSearchHit[]>([]);
  useEffect(() => {
    if (query.trim().length < 2) { setSearchHits([]); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      searchWorkspaceKnowledge(query).then((hits) => { if (!stale) setSearchHits(hits); }).catch(() => {});
    }, 180);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [query]);
  const selected = state.nodes.find((node) => node.id === selectedId) ?? state.nodes[0];
  const links = state.edges.filter((edge) => edge.from === selected?.id || edge.to === selected?.id);
  const visibleNodes = useMemo(() => {
    if (query.trim()) {
      const q = query.toLowerCase();
      const ids = new Set(searchHits.map((hit) => hit.id));
      return state.nodes.filter((node) => ids.has(node.id) || `${node.label} ${node.detail}`.toLowerCase().includes(q)).slice(0, 60);
    }
    if (state.nodes.length <= 48) return state.nodes;
    const ids = new Set(["workspace", selected?.id, ...links.flatMap((edge) => [edge.from, edge.to])]);
    const focused = state.nodes.filter((node) => ids.has(node.id));
    const remaining = state.nodes.filter((node) => !ids.has(node.id)).slice(0, Math.max(0, 48 - focused.length));
    return focused.concat(remaining).slice(0, 60);
  }, [links, query, searchHits, selected?.id, state.nodes]);
  const displayNodes = useMemo(() => visibleNodes.map((node, index) => {
    if (index === 0) return { ...node, x: 420, y: 250 };
    const slot = index - 1;
    const ring = Math.floor(slot / 24);
    const ringStart = ring * 24;
    const ringCount = Math.min(24, visibleNodes.length - 1 - ringStart);
    const angle = (slot - ringStart) / Math.max(1, ringCount) * Math.PI * 2 - Math.PI / 2;
    const radius = 145 + ring * 82;
    return { ...node, x: 420 + Math.cos(angle) * radius, y: 250 + Math.sin(angle) * radius };
  }), [visibleNodes]);
  const visibleIds = new Set(displayNodes.map((node) => node.id));
  const visibleEdges = state.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
  return (
    <div className="grid min-h-[620px] min-w-0 flex-1 grid-cols-[minmax(0,1fr)_280px]">
      <div className="relative overflow-hidden border-r border-rule bg-[#0b1014] p-4">
        <div className="absolute left-5 top-4 z-10"><p className="instrument text-[9px] text-[#80909a]">relationship map</p><p className="mt-1 font-mono text-[10px] text-[#56646e]">showing {visibleNodes.length} / {state.nodes.length} nodes · {state.edges.length} relationships</p><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="filter files and entities…" className="mt-3 w-56 border-b border-[#34414a] bg-transparent py-1 font-mono text-[10px] text-[#edf0ee] outline-none placeholder:text-[#61707a] focus:border-[#d6a05c]" /></div>
        {!visibleNodes.length ? <div className="flex min-h-[560px] items-center justify-center font-mono text-xs text-[#71808a]">No entities match this filter.</div> : (
          <svg viewBox="0 0 840 500" role="img" aria-label="Knowledge graph of workspace entities" className="h-full min-h-[560px] w-full">
            {visibleEdges.map((edge) => { const from = displayNodes.find((node) => node.id === edge.from); const to = displayNodes.find((node) => node.id === edge.to); if (!from || !to) return null; const active = edge.from === selectedId || edge.to === selectedId; return <g key={`${edge.from}-${edge.to}-${edge.label}`} opacity={active ? 1 : 0.24}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={active ? "#d6a05c" : "#4d5961"} strokeWidth={active ? 2 : 1} />{active && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6} fill="#82909a" fontSize="9" textAnchor="middle">{edge.label}</text>}</g>; })}
            {displayNodes.map((node) => { const active = node.id === selectedId; return <g key={node.id} onClick={() => setSelectedId(node.id)} className="cursor-pointer"><circle cx={node.x} cy={node.y} r={active ? 24 : 17} fill={active ? "#202a31" : "#131a20"} stroke={NODE_COLORS[node.kind]} strokeWidth={active ? 3 : 1.5} /><text x={node.x} y={node.y + 34} fill="#a7b1b7" fontSize="9" textAnchor="middle">{node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}</text></g>; })}
          </svg>
        )}
      </div>
      <aside className="min-w-0 overflow-y-auto bg-paper-sunk p-4"><p className="instrument text-[9px]">selected entity</p><h2 className="mt-1 break-words font-mono text-base font-bold">{selected?.label ?? "No selection"}</h2><p className="mt-1 break-all text-xs text-ink-2">{selected?.detail}</p>
        {query.trim().length >= 2 && <div className="mt-5 border-t border-rule pt-3"><p className="instrument text-[9px]">source matches · {searchHits.length}</p><div className="mt-2 space-y-2">{searchHits.filter((hit) => hit.type === "content").slice(0, 12).map((hit, index) => <button type="button" key={`${hit.id}-${index}`} onClick={() => setSelectedId(hit.id)} className="block w-full border border-rule bg-paper-raised p-2 text-left hover:border-brass-bright"><span className="block truncate font-mono text-[10px] text-ink">{hit.label}</span><span className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-ink-3">{hit.detail}</span></button>)}</div></div>}
        <div className="mt-5 border-t border-rule pt-3"><p className="instrument text-[9px]">backlinks · {links.length}</p><div className="mt-2 space-y-2">{links.slice(0, 30).map((edge) => { const otherId = edge.from === selected?.id ? edge.to : edge.from; const other = state.nodes.find((node) => node.id === otherId); return <button type="button" key={`${edge.from}-${edge.to}-${edge.label}`} onClick={() => { setSelectedId(otherId); setQuery(""); }} className="block w-full border border-rule bg-paper-raised p-2 text-left hover:border-brass-bright"><span className="block truncate font-mono text-xs text-ink">{other?.label}</span><span className="mt-1 block font-mono text-[10px] text-ink-3">{edge.label}</span></button>; })}</div></div>
        <div className="mt-5 border-t border-rule pt-3"><p className="instrument text-[9px]">source provenance</p><div className="mt-2 space-y-2">{selected?.sourceIds.map((id) => { const source = state.sources.find((item) => item.id === id); return source ? <div key={source.id} className="border border-rule bg-paper-raised p-2"><span className="block font-mono text-xs text-ink">{source.label}</span><span className="mt-1 block truncate font-mono text-[10px] text-ink-3">{source.path}</span></div> : null; })}</div></div>
      </aside>
    </div>
  );
}

function Usage({ state }: { state: WorkspaceState }) {
  const totals = state.tasks.reduce((sum, task) => ({ spent: sum.spent + task.spentUsd, budget: sum.budget + task.budgetUsd }), { spent: 0, budget: 0 });
  const attempts = state.tasks.flatMap((task) => task.attempts ?? []);
  const reported = attempts.filter((attempt) => typeof attempt.costUsd === "number").length;
  const files = state.sources.reduce((sum, source) => sum + (source.stats?.files ?? 0), 0);
  const tokens = state.tasks.reduce((sum, task) => sum + (task.attempts ?? []).reduce((taskSum, attempt) => taskSum + attempt.outputTokens, 0), 0);
  const decisions = state.decisions ?? [];
  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="reported spend" value={`${reported < attempts.length && totals.spent > 0 ? "≥ " : ""}${money(totals.spent)}`} hint={attempts.length ? `reported by ${reported} of ${attempts.length} attempts · ${money(totals.budget)} budgeted` : `${money(totals.budget)} budgeted`} /><Metric label="output usage" value={tokens.toLocaleString()} hint="tokens reported by agents" /><Metric label="active work" value={String(state.tasks.filter((task) => task.status === "running").length)} hint={`max ${state.routing?.maxConcurrent ?? 3} concurrent`} /><Metric label="voice sessions" value={String(state.voiceSessions?.length ?? 0)} hint="gracefully finalized calls" /><Metric label="indexed context" value={String(files)} hint={`${state.sources.length} connected sources`} /></div>
      <section className="mt-6 border border-rule bg-paper-raised">
        <header className="flex items-center justify-between border-b border-rule px-4 py-3"><div><p className="instrument text-[9px]">usage by task</p><h2 className="mt-1 font-mono text-sm font-bold">Budget and execution evidence</h2></div><span className="font-mono text-[10px] text-moss">local ledger</span></header>
        <div className="divide-y divide-rule">{state.tasks.map((task) => { const taskTokens = (task.attempts ?? []).reduce((sum, attempt) => sum + attempt.outputTokens, 0); return <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_90px_90px_120px] items-center gap-3 px-4 py-3"><span className="truncate font-mono text-xs">{task.title}</span><span className="truncate font-mono text-[10px] text-ink-3">{task.agent}</span><span className="tnum text-right font-mono text-[10px] text-ink-3">{taskTokens.toLocaleString()} tok</span><span className="tnum text-right font-mono text-xs" title={spendLabel(task).note ?? undefined}>{spendLabel(task).text}</span></div>; })}{!state.tasks.length && <p className="px-4 py-8 text-center font-mono text-xs text-ink-3">Task usage will appear after work is captured.</p>}</div>
      </section>
      <section className="mt-6 border border-rule bg-paper-raised">
        <header className="flex items-center justify-between border-b border-rule px-4 py-3"><div><p className="instrument text-[9px]">coordination ledger</p><h2 className="mt-1 font-mono text-sm font-bold">Why work went to each agent</h2></div><span className="font-mono text-[10px] text-ink-3">{state.routing?.mode ?? "balanced"} policy</span></header>
        <div className="divide-y divide-rule">{decisions.slice(0, 30).map((decision) => { const task = state.tasks.find((item) => item.id === decision.taskId); return <div key={decision.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_110px_2fr]"><span className="truncate font-mono text-xs">{task?.title ?? decision.taskId}</span><span className="font-mono text-[10px] text-brass-bright">→ {decision.agent}</span><span className="font-mono text-[10px] text-ink-3">{decision.reason}</span></div>; })}{!decisions.length && <p className="px-4 py-8 text-center font-mono text-xs text-ink-3">Routing decisions appear after a task is run or ready work is dispatched.</p>}</div>
      </section>
    </div>
  );
}

function Overview({ state, loaded, onInspect, onReindex }: { state: WorkspaceState; loaded: boolean; onInspect: (id: string) => void; onReindex: (path: string) => void }) {
  const attention = state.tasks.filter((task) => ["running", "review", "blocked", "ready"].includes(task.status));
  // Three honest steps, ticked from real state — no invented milestone.
  const steps: Array<[boolean, string, string]> = [
    [state.sources.length > 0, "connect a folder", "a repository or notes folder foolscap can search when it briefs an agent"],
    [state.tasks.length > 0, "capture a task", "one line is enough — the brief is written from it"],
    [state.tasks.some((task) => (task.attempts ?? []).length > 0), "run it", "an agent works on your machine; foolscap reads the tests and diffs"],
  ];
  const done = steps.filter(([ok]) => ok).length;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-6"><div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <section className="border border-rule bg-paper-raised p-5"><div className="flex items-start justify-between gap-3"><div><p className="instrument text-[9px]">getting started</p><h2 className="mt-1 font-mono text-base font-bold">{done === steps.length ? "Everything is connected" : "Three steps"}</h2></div><span className="tnum font-mono text-[10px] text-ink-3">{done} / {steps.length}</span></div>
        <ol className="mt-4 space-y-3">{steps.map(([ok, label, hint]) => <li key={label} className="flex gap-3"><span className={`mt-0.5 h-4 w-4 shrink-0 border text-center font-mono text-[10px] leading-4 ${ok ? "border-moss bg-moss-wash text-moss" : "border-rule-strong text-ink-3"}`}>{ok ? "✓" : ""}</span><div><span className={`font-mono text-xs ${ok ? "text-ink-3 line-through" : "text-ink"}`}>{label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-ink-3">{hint}</span></div></li>)}</ol>
        {!loaded && <p className="mt-4 font-mono text-[10px] text-ink-3">reading your workspace…</p>}
      </section>
      <section className="border border-rule bg-[#0b1014] p-5 text-[#edf0ee]"><div className="flex items-center justify-between"><div><p className="instrument text-[9px] text-[#80909a]">connected folders</p><h2 className="mt-1 font-mono text-base font-bold">What the brief can draw on</h2></div><span className="font-mono text-[10px] text-[#6fbf97]">local index</span></div><div className="mt-5 space-y-2">{state.sources.map((source) => <div key={source.id} className="border border-[#2a353d] p-3"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs">{source.label}</span><button type="button" onClick={() => onReindex(source.path)} className="font-mono text-[9px] text-[#d6a05c] hover:underline">reindex</button></div><span className="mt-1 block truncate font-mono text-[10px] text-[#7e8c95]">{source.path}</span><span className="mt-2 block font-mono text-[9px] text-[#98a6ad]">{source.stats?.files ?? 0} files · {source.stats?.relationships ?? 0} relationships{source.stats?.truncated ? " · capped" : ""}</span></div>)}{!state.sources.length && <p className="border border-dashed border-[#34414a] p-4 font-mono text-[10px] leading-relaxed text-[#7e8c95]">Nothing connected yet. Use “connect source” above and pick a repository or notes folder.</p>}</div></section>
    </div><section className="mt-4 border border-rule bg-paper-raised"><header className="flex items-center justify-between border-b border-rule px-4 py-3"><div><p className="instrument text-[9px]">needs a decision</p><h2 className="mt-1 font-mono text-sm font-bold">Work in flight</h2></div><span className="font-mono text-[10px] text-ink-3">{attention.length} active</span></header><div className="grid gap-px bg-rule sm:grid-cols-2 lg:grid-cols-4">{attention.map((task) => <button type="button" key={task.id} onClick={() => onInspect(task.id)} className="bg-paper-raised p-4 text-left hover:bg-brass-wash"><span className="instrument text-[9px]">{STATUS_LABELS[task.status]}</span><span className="mt-2 block font-mono text-xs font-semibold">{task.title}</span><span className="mt-2 block font-mono text-[10px] text-ink-3">{task.agent} · {spendLabel(task).text}</span></button>)}{!attention.length && <p className="col-span-full bg-paper-raised p-6 text-center font-mono text-xs text-ink-3">Capture a task to start.</p>}</div></section></div>
  );
}

export function Workspace({ onOpenAgents }: Props) {
  const [mode, setMode] = useState<WorkspaceMode>("overview");
  const [state, setState] = useState<WorkspaceState>(() => emptyWorkspace());
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const receive = (next: WorkspaceState) => { setState(next); setLoaded(true); };
  const hasActiveAttempt = state.tasks.some((task) => {
    const status = task.attempts?.at(-1)?.status;
    return !!status && ["starting", "idle", "working", "blocked"].includes(status);
  });

  useEffect(() => { let stale = false; fetchWorkspace().then((next) => { if (!stale) receive(next); }).catch((reason) => { if (!stale) setError(String(reason)); }); return () => { stale = true; }; }, []);
  useEffect(() => { let stale = false; fetchWorkspaceAgents().then((next) => { if (!stale) setAgents(next); }).catch(() => {}); return () => { stale = true; }; }, []);
  useEffect(() => {
    if (!hasActiveAttempt) return;
    const timer = window.setInterval(() => {
      fetchWorkspace().then(receive).catch((reason) => setError(String(reason)));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [hasActiveAttempt]);
  const commit = (next: WorkspaceState) => { receive(next); persistWorkspace(next).then(receive).catch((reason) => setError(String(reason))); };
  const connect = async (path = sourcePath) => { if (!path.trim() || syncing) return; setSyncing(true); setError(null); try { receive(await indexWorkspaceSource(path.trim())); setSourceOpen(false); } catch (reason) { setError(String(reason)); } finally { setSyncing(false); } };
  const execute = async (id: string, agent: string) => { if (busyTaskId) return; setBusyTaskId(id); setError(null); try { receive(await runWorkspaceTask(id, agent)); } catch (reason) { setError(String(reason)); } finally { setBusyTaskId(null); } };
  const cancel = async (id: string) => { if (busyTaskId) return; setBusyTaskId(id); setError(null); try { receive(await cancelWorkspaceTask(id)); } catch (reason) { setError(String(reason)); } finally { setBusyTaskId(null); } };
  const dispatch = async () => { if (dispatching) return; setDispatching(true); setError(null); try { receive(await dispatchWorkspaceTasks()); } catch (reason) { setError(String(reason)); } finally { setDispatching(false); } };
  const addTask = () => {
    const title = draft.trim(); if (!title) return;
    const id = `task-${crypto.randomUUID()}`;
    const task: WorkspaceTask = { id, title, detail: "New task captured in the workspace.", status: "backlog", priority: "P1", agent: "unassigned", model: "—", sourceIds: [], nodeIds: [], spentUsd: 0, budgetUsd: 3, progress: 0, attempts: [], updatedAt: new Date().toISOString() };
    const node: WorkspaceNode = { id, label: title, kind: "task", detail: task.detail, x: 420, y: 400, sourceIds: [] };
    commit({ ...state, tasks: [task, ...state.tasks], nodes: [...state.nodes, node], edges: [...state.edges, { from: "workspace", to: id, label: "tracks" }] }); setDraft("");
  };
  const running = state.tasks.filter((task) => task.status === "running").length;
  const ready = state.tasks.filter((task) => task.status === "ready").length;
  return (
    <div className="flex min-h-full min-w-0 flex-col bg-paper">
      <header className="border-b border-rule bg-paper-raised px-5 py-4">
        <div className="flex flex-wrap items-start gap-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${error ? "bg-oxide" : "bg-moss"}`} /><span className="instrument text-[9px]">workspace / local</span><span className="truncate font-mono text-[10px] text-ink-3">· {loaded ? state.root : "connecting…"}</span></div><h1 className="mt-2 font-mono text-xl font-bold tracking-tight">{state.name || "Work"}<span className="ml-2 text-brass-bright">/ work</span></h1><p className="mt-1 max-w-[70ch] text-xs text-ink-2">{state.description}</p></div><div className="flex flex-wrap items-center justify-end gap-2"><button type="button" disabled={!ready || dispatching} onClick={() => void dispatch()} title="Route ready tasks by budget and current fleet load" className="border border-moss px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-moss disabled:opacity-40">{dispatching ? "dispatching…" : `dispatch ready · ${ready}`}</button><button type="button" onClick={onOpenAgents} className="border border-rule-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] hover:border-brass-bright">open agents</button><button type="button" onClick={() => { setSourcePath(state.root); setSourceOpen((value) => !value); }} className="border border-brass-bright bg-brass-wash px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-brass-bright">connect source</button></div></div>
        {sourceOpen && <div className="mt-4 flex flex-wrap items-center gap-2 border border-rule bg-paper-sunk p-3"><span className="instrument text-[9px]">local folder</span><input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connect(); }} placeholder="absolute path to a repository or notes folder" autoFocus className="min-w-[280px] flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-ink-3" /><button type="button" disabled={syncing} onClick={() => void connect()} className="border border-brass-bright px-3 py-1.5 font-mono text-[10px] text-brass-bright disabled:opacity-50">{syncing ? "indexing…" : "index"}</button></div>}
        {error && <p className="mt-3 font-mono text-[10px] text-oxide">{error}</p>}
        <nav className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-3" aria-label="Work">{MODES.map(([id, label, tip]) => <button key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id} title={tip} className={`instrument transition-colors hover:text-brass-bright ${mode === id ? "text-brass-bright" : ""}`}>{label}</button>)}</nav>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] text-ink-3"><span><b className="text-ink">{state.sources.length}</b> sources indexed</span><span><b className="text-ink">{state.nodes.length}</b> entities mapped</span><span><b className="text-ink">{running}</b> active task{running === 1 ? "" : "s"}</span><span className={error ? "text-oxide" : "text-moss"}>{error ? "sync issue" : "sync healthy"}</span><div className="ml-auto flex items-center gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addTask(); }} placeholder="capture a task…" aria-label="Capture a task" className="w-44 border-b border-rule-strong bg-transparent px-1 py-1 font-mono text-[10px] outline-none placeholder:text-ink-3 focus:border-brass-bright" /><button type="button" onClick={addTask} className="text-brass-bright hover:underline">+ add</button></div></div>
      </header>
      {mode === "overview" && <Overview state={state} loaded={loaded} onInspect={setSelectedId} onReindex={(path) => void connect(path)} />}
      {mode === "board" && <Board state={state} agents={agents} busyTaskId={busyTaskId} onChange={commit} selectedId={selectedId} setSelectedId={setSelectedId} onRun={(id, agent) => void execute(id, agent)} onCancel={(id) => void cancel(id)} onOpenAgents={onOpenAgents} />}
      {mode === "graph" && <Graph state={state} />}
      {mode === "usage" && <Usage state={state} />}
      {mode === "voice" && <Voice />}
      {selectedId && mode === "overview" && <TaskInspector task={state.tasks.find((task) => task.id === selectedId) ?? null} state={state} agents={agents} busy={busyTaskId === selectedId} onRun={(agent) => void execute(selectedId, agent)} onCancel={() => void cancel(selectedId)} onOpenAgents={onOpenAgents} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
