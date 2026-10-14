/** The full window: the same inbox on the left, one task in detail on the right. */
import { useEffect } from "react";
import { api, folderName, type AppState, type Session } from "./api";
import { Card, Quiet } from "./Card";
import { Composer } from "./Composer";
import { LicenceBanner } from "./Licence";
import { Calm, Header, SettingsSheet, agentsMove, yourMove } from "./Panel";

function Detail({ s }: { s: Session }) {
  const v = s.verified;
  const runs = s.validations ?? [];
  return (
    <div className="detail">
      <h1>{s.name}</h1>
      <div className="sub">
        {s.agentLabel} · {s.cwd} · {s.status}
        {s.turns ? ` · ${s.turns} turn${s.turns === 1 ? "" : "s"}` : ""}
      </div>

      {s.lastPrompt && (
        <>
          <h3>Asked</h3>
          <div className="said">{s.lastPrompt}</div>
        </>
      )}
      {s.lastReply && (
        <>
          <h3>Said</h3>
          <div className="said">{s.lastReply}</div>
        </>
      )}

      <h3>foolscap's check</h3>
      {v ? (
        <>
          <div className="said">
            Tests {v.verdict}: {v.reason}
            {v.line ? ` · ran ${v.line}` : ""}
            {v.source ? ` (from ${v.source})` : ""}
          </div>
          {v.outputTail && <pre>{v.outputTail}</pre>}
        </>
      ) : (
        <div className="said muted">
          {s.assistant ? "Assistants have no tests to check." : "Not checked yet. foolscap runs the repo's own tests after each turn."}
        </div>
      )}

      {runs.length > 0 && (
        <>
          <h3>The agent's own runs</h3>
          <ul className="queue">
            {runs.map((r) => (
              <li key={r.key}>
                <span />
                <span>
                  <code className="cmd">{r.command}</code> {r.verdict}: {r.reason}
                </span>
                <span />
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Next prompts</h3>
      {s.queue.length ? (
        <ol>
          {s.queue.map((q, i) => (
            <li key={`${i}:${q}`}>{q}</li>
          ))}
        </ol>
      ) : (
        <div className="said muted">None queued. Use "+ Then…" to line one up for after a green turn.</div>
      )}

      <div className="actions" style={{ marginTop: 20 }}>
        {["working", "blocked", "checking", "starting"].includes(s.status) && (
          <button className="btn" onClick={() => api().cancel(s.id)}>Stop</button>
        )}
        <button className="btn" onClick={() => api().openFolder(s.id)}>Open {folderName(s.cwd)}</button>
        <button className="btn quiet" onClick={() => api().close(s.id)}>Close task</button>
      </div>
    </div>
  );
}

export function Full({ state, focus, setFocus }: { state: AppState; focus: string | null; setFocus: (id: string) => void }) {
  const yours = yourMove(state.sessions);
  const theirs = agentsMove(state.sessions);
  const selected = state.sessions.find((s) => s.id === focus) ?? state.sessions[0] ?? null;

  useEffect(() => {
    document.body.classList.add("full");
  }, []);

  return (
    <div className="full-grid">
      <div className="left">
        <Header state={state} />
        <div className="rule" />
        {yours.length ? (
          <>
            <div className="section-head">
              <h2>Your move</h2>
            </div>
            <div className="cards">
              {yours.map((s) => (
                <div key={s.id} onClickCapture={() => setFocus(s.id)}>
                  <Card s={s} focused={selected?.id === s.id} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <Calm state={state} />
        )}
        {theirs.length > 0 && (
          <>
            <div className="section-head">
              <h2>Agents' move</h2>
            </div>
            <ul className="list">
              {theirs.map((s) => (
                <Quiet key={s.id} s={s} />
              ))}
            </ul>
          </>
        )}
        <div style={{ marginTop: "auto" }}>
          <Composer state={state} />
          <LicenceBanner licence={state.licence} />
          <SettingsSheet settings={state.settings} licence={state.licence} />
        </div>
      </div>
      <main className="right">{selected ? <Detail s={selected} /> : <Calm state={state} />}</main>
    </div>
  );
}
