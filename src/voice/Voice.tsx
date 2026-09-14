import { useEffect, useRef, useState } from "react";
import type { WorkspaceState } from "../workspace/model";

type ConnectionState = "idle" | "connecting" | "live" | "closing";
type TranscriptRow = { key: string; role: "you" | "foolscap"; text: string };
type ToolCall = { call_id: string; name: string; arguments: string };
type ActionRow = { id: string; name: string; state: "working" | "done" | "failed"; detail: string };

const WORKSPACE_HEADERS = { "content-type": "application/json", "x-foolscap": "workspace" };
const COORDINATOR_HEADERS = { "content-type": "application/json", "x-foolscap": "coordinator" };

type FleetRow = { id: string; name: string; agentLabel: string; status: string; attention: { tier: number; reason: string }; pendingPermission?: { title?: string } | null };
type RunRow = { id: string; goal: string; status: string; summary: string | null; question: { text: string } | null; updatedAt: string };

async function value(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error ?? `request failed: ${response.status}`);
  return result;
}

async function workspaceTool(name: string, args: Record<string, unknown>, dispatchAuthorized: boolean) {
  if (name === "workspace_create_task") {
    let state = await value(await fetch("/api/workspace/tasks", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
      body: JSON.stringify({
        title: args.title,
        detail: args.detail,
        priority: args.priority,
        budgetUsd: args.budget_usd,
      }),
    })) as WorkspaceState;
    const task = state.tasks[0];
    if (args.ready) {
      state = await value(await fetch(`/api/workspace/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: WORKSPACE_HEADERS,
        body: JSON.stringify({ status: "ready" }),
      })) as WorkspaceState;
    }
    const saved = state.tasks.find((item) => item.id === task.id);
    return { status: "created", task: { id: saved?.id, title: saved?.title, state: saved?.status, budget_usd: saved?.budgetUsd } };
  }
  if (name === "workspace_list_tasks") {
    const state = await value(await fetch("/api/workspace")) as WorkspaceState;
    const status = typeof args.status === "string" ? args.status : null;
    return {
      status: "ok",
      tasks: state.tasks.filter((task) => !status || task.status === status).slice(0, 30).map((task) => {
        const attempt = task.attempts?.at(-1);
        return {
          id: task.id,
          title: task.title,
          state: task.status,
          priority: task.priority,
          agent: task.agent,
          spent_usd: task.spentUsd,
          budget_usd: task.budgetUsd,
          evidence: attempt?.evidence,
        };
      }),
    };
  }
  if (name === "workspace_search") {
    const query = String(args.query ?? "");
    const results = await value(await fetch(`/api/workspace/search?q=${encodeURIComponent(query)}`));
    return { status: "ok", query, results };
  }
  if (name === "workspace_update_task") {
    const id = String(args.task_id ?? "");
    const state = await value(await fetch(`/api/workspace/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: WORKSPACE_HEADERS,
      body: JSON.stringify({ status: args.status }),
    })) as WorkspaceState;
    const task = state.tasks.find((item) => item.id === id);
    return { status: "updated", task: task ? { id: task.id, title: task.title, state: task.status } : null };
  }
  if (name === "workspace_dispatch_ready") {
    if (!dispatchAuthorized) {
      return { status: "confirmation_required", message: "Ask the user to explicitly say run, start, execute, begin, or dispatch before starting coding agents." };
    }
    const state = await value(await fetch("/api/workspace/coordinator/dispatch", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
      body: JSON.stringify({ limit: args.limit }),
    })) as WorkspaceState & { dispatch?: { launched: number; errors: Array<{ taskId: string; error: string }> } };
    return { status: "dispatched", launched: state.dispatch?.launched ?? 0, errors: state.dispatch?.errors ?? [] };
  }
  if (name === "coordinator_run") {
    if (!dispatchAuthorized) {
      return { status: "confirmation_required", message: "Ask the user to explicitly say run, start, execute, begin, go, or dispatch before starting the coordinator." };
    }
    const run = await value(await fetch("/api/coordinator/runs", {
      method: "POST",
      headers: COORDINATOR_HEADERS,
      body: JSON.stringify({ goal: args.goal, budgetUsd: args.budget_usd }),
    })) as RunRow;
    return { status: "started", run_id: run.id, state: run.status, note: "The coordinator is planning under Work. Questions it raises show up in what_needs_me." };
  }
  if (name === "what_needs_me") {
    const [agents, runs] = await Promise.all([
      value(await fetch("/api/fleet")) as Promise<FleetRow[]>,
      value(await fetch("/api/coordinator/runs")) as Promise<{ runs: RunRow[] }>,
    ]);
    const items: Array<Record<string, unknown>> = [];
    for (const run of runs.runs) {
      if (run.status === "needs-you" && run.question) items.push({ kind: "question", from: "the coordinator", about: run.goal, question: run.question.text });
    }
    for (const row of agents) {
      if (row.attention.tier === 0) items.push({ kind: "needs you", agent: row.name, who: row.agentLabel, why: row.attention.reason, permission: row.pendingPermission?.title ?? null });
    }
    for (const row of agents) {
      if (row.attention.tier === 1) items.push({ kind: "review", agent: row.name, who: row.agentLabel, why: row.attention.reason });
    }
    const recent = Date.now() - 30 * 60 * 1000;
    for (const run of runs.runs) {
      if (run.status === "done" && run.summary && new Date(run.updatedAt).getTime() > recent) items.push({ kind: "finished", about: run.goal, report: run.summary.slice(0, 400) });
    }
    return { count: items.length, items, spoken: items.length ? `${items.length} thing${items.length === 1 ? "" : "s"} for you.` : "Nothing needs you right now." };
  }
  throw new Error(`unknown workspace tool: ${name}`);
}

