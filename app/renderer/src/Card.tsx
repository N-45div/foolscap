/** One task in the inbox: a card when it is your move, a quiet line when it is the agent's. */
import { useState } from "react";
import { ago, api, folderName, type Session } from "./api";
import { Cross, Folder, Next, StatusMark } from "./icons";

type Outcome = Promise<{ ok: true } | { error: string }>;

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const run = async (action: Outcome) => {
    const result = await action;
    setError("error" in result ? result.error : null);
  };
  return { error, run };
}

function Evidence({ s }: { s: Session }) {
  const v = s.verified;
  const chips: { text: string; tone?: "green" | "red" }[] = [];
  if (v?.counts) chips.push({ text: `${v.counts.passed}/${v.counts.total} tests`, tone: v.verdict === "green" ? "green" : v.verdict === "red" ? "red" : undefined });
  else if (v) chips.push({ text: `tests ${v.verdict}`, tone: v.verdict === "green" ? "green" : v.verdict === "red" ? "red" : undefined });
  if (v) chips.push({ text: "checked by foolscap" });
  if (!v && s.evidence.testsFailed > 0) chips.push({ text: `${s.evidence.testsFailed} failing (agent's run)`, tone: "red" });
  if (s.changes?.files) chips.push({ text: `+${s.changes.added} −${s.changes.removed} · ${s.changes.files} file${s.changes.files === 1 ? "" : "s"}` });
  else if (s.evidence.edited > 0) chips.push({ text: `edited ${s.evidence.edited}` });
  if (s.queue.length) chips.push({ text: `${s.queue.length} queued` });
  if (!chips.length) return null;
  return (
    <div className="chips">
      {chips.map((c) => (
        <span key={c.text} className={`chip ${c.tone ?? ""}`}>{c.text}</span>
      ))}
    </div>
  );
}

function Queue({ s }: { s: Session }) {
  if (!s.queue.length) return null;
  return (
    <ul className="queue" aria-label="Next prompts">
      {s.queue.map((q, i) => (
        <li key={`${i}:${q}`}>
          <Next />
          <span>{q}</span>
          <button className="icon-btn" aria-label={`Remove "${q}" from the queue`} onClick={() => api().dequeue(s.id, i)}>
            <Cross />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A one-line input that sends on Enter. */
function Say({ placeholder, onSend, onDone }: { placeholder: string; onSend: (text: string) => Outcome; onDone: () => void }) {
  const [text, setText] = useState("");
  const { error, run } = useAction();
  return (
    <form
      className="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        await run(onSend(text.trim()));
        setText("");
        onDone();
      }}
    >
      <label className="sr-only">{placeholder}</label>
      <input autoFocus value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} />
      <button className="btn" type="submit">Send</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

export function Card({ s, focused = false }: { s: Session; focused?: boolean }) {
  const [saying, setSaying] = useState<null | "reply" | "next">(null);
  const { error, run } = useAction();
  const p = s.pendingPermission;
  const allow = p?.options.find((o) => /allow/i.test(o.kind ?? o.optionId))?.optionId ?? "allow_once";
  const reject = p?.options.find((o) => /reject/i.test(o.kind ?? o.optionId))?.optionId ?? "reject_once";
  const ended = s.status === "exited" || s.status === "error";
  const ask = p ? (p.toolCall?.title ?? "Permission requested") : s.error && ended ? s.error : s.attention.reason;

  return (
    <article className={`card ${focused ? "focused" : ""}`} aria-label={`${s.name}: ${ask}`}>
      <StatusMark s={s} />
      <div className="body">
        <div className="meta">
          <span>
            <b>{s.name}</b> · {s.agentLabel} · {folderName(s.worktree?.repo ?? s.cwd)}
          </span>
          <span>{ago(s.blockedSince ?? s.doneAt ?? s.turnStartedAt ?? s.startedAt)}</span>
        </div>
        <p className="ask">{p ? `Wants to: ${ask}` : ask}</p>
        {!p && s.lastReply && <p className="reply">{s.lastReply}</p>}
        <Evidence s={s} />
        {s.held && <span className="held">Next prompt held: {s.held.reason}</span>}
        <Queue s={s} />

        {saying ? (
          <Say
            placeholder={saying === "reply" ? `Reply to ${s.name}…` : "Then…"}
            onSend={(text) => (saying === "reply" ? api().prompt(s.id, text) : api().enqueue(s.id, text))}
            onDone={() => setSaying(null)}
          />
        ) : (
          <div className="actions">
            {p && p.answer !== "text" && (
              <>
                <button className="btn primary" onClick={() => run(api().answer(s.id, allow))}>Approve</button>
                <button className="btn" onClick={() => run(api().answer(s.id, reject))}>Deny</button>
              </>
            )}
            {p?.answer === "text" && <button className="btn primary" onClick={() => setSaying("reply")}>Answer</button>}
            {!p && s.held && (
              <>
                <button className="btn primary" onClick={() => run(api().sendNext(s.id))}>Send anyway</button>
                <button className="btn" onClick={() => run(api().dequeue(s.id, 0))}>Drop it</button>
              </>
            )}
            {!p && !ended && (
              <button className={`btn ${!s.held && s.verified?.verdict !== "green" && !(s.worktree && s.status === "done") ? "primary" : ""}`} onClick={() => setSaying("reply")}>
                Reply
              </button>
            )}
            {!p && !ended && <button className="btn quiet" onClick={() => setSaying("next")}>+ Then…</button>}
            {!p && s.status === "done" && s.worktree && !s.held && (
              <>
                <button className={`btn ${s.verified?.verdict === "green" ? "primary" : ""}`} onClick={() => run(api().merge(s.id))}>
                  Merge
                </button>
                <button className="btn quiet" onClick={() => run(api().discard(s.id))}>Discard</button>
              </>
            )}
            {!p && s.status === "done" && !s.worktree && (
              <button className="btn quiet" onClick={() => run(api().seen(s.id, s.turns))}>Done</button>
            )}
            {ended && <button className="btn" onClick={() => run(api().close(s.id))}>Clear</button>}
            <button className="btn quiet" aria-label={`Open the ${folderName(s.cwd)} folder`} onClick={() => run(api().openFolder(s.id))}>
              <Folder />
            </button>
          </div>
        )}
        {error && <span className="error">{error}</span>}
      </div>
    </article>
  );
}

/** A quiet line for work in progress; click to queue what comes next. */
export function Quiet({ s }: { s: Session }) {
  const [adding, setAdding] = useState(false);
  const doing = s.activity?.text ?? s.attention.reason;
  const since = s.turnStartedAt ?? s.startedAt;
  return (
    <li>
      <StatusMark s={s} />
      {adding ? (
        <Say placeholder={`Then ${s.name} should…`} onSend={(text) => api().enqueue(s.id, text)} onDone={() => setAdding(false)} />
      ) : (
        <button className="what btn quiet" style={{ height: "auto", padding: 0, justifyContent: "flex-start" }} onClick={() => setAdding(true)} title="Queue what comes next">
          <b>{s.name}</b>
          <span className="muted"> · {doing}</span>
        </button>
      )}
      <span className="when">
        {s.queue.length ? `${s.queue.length} queued · ` : ""}
        {ago(since)}
      </span>
    </li>
  );
}
