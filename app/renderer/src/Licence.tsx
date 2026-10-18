/** The trial, the key, and where to get one. Shown only on official builds. */
import { useState } from "react";
import { api, type Licence } from "./api";

const PLAN_NAME: Record<Licence["plan"], string> = {
  source: "Built from source",
  trial: "Free trial",
  expired: "Trial ended",
  app: "foolscap, lifetime",
  "app+voice": "foolscap + Voice, lifetime",
  voice: "foolscap Voice subscription",
};

/** Paste a key, activate it on this computer. */
function KeyForm({ onDone }: { onDone?: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="inline"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const result = await api().activateKey(key);
        setBusy(false);
        if ("error" in result) return setError(result.error);
        setError(null);
        setKey("");
        onDone?.();
      }}
    >
      <label className="sr-only" htmlFor="licence-key">Licence key</label>
      <input id="licence-key" value={key} placeholder="Paste your licence key" onChange={(e) => setKey(e.target.value)} />
      <button className="btn" type="submit" disabled={!key.trim() || busy}>{busy ? "Checking…" : "Activate"}</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function BuyButtons({ licence }: { licence: Licence }) {
  return (
    <div className="actions">
      {licence.links.app && (
        <button className="btn primary" onClick={() => api().openLink("app")}>Get foolscap</button>
      )}
      {licence.links.appVoice && (
        <button className="btn" onClick={() => api().openLink("appVoice")}>foolscap + Voice</button>
      )}
    </div>
  );
}

/** In the panel: loud when the trial is over, a quiet line near its end, nothing otherwise. */
export function LicenceBanner({ licence }: { licence: Licence }) {
  const [entering, setEntering] = useState(false);
  if (licence.plan === "expired") {
    return (
      <div className="calm" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="big">Your free trial has ended</p>
        <p>
          Tasks already running will finish. To start new ones, get foolscap: once, for good. The first 50 early
          buyers pay $9.
        </p>
        <BuyButtons licence={licence} />
        {entering ? (
          <KeyForm onDone={() => setEntering(false)} />
        ) : (
          <button className="btn quiet" style={{ alignSelf: "flex-start" }} onClick={() => setEntering(true)}>
            I have a key
          </button>
        )}
      </div>
    );
  }
  if (licence.plan === "trial" && (licence.trialDaysLeft ?? 99) <= 3) {
    return (
      <div className="foot" style={{ borderTop: "1px solid var(--line)" }}>
        <span>
          Trial: {licence.trialDaysLeft} day{licence.trialDaysLeft === 1 ? "" : "s"} left
        </span>
        {licence.links.app && (
          <button className="btn quiet" style={{ height: 28 }} onClick={() => api().openLink("app")}>Get foolscap</button>
        )}
      </div>
    );
  }
  return null;
}

/** In Settings: what this computer has, and how to change it. */
export function LicenceSettings({ licence }: { licence: Licence }) {
  if (!licence.gated) {
    return (
      <div className="row" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Licence</span>
        <span className="hint">Built from source: no key needed</span>
      </div>
    );
  }
  const owned = licence.plan === "app" || licence.plan === "app+voice" || licence.plan === "voice";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span>Licence</span>
        <span className="hint">
          {PLAN_NAME[licence.plan]}
          {licence.plan === "trial" ? ` · ${licence.trialDaysLeft} days left` : ""}
          {licence.key ? ` · key ${licence.key}` : ""}
          {licence.offline ? " · offline" : ""}
        </span>
      </div>
      {licence.lastError && <span className="error">{licence.lastError}</span>}
      {owned ? (
        <div className="actions">
          {licence.plan === "app" && licence.links.appVoice && (
            <button className="btn" onClick={() => api().openLink("appVoice")}>Get foolscap + Voice</button>
          )}
          {licence.links.portal && (
            <button className="btn quiet" onClick={() => api().openLink("portal")}>Manage your licence</button>
          )}
          <button className="btn quiet" onClick={() => api().deactivateKey()}>Remove from this computer</button>
        </div>
      ) : (
        <>
          <BuyButtons licence={licence} />
          <KeyForm />
        </>
      )}
    </div>
  );
}
