/** The tray panel: your move on top, the agents' move below, the next task at the bottom. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, duration, type AppState, type Licence, type Session, type Settings } from "./api";
import { Card, Quiet } from "./Card";
import { Composer } from "./Composer";
import { Bell, BellOff, Expand, Gear, Sheet } from "./icons";
import { LicenceBanner, LicenceSettings } from "./Licence";
import { TerminalSessionsSetting } from "./Terminal";

export const yourMove = (sessions: Session[]) => sessions.filter((s) => s.attention.tier <= 1);
export const agentsMove = (sessions: Session[]) => sessions.filter((s) => s.attention.tier >= 2);

export function Header({ state, onSettings }: { state: AppState; onSettings?: () => void }) {
  const { needs, working } = state.counts;
  const notify = state.settings.notify;
  return (
    <header className="head">
      <div className="brand">
        <Sheet />
        <span>foolscap</span>
      </div>
      <div className="counts">
        {needs > 0 && (
          <span className="needs">
            <span className="dot" />
            {needs} need{needs === 1 ? "s" : ""} you
          </span>
        )}
        {working > 0 && <span className="muted">{working} working</span>}
        <button
          className="icon-btn"
          aria-label={notify ? "Pause notifications" : "Resume notifications"}
          title={notify ? "Pause notifications" : "Resume notifications"}
          onClick={() => api().setSettings({ notify: !notify })}
        >
          {notify ? <Bell /> : <BellOff />}
        </button>
        {onSettings && (
          <button className="icon-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
            <Gear />
          </button>
        )}
      </div>
    </header>
  );
}

/** What foolscap can honestly say when nothing waits on you. */
export function Calm({ state }: { state: AppState }) {
  const ready = state.agents.filter((a) => a.available);
  if (!state.sessions.length) {
    return (
      <div className="calm">
        <p className="big">Your agents' inbox</p>
        <p>
          Pick a repo and an agent, then say what to do. foolscap tells you the moment it needs you, and sends the next
          step only when the tests pass.
        </p>
        <p className="muted">
          {ready.length
            ? `Found: ${ready.map((a) => a.label).join(", ")}.`
            : "No agents found yet. Install Claude Code or Codex, then reopen foolscap."}
        </p>
      </div>
    );
  }
  const working = state.counts.working;
  return (
    <div className="calm">
      <p className="big">Nothing needs you</p>
      <p>{working ? `${working} agent${working === 1 ? " is" : "s are"} still working.` : "All your agents are idle."}</p>
    </div>
  );
}

export function SettingsSheet({ settings, licence, hooks }: { settings: Settings; licence: Licence; hooks: AppState["hooks"] }) {
  const set = (patch: Partial<Settings>) => api().setSettings(patch);
  return (
    <div className="sheet" aria-label="Settings">
      <LicenceSettings licence={licence} />
      <TerminalSessionsSetting hooks={hooks} />
      <label className="row">
        <span>
          Use my Claude Code settings and CLAUDE.md
          <br />
          <span className="hint">Off starts Claude Code with only the repo's own settings.</span>
        </span>
        <input type="checkbox" checked={settings.useMySettings} onChange={(e) => set({ useMySettings: e.target.checked })} />
      </label>
      <label className="row">
        <span>Notifications</span>
        <input type="checkbox" checked={settings.notify} onChange={(e) => set({ notify: e.target.checked })} />
      </label>
      <label className="row">
        <span>Start with Windows / at login</span>
        <input type="checkbox" checked={settings.openAtLogin} onChange={(e) => set({ openAtLogin: e.target.checked })} />
      </label>
      <label className="row">
        <span>Theme</span>
        <select value={settings.theme} onChange={(e) => set({ theme: e.target.value as Settings["theme"] })}>
          <option value="system">Follow the system</option>
          <option value="dark">Graphite (dark)</option>
          <option value="light">Paper (light)</option>
        </select>
      </label>
      <label className="row">
        <span>
          Codex model
          <br />
          <span className="hint">Blank uses ~/.codex/config.toml.</span>
        </span>
        <input
          type="text"
          defaultValue={settings.codexModel ?? ""}
          placeholder="e.g. gpt-5.5"
          onBlur={(e) => set({ codexModel: e.target.value.trim() || null })}
        />
      </label>
      <div className="actions">
        <button className="btn quiet" onClick={() => api().quit()}>Quit foolscap</button>
      </div>
    </div>
  );
}

