/** The mic: click to talk, click again to get the prompt. */
import { useEffect, useRef, useState } from "react";
import { api, type AppState } from "../api";
import { Mic } from "../icons";
import { Recorder, type RecorderState, type VoiceTransport } from "./recorder";

function unwrap<T>(result: ({ ok: true } & T) | { error: string }): T {
  if ("error" in result) throw new Error(result.error);
  return result;
}

const transport: VoiceTransport = {
  start: async () => unwrap(await api().voiceStart()).session,
  part: async (id, index, wav) => unwrap(await api().voicePart(id, index, wav)).part,
  finish: async (id, body) => unwrap(await api().voiceFinish(id, body)).result,
};

export function MicButton({ voice, onText, onPartial }: { voice: AppState["voice"]; onText: (text: string) => void; onPartial?: (text: string) => void }) {
  const recorder = useRef<Recorder | null>(null);
  const [state, setState] = useState<RecorderState | "idle">("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => recorder.current?.cancel(), []);

  const busy = state === "starting" || state === "finishing";
  const recording = state === "recording";

  const toggle = async () => {
    setError(null);
    if (recording) {
      try {
        const { text } = await recorder.current!.stop();
        onText(text);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        recorder.current = null;
        setState("idle");
        setLevel(0);
        onPartial?.("");
      }
      return;
    }
    const r = new Recorder(transport, { onState: setState, onLevel: setLevel, onPartial });
    recorder.current = r;
    try {
      await r.start();
    } catch (err) {
      r.cancel();
      recorder.current = null;
      setState("idle");
      const message = (err as Error).message;
      setError(/denied|NotAllowed/i.test(message) ? "Microphone access is off. Allow it in your system's privacy settings." : message);
    }
  };

  const label = !voice.available
    ? (voice.reason ?? "Voice is not available")
    : recording ? "Stop and write the prompt" : busy ? "Working…" : "Talk instead of typing";

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        type="button"
        className="square"
        disabled={!voice.available || busy}
        title={label}
        aria-label={label}
        aria-pressed={recording}
        onClick={toggle}
        style={recording ? { borderColor: "var(--accent)", boxShadow: `0 0 0 ${1 + Math.round(level * 4)}px var(--accent)` } : undefined}
      >
        {recording ? (
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="1" width="10" height="10" rx="2" fill="var(--accent)" />
          </svg>
        ) : (
          <Mic />
        )}
      </button>
      {error && <span className="error" style={{ maxWidth: 220, textAlign: "right" }}>{error}</span>}
    </span>
  );
}
