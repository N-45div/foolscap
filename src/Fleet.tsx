import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionDoc } from "./model";
import { Notebook } from "./Notebook";
import { rank, TIER_LABEL, type Attention } from "../server/attention.mjs";

/**
 * The fleet — many agents, one queue.
 *
 * Five running agents are not five things to watch; they are one queue
 * to work. The list on the left is ranked by who needs you (blocked on
 * a permission, tests just went red, turn finished and waiting), and
 * `n` jumps to the top of it. Agents that are working are left alone.
 * The right pane is the selected agent as a document — the same
 * renderer as the archive, because it is the same document — with the
 * permission prompt above it and the composer below.
 */

type Evidence = {
  testsPassed: number;
  testsFailed: number;
  errors: number;
  edited: number;
};

type Permission = {
  requestId: string | number;
  toolCall: { toolCallId?: string; title?: string; kind?: string };
  options: Array<{ optionId: string; name?: string; kind?: string }>;
  /** "text" when the agent asked a question rather than allow/deny. */
  answer?: "text";
};

type Snapshot = {
  id: string;
  name: string;
  agent: string;
  agentLabel: string;
  driver?: string;
  /** Cloud agents have a page of their own. */
  url?: string | null;
  cwd: string;
  status: "starting" | "idle" | "working" | "blocked" | "done" | "exited" | "error";
  stopReason?: string | null;
  activity?: { kind: string; text: string } | null;
  pendingPermission: Permission | null;
  evidence: Evidence;
  turns: number;
  startedAt: string;
  turnStartedAt?: string | null;
  doneAt?: string | null;
  blockedSince?: string | null;
  endedAt?: string | null;
  lastActivityAt: string;
  error?: string | null;
};

type Ranked = Snapshot & { attention: Attention };

const HEADERS = { "content-type": "application/json", "x-foolscap": "fleet" };

/** Status and stop reasons in plain words. */
const STATUS_WORDS: Record<string, string> = {
  starting: "starting up",
  idle: "ready",
  working: "working",
  blocked: "waiting for you",
  done: "finished",
  exited: "closed",
  error: "hit a problem",
};
const STOP_WORDS: Record<string, string> = {
  end_turn: "finished",
  cancelled: "stopped",
  error: "hit an error",
  expired: "expired",
  max_tokens: "ran out of room",
  refusal: "declined",
};
const post = (path: string, body?: unknown) =>
  fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body ?? {}) });

