import { useEffect, useState } from "react";
import { api, type AppState } from "./api";
import { Full } from "./Full";
import { Panel } from "./Panel";
import { Pill } from "./Pill";

const asked = new URLSearchParams(location.search).get("view");
const view = asked === "full" || asked === "pill" ? asked : "panel";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    api().state().then(setState);
    const offState = api().onState(setState);
    const offFocus = api().onFocus(setFocus);
    return () => {
      offState();
      offFocus();
    };
  }, []);

  // "system" follows the OS; the others pin a theme.
  const theme = state?.settings.theme ?? "system";
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.body.classList.add(`view-${view}`);
  }, []);

  if (!state) return null;
  if (view === "pill") return <Pill state={state} />;
  return view === "full" ? <Full state={state} focus={focus} setFocus={setFocus} /> : <Panel state={state} focus={focus} />;
}
