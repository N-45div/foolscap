/**
 * The pill: a small live capsule that floats above the taskbar.
 *
 * At rest it shows one mark per task (dot: needs you, triangle: red,
 * ring: working) and the counts. Hovering opens the top item so it can
 * be answered right there; clicking the capsule opens the orbit. When
 * nothing is going on it shrinks to a single dot.
 */
import { useRef, useState } from "react";
import { api, type AppState, type Session } from "./api";

function Mark({ s }: { s: Session }) {
  const red = s.verified?.verdict === "red" || s.status === "error" || Boolean(s.held) || s.evidence.testsFailed > 0;
  if (s.attention.tier <= 1 && red) {
    return (
      <svg width="12" height="11" viewBox="0 0 13 12" aria-hidden="true">
        <path d="M6.5 0.5l6 11h-12z" fill="var(--failed)" />
      </svg>
    );
  }
  if (s.attention.tier <= 1) return <span className="pill-dot" />;
  if (s.attention.tier === 2) return <span className="pill-ring pulse" />;
  return null;
}

/** The one thing to answer from the pill, with its actions. */
function Peek({ s }: { s: Session }) {
  const p = s.pendingPermission;
  const allow = p?.options.find((o) => /allow/i.test(o.kind ?? o.optionId))?.optionId ?? "allow_once";
  const reject = p?.options.find((o) => /reject/i.test(o.kind ?? o.optionId))?.optionId ?? "reject_once";
  const ask = p ? (p.toolCall?.title ?? "Permission requested") : s.attention.reason;
  return (
    <div className="peek">
      <div className="peek-meta">
        <b>{s.name}</b> · {s.agentLabel}
      </div>
      <p className="peek-ask">{p ? `Wants to: ${ask}` : ask}</p>
      <div className="actions">
        {p && p.answer !== "text" ? (
          <>
            <button className="btn primary" onClick={() => api().answer(s.id, allow)}>Approve</button>
            <button className="btn" onClick={() => api().answer(s.id, reject)}>Deny</button>
          </>
        ) : s.held ? (
          <button className="btn primary" onClick={() => api().sendNext(s.id)}>Send anyway</button>
        ) : s.worktree && s.verified?.verdict === "green" ? (
          <button className="btn primary" onClick={() => api().merge(s.id)}>Merge</button>
        ) : null}
        <button className="btn quiet" onClick={() => api().openPanel(s.id)}>Open</button>
      </div>
    </div>
  );
}

export function Pill({ state }: { state: AppState }) {
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const live = state.sessions.filter((s) => s.attention.tier <= 2);
  const top = state.sessions.find((s) => s.attention.tier <= 1) ?? null;
  const { needs, working } = state.counts;
  const quiet = !needs && !working;

  // The window lets clicks through everywhere except the pill itself; the
  // main process stops passing them through while the pointer is on it.
  const enter = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    api().pillExpand(true);
    setOpen(true);
  };
  const leave = () => {
    leaveTimer.current = window.setTimeout(() => {
      setOpen(false);
      api().pillExpand(false);
    }, 350);
  };

  return (
    <div className="pill-stage" onMouseEnter={enter} onMouseLeave={leave}>
      {open && top && <Peek s={top} />}
      {quiet ? (
        <button className="pill pill-quiet" aria-label="foolscap: all quiet. Open." onClick={() => api().openPanel()}>
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M4 2.5h7l3 3v10H4z" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M11 2.5v3h3" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <div className="pill">
          {/* Drag the pill anywhere by this end; the rest is a button. */}
          <span className="pill-grip" title="Drag to move" aria-hidden="true" />
          <button className="pill-body-btn" aria-label={`foolscap: ${needs} need you, ${working} working. Open.`} onClick={() => api().openPanel()}>
            <span className="pill-marks">
              {live.slice(0, 8).map((s) => (
                <Mark key={s.id} s={s} />
              ))}
            </span>
            <span className="pill-count">
              <span style={{ color: needs ? "var(--accent)" : "var(--ink-3)" }}>{needs}</span> · {working}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
