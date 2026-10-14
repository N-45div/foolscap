/** Settings: Claude Code sessions from the person's own terminal, via hooks they approve. */
import { useState } from "react";
import { api, type AppState } from "./api";

export function TerminalSessionsSetting({ hooks }: { hooks: AppState["hooks"] }) {
  const [plan, setPlan] = useState<{ file: string; adds: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<{ ok: true } | { error: string }>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if ("error" in result) return setError(result.error);
    setError(null);
    setPlan(null);
  };

  if (hooks.on) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <span>
            Claude Code sessions from my terminal
            <br />
            <span className="hint">On. They show up here; approve them from notifications.</span>
          </span>
          <button className="btn quiet" disabled={busy} onClick={() => run(() => api().hooksDisable())}>Turn off</button>
        </div>
        {hooks.error && <span className="error">Not listening: {hooks.error}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    );
  }

  if (plan) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>
          foolscap will add these hooks to <code className="cmd">{plan.file}</code>. Your file is backed up first,
          everything else in it stays as it is, and Turn off removes exactly these.
        </span>
        <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", fontSize: 11, lineHeight: "16px" }} className="cmd">
          {JSON.stringify(plan.adds, null, 2)}
        </pre>
        <span className="hint">
          If foolscap is closed, Claude Code just carries on. A permission you don't answer here within 45 seconds is
          asked in the terminal as usual.
        </span>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={() => run(() => api().hooksEnable())}>Add them</button>
          <button className="btn quiet" onClick={() => setPlan(null)}>Cancel</button>
        </div>
        {error && <span className="error">{error}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
      <span>
        Claude Code sessions from my terminal
        <br />
        <span className="hint">See and approve sessions you start yourself, not only ones foolscap starts.</span>
      </span>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          const result = await api().hooksPlan();
          if ("error" in result) setError(result.error);
          else setPlan(result.plan);
        }}
      >
        Set up…
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