function ago(iso: string | undefined, nowMs: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function glyph(s: Ranked): { mark: string; cls: string } {
  switch (s.status) {
    case "blocked":
      return { mark: "⚠", cls: "text-oxide" };
    case "error":
    case "exited":
      return { mark: "✗", cls: "text-oxide" };
    case "done":
      return s.attention.tier === 0
        ? { mark: "✗", cls: "text-oxide" }
        : s.attention.tier === 1
          ? { mark: "●", cls: "text-brass-bright" }
          : { mark: "○", cls: "text-ink-3" };
    case "working":
      return { mark: "◌", cls: "text-ink-2 animate-pulse" };
    default:
      return { mark: "·", cls: "text-ink-3" };
  }
}

function EvidenceChips({ ev }: { ev: Evidence }) {
  const chips: Array<{ text: string; cls: string }> = [];
  if (ev.testsFailed > 0) chips.push({ text: `tests ✗${ev.testsFailed}`, cls: "text-oxide" });
  else if (ev.testsPassed > 0) chips.push({ text: "tests ✓", cls: "text-moss" });
  if (ev.errors > 0 && ev.testsFailed === 0) chips.push({ text: `${ev.errors} err`, cls: "text-oxide" });
  if (ev.edited > 0) chips.push({ text: `${ev.edited} file${ev.edited === 1 ? "" : "s"}`, cls: "text-ink-3" });
  if (chips.length === 0) return null;
  return (
    <span className="tnum ml-auto flex shrink-0 gap-2 font-mono text-[10px]">
      {chips.map((c) => (
        <span key={c.text} className={c.cls}>
          {c.text}
        </span>
      ))}
    </span>
  );
}

export function Fleet() {
  const [sessions, setSessions] = useState<Snapshot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [doc, setDoc] = useState<SessionDoc | null>(null);
  const [agents, setAgents] = useState<Array<{ id: string; label: string }>>([]);
  const [launch, setLaunch] = useState({ agent: "claude", cwd: "", name: "" });
  const [draft, setDraft] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The live feed. Every state change on any agent lands here.
  useEffect(() => {
    const es = new EventSource("/api/fleet/events");
    es.onmessage = (e) => {
      setSessions(JSON.parse(e.data));
      setError(null);
    };
    es.onerror = () => setError("live feed disconnected — is foolscap still running?");
    return () => es.close();
  }, []);

  useEffect(() => {
    fetch("/api/fleet/agents")
      .then((r) => r.json())
      .then(setAgents)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // "Seen" is a client-side notion, so rank here rather than trusting
  // the server's order.
  const ranked = useMemo<Ranked[]>(
    () => (sessions ? (rank(sessions, seen) as Ranked[]) : []),
    [sessions, seen],
  );
  const needsYou = ranked.filter((s) => s.attention.tier === 0).length;
  const review = ranked.filter((s) => s.attention.tier === 1).length;

  useEffect(() => {
    document.title = needsYou
      ? `(${needsYou}) foolscap — needs you`
      : review
        ? `(${review}) foolscap — review`
        : "foolscap";
    return () => {
      document.title = "foolscap";
    };
  }, [needsYou, review]);

  const sel = ranked.find((s) => s.id === selected) ?? null;

  // Refresh the selected document whenever that agent changes.
  const selKey = sel ? `${sel.id}:${sel.lastActivityAt}:${sel.status}` : null;
  useEffect(() => {
    if (!sel) {
      setDoc(null);
      return;
    }
    let stale = false;
    fetch(`/api/fleet/${sel.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (!stale) setDoc(d.doc as SessionDoc);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const markSeen = useCallback((s: Snapshot) => {
    if (s.status !== "done") return;
    const key = `${s.id}:${s.turns}`;
    setSeen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const open = useCallback(
    (s: Snapshot) => {
      setSelected(s.id);
      markSeen(s);
    },
    [markSeen],
  );

  // Reading a session as its turn ends counts as reviewing it.
  useEffect(() => {
    if (sel) markSeen(sel);
  }, [sel, markSeen]);

  const next = useCallback(() => {
    const target = ranked.find((s) => s.attention.tier <= 1 && s.id !== selected) ??
      ranked.find((s) => s.attention.tier <= 1);
    if (target) open(target);
  }, [ranked, selected, open]);

  const decide = useCallback(
    async (optionId: string, text?: string) => {
      if (!sel) return;
      const r = await post(`/api/fleet/${sel.id}/permission`, { optionId, text });
      if (!r.ok) setError((await r.json()).error);
      else setAnswer("");
    },
    [sel],
  );

  // n → next thing that needs you; a / d → allow / deny when blocked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "n") {
        e.preventDefault();
        next();
      } else if ((e.key === "a" || e.key === "d") && sel?.pendingPermission) {
        e.preventDefault();
        const opts = sel.pendingPermission.options;
        const pick =
          e.key === "a"
            ? opts.find((o) => /allow/i.test(o.kind ?? o.optionId))
            : opts.find((o) => /reject|deny/i.test(o.kind ?? o.optionId));
        if (pick) decide(pick.optionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, sel, decide]);

  const send = async () => {
    if (!sel || !draft.trim()) return;
    const r = await post(`/api/fleet/${sel.id}/prompt`, { text: draft });
    if (!r.ok) {
      setError((await r.json()).error);
      return;
    }
    setDraft("");
  };

  const doLaunch = async () => {
    const r = await post("/api/fleet/launch", {
      agent: launch.agent,
      cwd: launch.cwd.trim() || undefined,
      name: launch.name.trim() || undefined,
    });
    if (!r.ok) {
      setError((await r.json()).error);
      return;
    }
    const s = (await r.json()) as Snapshot;
    setSelected(s.id);
    setLaunch((l) => ({ ...l, name: "" }));
  };

  const canPrompt = sel?.status === "idle" || sel?.status === "done";
  const canCancel = sel?.status === "working" || sel?.status === "blocked";

  return (
    <div className="flex h-full">
      {/* ── The queue ── */}
      <section className="flex w-80 shrink-0 flex-col border-r border-rule bg-paper-sunk">
        <header className="flex items-baseline gap-3 border-b border-rule px-4 py-2">
          <span className="font-mono text-sm font-bold">agents</span>
          <span className="instrument tnum">
            {ranked.length} agent{ranked.length === 1 ? "" : "s"}
            {needsYou > 0 && <span className="text-oxide"> · {needsYou} need you</span>}
            {needsYou === 0 && review > 0 && <span className="text-brass-bright"> · {review} to review</span>}
          </span>
          <button
            type="button"
            onClick={next}
            disabled={!ranked.some((s) => s.attention.tier <= 1)}
            title="Jump to the next agent that needs you (n)"
            className="instrument ml-auto border border-rule-strong px-2 py-0.5 transition-colors hover:border-brass-bright hover:text-brass-bright disabled:opacity-40"
          >
            next →
          </button>
        </header>

        {/* launch */}
        <form
          className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 border-b border-rule px-4 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            doLaunch();
          }}
        >
          <label className="instrument self-center" htmlFor="fleet-agent">run</label>
          <select
            id="fleet-agent"
            value={launch.agent}
            onChange={(e) => setLaunch({ ...launch, agent: e.target.value })}
            className="min-w-0 border border-rule bg-paper px-1.5 py-0.5 font-mono text-xs"
          >
            {(agents.length ? agents : [{ id: "claude", label: "claude code" }]).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <label className="instrument self-center" htmlFor="fleet-cwd">in folder</label>
          <input
            id="fleet-cwd"
            value={launch.cwd}
            onChange={(e) => setLaunch({ ...launch, cwd: e.target.value })}
            placeholder="e.g. C:\projects\my-app — blank means here"
            className="min-w-0 border border-rule bg-paper px-1.5 py-0.5 font-mono text-xs placeholder:text-ink-3"
          />
          <label className="instrument self-center" htmlFor="fleet-name">call it</label>
          <div className="flex min-w-0 gap-1.5">
            <input
              id="fleet-name"
              value={launch.name}
              onChange={(e) => setLaunch({ ...launch, name: e.target.value })}
              placeholder="optional, e.g. fix-login"
              className="min-w-0 flex-1 border border-rule bg-paper px-1.5 py-0.5 font-mono text-xs placeholder:text-ink-3"
            />
            <button
              type="submit"
              className="instrument shrink-0 border border-rule-strong px-2 py-0.5 transition-colors hover:border-brass-bright hover:text-brass-bright"
            >
              launch
            </button>
          </div>
        </form>

        <nav className="min-h-0 flex-1 overflow-y-auto">
          {sessions === null && <p className="instrument px-4 py-6">connecting…</p>}
          {sessions?.length === 0 && (
            <p className="px-4 py-6 font-mono text-xs leading-relaxed text-ink-3">
              No agents running yet. Start one above: pick which agent, the
              folder it should work in, and a name. Start a few — foolscap
              tells you which one needs you, and{" "}
              <span className="text-brass-bright">n</span> takes you there.
            </p>
          )}
          {[0, 1, 2, 3].map((tier) => {
            const rows = ranked.filter((s) => s.attention.tier === tier);
            if (rows.length === 0) return null;
            return (
              <section key={tier}>
                <h3
                  className={`instrument border-b border-rule bg-paper px-4 py-1.5 ${
                    tier === 0 ? "text-oxide" : tier === 1 ? "text-brass-bright" : ""
                  }`}
                >
                  {TIER_LABEL[tier]} · {rows.length}
                </h3>
                <ul>
                  {rows.map((s) => {
                    const g = glyph(s);
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => open(s)}
                          className={`block w-full border-b border-rule px-4 py-2.5 text-left transition-colors hover:bg-brass-wash ${
                            selected === s.id ? "bg-brass-wash" : ""
                          }`}
                        >
                          <span className="flex items-baseline gap-2">
                            <span className={`w-3 font-mono text-xs ${g.cls}`}>{g.mark}</span>
                            <span className="truncate font-mono text-xs text-ink">{s.name}</span>
                            <span className="instrument max-w-24 shrink-0 truncate">{s.agentLabel}</span>
                            <span className="tnum ml-auto shrink-0 font-mono text-[10px] text-ink-3">
                              {ago(s.attention.since, nowMs)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-baseline gap-2">
                            <span className="w-3" />
                            <span
                              className={`truncate font-mono text-[11px] ${
                                tier === 0 ? "text-oxide" : "text-ink-3"
                              }`}
                            >
                              {s.attention.reason}
                            </span>
                            <EvidenceChips ev={s.evidence} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>

        <footer className="border-t border-rule px-4 py-2">
          <span className="instrument">
            keys · n next · a allow · d deny
          </span>
        </footer>
      </section>

      {/* ── The selected agent, as a document ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        {error && (
          <p className="border-b border-rule bg-oxide-wash px-5 py-2 font-mono text-xs text-oxide">
            {error}
          </p>
        )}
        {!sel && (
          <div className="flex h-full items-center justify-center">
            <p className="max-w-[48ch] text-center font-mono text-sm leading-relaxed text-ink-3">
              Pick an agent, or launch one. The queue on the left is ordered by
              who needs you — blocked, red, finished — and{" "}
              <span className="text-brass-bright">n</span> jumps to the top of it.
            </p>
          </div>
        )}
        {sel && (
          <>
            {sel.pendingPermission && (
              <div className="border-b border-rule bg-oxide-wash px-5 py-3">
                <p className="instrument text-oxide">
                  {sel.name} needs your permission
                  {sel.blockedSince && ` · waiting ${ago(sel.blockedSince, nowMs)}`}
                </p>
                <p className="mt-1 whitespace-pre-wrap font-mono text-sm">
                  {sel.pendingPermission.toolCall.title ?? "an action"}
                  {sel.pendingPermission.toolCall.kind && (
                    <span className="instrument ml-2">{sel.pendingPermission.toolCall.kind}</span>
                  )}
                </p>
                {sel.pendingPermission.answer === "text" && (
                  <form
                    className="mt-2 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (answer.trim()) decide("answer", answer);
                    }}
                  >
                    <input
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      placeholder="your answer"
                      aria-label="Answer the agent's question"
                      className="min-w-0 flex-1 border border-rule bg-paper px-2 py-1 font-mono text-sm outline-none placeholder:text-ink-3 focus:border-brass-bright"
                    />
                    <button
                      type="submit"
                      disabled={!answer.trim()}
                      className="instrument border border-brass-bright px-2.5 py-1 text-brass-bright hover:bg-brass-wash disabled:opacity-40"
                    >
                      reply
                    </button>
                  </form>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {sel.pendingPermission.options.map((o) => {
                    const deny = /reject|deny/i.test(o.kind ?? o.optionId);
                    return (
                      <button
                        key={o.optionId}
                        type="button"
                        onClick={() => decide(o.optionId)}
                        className={`instrument border px-2.5 py-1 transition-colors ${
                          deny
                            ? "border-rule-strong hover:border-oxide hover:text-oxide"
                            : "border-brass-bright text-brass-bright hover:bg-brass-wash"
                        }`}
                      >
                        {o.name ?? o.optionId}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {sel.status === "error" && (
              <p className="border-b border-rule bg-oxide-wash px-5 py-2 font-mono text-xs text-oxide">
                {sel.error ?? "the agent failed to start"}
              </p>
            )}
            {sel.status === "starting" && (
              <p className="instrument border-b border-rule px-5 py-2">
                starting {sel.agentLabel} in {sel.cwd}…
              </p>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {doc && <Notebook doc={doc} exportName={sel.name} />}
              {doc && doc.cells.length === 0 && (
                <p className="px-5 py-8 font-mono text-sm text-ink-3">
                  {sel.agentLabel} is ready in {sel.cwd}. Give it something to do.
                </p>
              )}
            </div>

            <div className="border-t border-rule bg-paper-sunk px-4 py-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={
                  canPrompt
                    ? `Tell ${sel.name} what to do next — Ctrl+Enter sends`
                    : sel.status === "blocked"
                      ? "Answer the question above first"
                      : `${sel.name} is ${STATUS_WORDS[sel.status] ?? sel.status}`
                }
                disabled={!canPrompt}
                rows={2}
                className="w-full resize-y border border-rule bg-paper px-3 py-2 font-mono text-sm leading-relaxed outline-none placeholder:text-ink-3 focus:border-brass-bright disabled:opacity-60"
              />
              <div className="mt-2 flex items-baseline gap-3">
                <span className="instrument">
                  {sel.agentLabel} · {STATUS_WORDS[sel.status] ?? sel.status}
                  {sel.activity && sel.status === "working" && ` · ${sel.activity.text}`}
                  {sel.stopReason && sel.status === "done" && ` · ${STOP_WORDS[sel.stopReason] ?? sel.stopReason}`}
                  {sel.url && (
                    <>
                      {" · "}
                      <a
                        href={sel.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brass-bright hover:underline"
                      >
                        open in {sel.agentLabel} ↗
                      </a>
                    </>
                  )}
                </span>
                <div className="ml-auto flex gap-2">
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => post(`/api/fleet/${sel.id}/cancel`)}
                      className="instrument border border-rule-strong px-2.5 py-1 hover:border-oxide hover:text-oxide"
                    >
                      stop
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async () => {
                      await post(`/api/fleet/${sel.id}/close`);
                      setSelected(null);
                    }}
                    title="Shut this agent down and remove it from the list"
                    className="instrument border border-rule-strong px-2.5 py-1 hover:border-oxide hover:text-oxide"
                  >
                    close
                  </button>
                  <button
                    type="button"
                    onClick={send}
                    disabled={!canPrompt || !draft.trim()}
                    className="instrument border border-brass-bright px-2.5 py-1 text-brass-bright hover:bg-brass-wash disabled:opacity-40"
                  >
                    send
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