function label(name: string) {
  return name.replace(/^workspace_/, "").replaceAll("_", " ");
}

export function Voice() {
  const [status, setStatus] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [backendModel, setBackendModel] = useState("gpt-5.6-luna");
  const [liveStatus, setLiveStatus] = useState<{ ready: boolean; liveModel: string; backendModel: string; backendModels: string[] } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const transcriptRef = useRef<Map<string, TranscriptRow>>(new Map());
  const callsRef = useRef<Map<string, ToolCall[]>>(new Map());
  const runningDelegationsRef = useRef<Set<string>>(new Set());
  const startedAtRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const backendModelRef = useRef("gpt-5.6-luna");
  const finalizedRef = useRef(false);

  useEffect(() => {
    fetch("/api/live/status").then(value)
      .then((next) => {
        const info = next as { ready: boolean; liveModel: string; backendModel: string; backendModels: string[] };
        setLiveStatus(info);
        setBackendModel(info.backendModel);
        backendModelRef.current = info.backendModel;
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const teardown = (next: ConnectionState = "idle") => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    channelRef.current?.close();
    peerRef.current?.close();
    if (audioRef.current) audioRef.current.srcObject = null;
    closeTimerRef.current = null;
    microphoneRef.current = null;
    channelRef.current = null;
    peerRef.current = null;
    setStatus(next);
  };

  const recordTranscript = (event: Record<string, unknown>, role: TranscriptRow["role"]) => {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (!delta) return;
    const key = String(event.item_id ?? event.transcript_id ?? `${role}-current`);
    const current = transcriptRef.current.get(key) ?? { key, role, text: "" };
    transcriptRef.current.set(key, { ...current, text: current.text + delta });
    setTranscript([...transcriptRef.current.values()]);
  };

  const updateAction = (row: ActionRow) => {
    setActions((current) => [row, ...current.filter((item) => item.id !== row.id)].slice(0, 40));
  };

  const executeCalls = async (delegationId: string, calls: ToolCall[], channel: RTCDataChannel) => {
    if (runningDelegationsRef.current.has(delegationId)) return;
    runningDelegationsRef.current.add(delegationId);
    const heard = [...transcriptRef.current.values()].filter((row) => row.role === "you").slice(-4).map((row) => row.text).join(" ");
    const dispatchAuthorized = /\b(run|start|execute|begin|dispatch)\b/i.test(heard);
    for (const call of calls) {
      updateAction({ id: call.call_id, name: label(call.name), state: "working", detail: "running local workspace tool" });
      let result: unknown;
      try {
        const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        result = await workspaceTool(call.name, args, dispatchAuthorized);
        updateAction({ id: call.call_id, name: label(call.name), state: "done", detail: JSON.stringify(result) });
      } catch (reason) {
        result = { status: "error", error: reason instanceof Error ? reason.message : String(reason) };
        updateAction({ id: call.call_id, name: label(call.name), state: "failed", detail: JSON.stringify(result) });
      }
      if (channel.readyState !== "open") return;
      channel.send(JSON.stringify({
        type: "response.item.create",
        event_id: `tool-result-${crypto.randomUUID()}`,
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) },
      }));
    }
    if (channel.readyState === "open") {
      channel.send(JSON.stringify({ type: "response.create", event_id: `continue-${crypto.randomUUID()}` }));
    }
    callsRef.current.delete(delegationId);
    runningDelegationsRef.current.delete(delegationId);
  };

  const rememberUsage = async (id: string, finalUsage: Record<string, unknown>) => {
    await fetch("/api/workspace/voice/sessions", {
      method: "POST",
      headers: WORKSPACE_HEADERS,
      body: JSON.stringify({
        id,
        backendModel: backendModelRef.current,
        startedAt: startedAtRef.current,
        endedAt: new Date().toISOString(),
        usage: finalUsage,
      }),
    }).catch(() => {});
  };

  const handleEvent = (raw: string, channel: RTCDataChannel) => {
    let event: Record<string, any>;
    try { event = JSON.parse(raw); } catch { return; }
    if (event.type === "session.started") {
      const id = String(event.session?.id ?? "");
      sessionIdRef.current = id;
      setSessionId(id);
      setStatus("live");
      setError(null);
      return;
    }
    if (event.type === "session.input_transcript.delta") recordTranscript(event, "you");
    if (event.type === "session.output_transcript.delta") recordTranscript(event, "foolscap");
    if (event.type === "error") setError(event.error?.message ?? "GPT-Live reported an error");
    if (event.type === "response.event") {
      const nested = event.event ?? {};
      const delegationId = String(event.delegation_id ?? "");
      if (nested.type === "response.output_item.done" && nested.item?.type === "function_call" && delegationId) {
        const calls = callsRef.current.get(delegationId) ?? [];
        if (!calls.some((call) => call.call_id === nested.item.call_id)) {
          calls.push({ call_id: nested.item.call_id, name: nested.item.name, arguments: nested.item.arguments });
          callsRef.current.set(delegationId, calls);
        }
      }
      if (nested.type === "response.completed" && delegationId) {
        const calls = callsRef.current.get(delegationId) ?? [];
        if (calls.length) void executeCalls(delegationId, calls, channel);
      }
    }
    if (event.type === "session.closed") {
      finalizedRef.current = true;
      const finalUsage = event.usage && typeof event.usage === "object" ? event.usage : {};
      setUsage(finalUsage);
      if (sessionIdRef.current) void rememberUsage(sessionIdRef.current, finalUsage);
      teardown("idle");
    }
  };

  const start = async () => {
    if (status !== "idle") return;
    setStatus("connecting");
    setError(null);
    setUsage(null);
    setSessionId(null);
    setTranscript([]);
    setActions([]);
    transcriptRef.current.clear();
    callsRef.current.clear();
    runningDelegationsRef.current.clear();
    sessionIdRef.current = null;
    finalizedRef.current = false;
    startedAtRef.current = new Date().toISOString();
    try {
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      peer.addEventListener("track", (event) => {
        if (!audioRef.current) return;
        audioRef.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audioRef.current.play().catch(() => {});
      });
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneRef.current = microphone;
      for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.addEventListener("message", (event) => handleEvent(event.data, channel));
      channel.addEventListener("close", () => {
        if (finalizedRef.current) return;
        finalizedRef.current = true;
        setError("Voice connection ended before final usage was confirmed.");
        teardown("idle");
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            peer.removeEventListener("icegatheringstatechange", onState);
            reject(new Error("Timed out while gathering microphone connection details"));
          }, 10_000);
          function onState() {
            if (peer.iceGatheringState !== "complete") return;
            window.clearTimeout(timer);
            peer.removeEventListener("icegatheringstatechange", onState);
            resolve();
          }
          peer.addEventListener("icegatheringstatechange", onState);
          onState();
        });
      }
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("The browser did not create an SDP offer");
      const result = await value(await fetch("/api/live/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-foolscap": "live" },
        body: JSON.stringify({ sdp, backendModel }),
      }));
      const selectedBackend = String(result.foolscap?.backendModel ?? "gpt-5.6-luna");
      backendModelRef.current = selectedBackend;
      setBackendModel(selectedBackend);
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      finalizedRef.current = true;
      teardown("idle");
    }
  };

  const stop = () => {
    const channel = channelRef.current;
    if (status !== "live" || !channel || channel.readyState !== "open") return;
    setStatus("closing");
    channel.send(JSON.stringify({ type: "session.close" }));
    closeTimerRef.current = window.setTimeout(() => {
      setError("The call ended without confirmed final usage.");
      finalizedRef.current = true;
      teardown("idle");
    }, 15_000);
  };

  return (
    <div className="min-h-full flex-1 overflow-y-auto bg-paper p-6">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <section className="min-h-[520px] border border-rule bg-[#0b1014] p-6 text-[#edf0ee]">
          <div className="flex flex-wrap items-start gap-4"><div className="min-w-0 flex-1"><p className="instrument text-[9px] text-[#81909a]">voice command channel</p><h1 className="mt-2 font-mono text-2xl font-bold">Tell Foolscap what needs doing.</h1><p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-[#9ca8af]">GPT-Live keeps the conversation natural. Workspace tools create durable tasks, search context, move cards, and dispatch agents through the same budget policy as the board.</p></div><span className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase ${status === "live" ? "border-[#6fbf97] text-[#6fbf97]" : "border-[#39464e] text-[#87949c]"}`}>{status}</span></div>

          <div className="my-8 flex h-24 items-center justify-center gap-2" aria-hidden="true">{Array.from({ length: 17 }, (_, index) => <span key={index} className={`w-1 bg-[#d6a05c] ${status === "live" ? "animate-pulse" : ""}`} style={{ height: status === "live" ? `${24 + (index % 5) * 10}px` : "8px", animationDelay: `${index * 55}ms` }} />)}</div>
          <div className="flex flex-wrap justify-center gap-3">
            {status === "idle" && <select value={backendModel} onChange={(event) => { setBackendModel(event.target.value); backendModelRef.current = event.target.value; }} aria-label="Voice delegation model" className="border border-[#39464e] bg-[#0b1014] px-3 py-2 font-mono text-[10px] text-[#9ca8af]">{(liveStatus?.backendModels ?? [backendModel]).map((model) => <option key={model} value={model}>{model}</option>)}</select>}
            {status === "idle" ? <button type="button" disabled={liveStatus?.ready === false} onClick={() => void start()} className="border border-[#d6a05c] bg-[#2a2118] px-5 py-3 font-mono text-xs uppercase tracking-[0.15em] text-[#e3b173] disabled:opacity-40">start conversation</button> : <button type="button" disabled={status !== "live"} onClick={stop} className="border border-[#bf6c5d] px-5 py-3 font-mono text-xs uppercase tracking-[0.15em] text-[#d88777] disabled:opacity-50">{status === "closing" ? "finishing…" : "end conversation"}</button>}
          </div>
          {liveStatus?.ready === false && <p className="mt-3 text-center font-mono text-[10px] text-[#81909a]">Set OPENAI_API_KEY and restart Foolscap to enable voice.</p>}
          <audio ref={audioRef} autoPlay controls className="mx-auto mt-5 h-8 max-w-full opacity-70" />
          {sessionId && <p className="mt-3 text-center font-mono text-[9px] text-[#63717a]">{sessionId} · gpt-live-1 + {backendModel} delegation</p>}
          {error && <p className="mx-auto mt-5 max-w-xl border border-[#653c35] bg-[#241715] p-3 font-mono text-[10px] text-[#df8e7d]">{error}</p>}

          <div className="mt-8 border-t border-[#29343b] pt-5"><p className="instrument text-[9px] text-[#81909a]">live transcript</p><div className="mt-3 max-h-72 space-y-3 overflow-y-auto">{transcript.map((row) => <div key={row.key} className="grid grid-cols-[72px_1fr] gap-3"><span className={`font-mono text-[9px] uppercase ${row.role === "you" ? "text-[#d6a05c]" : "text-[#6fbf97]"}`}>{row.role}</span><p className="text-sm leading-relaxed text-[#c8d0d4]">{row.text}</p></div>)}{!transcript.length && <p className="font-mono text-[10px] text-[#63717a]">Transcript and delegated actions will appear here after the session starts.</p>}</div></div>
        </section>

        <div className="space-y-4">
          <section className="border border-rule bg-paper-raised p-5"><p className="instrument text-[9px]">try saying</p><ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2"><li>“Add a P1 task to fix the login timeout with a three dollar budget.”</li><li>“What work is blocked right now?”</li><li>“Search the codebase for the ACP permission flow.”</li><li>“Move that task to ready, then dispatch it.”</li><li>“Make the replay tests pass and have a second agent review it — go.”</li><li>“What needs me?”</li></ul><p className="mt-4 border-t border-rule pt-3 font-mono text-[10px] text-ink-3">Agent execution requires an explicit run/start/execute/begin/dispatch phrase in the recent user transcript.</p></section>
          <section className="border border-rule bg-paper-raised"><header className="flex items-center justify-between border-b border-rule px-4 py-3"><div><p className="instrument text-[9px]">delegation ledger</p><h2 className="mt-1 font-mono text-sm font-bold">Workspace actions</h2></div><span className="font-mono text-[10px] text-ink-3">{actions.length}</span></header><div className="max-h-[330px] divide-y divide-rule overflow-y-auto">{actions.map((action) => <div key={action.id} className="p-3"><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${action.state === "done" ? "bg-moss" : action.state === "failed" ? "bg-oxide" : "animate-pulse bg-brass-bright"}`} /><span className="font-mono text-xs">{action.name}</span><span className="instrument ml-auto text-[9px]">{action.state}</span></div><p className="mt-2 line-clamp-3 break-all font-mono text-[9px] leading-relaxed text-ink-3">{action.detail}</p></div>)}{!actions.length && <p className="p-5 font-mono text-[10px] leading-relaxed text-ink-3">No backend actions yet. Conversation stays in GPT-Live until it needs workspace state or a durable operation.</p>}</div></section>
          {usage && <section className="border border-rule bg-paper-sunk p-4"><p className="instrument text-[9px]">final usage confirmed</p><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-ink-3">{JSON.stringify(usage, null, 2)}</pre></section>}
        </div>
      </div>
    </div>
  );
}