/** While you were away: only what the journal shows happened. */
export function Away({ state }: { state: AppState }) {
  const a = state.away;
  if (!a) return null;
  const lines: string[] = [];
  if (a.green) lines.push(`${a.green} turn${a.green === 1 ? "" : "s"} finished green, checked by foolscap.`);
  if (a.queueSent) lines.push(`${a.queueSent} queued prompt${a.queueSent === 1 ? "" : "s"} went out, each after green tests.`);
  if (a.red) lines.push(`${a.red} went red: ${a.redNames.join(", ")}.`);
  if (a.held) lines.push(`${a.held} next prompt${a.held === 1 ? " is" : "s are"} held for you.`);
  if (a.errors) lines.push(`${a.errors} turn${a.errors === 1 ? "" : "s"} ended with an error.`);
  if (a.merged) lines.push(`${a.merged} merged.`);
  if (a.agentMs) lines.push(`${duration(a.agentMs)} of agent time.`);
  return (
    <div className="calm" style={{ borderBottom: "1px solid var(--line)" }}>
      <div className="section-head" style={{ padding: 0 }}>
        <h2>While you were away · {duration(a.minutes * 60_000)}</h2>
        <button className="btn quiet" style={{ height: 24 }} onClick={() => api().dismissDigest()}>Dismiss</button>
      </div>
      <ul className="queue" style={{ fontSize: 13, lineHeight: "19px", color: "var(--ink)" }}>
        {lines.map((line) => (
          <li key={line} style={{ display: "block" }}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function Footer({ state, onFull }: { state: AppState; onFull: () => void }) {
  const t = state.today;
  const parts = [];
  if (t.merged) parts.push(`${t.merged} merged`);
  if (t.green) parts.push(`${t.green} green`);
  if (t.agentMs) parts.push(`${duration(t.agentMs)} agent time`);
  return (
    <footer className="foot">
      <span>{parts.length ? `Today: ${parts.join(" · ")}` : "foolscap"}</span>
      <div className="right">
        <button className="btn quiet" style={{ height: 28, padding: "0 8px" }} onClick={onFull}>
          <Expand /> Full view <kbd>Ctrl⇧Space</kbd>
        </button>
      </div>
    </footer>
  );
}

export function Panel({ state, focus }: { state: AppState; focus: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const yours = yourMove(state.sessions);
  const theirs = agentsMove(state.sessions);

  // The window is as tall as what it shows.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => api().panelHeight(el.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A and D answer the first permission request; Escape puts the panel away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "Escape") return api().hidePanel();
      const asking = yours.find((s) => s.pendingPermission && s.pendingPermission.answer !== "text");
      if (!asking?.pendingPermission) return;
      const options = asking.pendingPermission.options;
      if (e.key === "a") api().answer(asking.id, options.find((o) => /allow/i.test(o.kind ?? o.optionId))?.optionId ?? "allow_once");
      if (e.key === "d") api().answer(asking.id, options.find((o) => /reject/i.test(o.kind ?? o.optionId))?.optionId ?? "reject_once");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [yours]);

  return (
    <div className="panel" ref={root}>
      <Header state={state} onSettings={() => setSettingsOpen(!settingsOpen)} />
      <div className="rule" />
      <Away state={state} />
      {yours.length ? (
        <>
          <div className="section-head">
            <h2>Your move</h2>
            {yours.some((s) => s.pendingPermission) && <span className="keys">A approve · D deny</span>}
          </div>
          <div className="cards">
            {yours.map((s, i) => (
              <Card key={s.id} s={s} focused={focus ? focus === s.id : i === 0} />
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
      <LicenceBanner licence={state.licence} />
      <Composer state={state} />
      {settingsOpen && <SettingsSheet settings={state.settings} licence={state.licence} hooks={state.hooks} />}
      <Footer state={state} onFull={() => api().openFull()} />
    </div>
  );
}
