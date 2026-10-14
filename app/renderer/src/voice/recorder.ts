/**
 * One dictation, from the click on the mic to the prompt text.
 *
 * Audio is captured at 16 kHz mono and cut into parts at natural pauses
 * (or every 25 s), and each part is uploaded as soon as it is cut, so
 * most of the transcribing is done by the time you stop talking. On stop
 * the last part goes up, the parts' transcripts are joined in order, and
 * foolscap Cloud writes them up as a clean prompt.
 *
 * Nothing here knows where the audio goes: the transport (the main
 * process, over IPC) does. Audio never touches the disk.
 */

export interface VoiceTransport {
  start(): Promise<{ id: string; maxSeconds: number }>;
  part(id: string, index: number, wav: ArrayBuffer): Promise<{ transcript: string; seconds: number; alternates?: string[] }>;
  finish(id: string, body: { transcript: string; audioSeconds: number; alternates?: string[] }): Promise<{ text: string; words: number }>;
}

export type RecorderState = "starting" | "recording" | "finishing" | "done" | "failed" | "cancelled";

const RATE = 16_000;
const WINDOW = RATE / 10; // 100 ms
const SILENCE_LEVEL = 0.012;
const PAUSE_WINDOWS = 7; // 700 ms of quiet ends a part…
const MIN_PART_SECONDS = 4; // …once it is at least this long
const MAX_PART_SECONDS = 25;
const MAX_PARTS = 12;

/** A WAV file (16-bit PCM, mono) around the samples. */
export function encodeWav(samples: Int16Array, rate = RATE): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  new Int16Array(buf, 44).set(samples);
  return buf;
}

export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private session: Promise<{ id: string; maxSeconds: number }> | null = null;
  private current: Int16Array[] = [];
  private currentLength = 0;
  private window: number[] = [];
  private quietWindows = 0;
  private index = 0;
  private totalSamples = 0;
  private uploads: Promise<void>[] = [];
  private transcripts: string[] = [];
  private alternates: string[][] = [];
  private stopped = false;

  constructor(
    private transport: VoiceTransport,
    private handlers: { onState?: (state: RecorderState) => void; onLevel?: (level: number) => void; onPartial?: (text: string) => void } = {},
  ) {}

  async start() {
    this.handlers.onState?.("starting");
    this.session = this.transport.start();
    this.session.catch(() => {}); // surfaced again by stop()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext({ sampleRate: RATE });
    await this.context.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url).href);
    const source = this.context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.context, "foolscap-capture");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => this.push(event.data);
    source.connect(node);
    // A worklet with nothing downstream may never run: feed a silent gain.
    const mute = this.context.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.context.destination);
    this.handlers.onState?.("recording");
  }

  private push(block: Float32Array) {
    if (this.stopped) return;
    const pcm = new Int16Array(block.length);
    for (let i = 0; i < block.length; i++) {
      const v = Math.max(-1, Math.min(1, block[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.window.push(v);
    }
    this.current.push(pcm);
    this.currentLength += pcm.length;
    this.totalSamples += pcm.length;
    while (this.window.length >= WINDOW) {
      const w = this.window.splice(0, WINDOW);
      const level = Math.sqrt(w.reduce((sum, v) => sum + v * v, 0) / w.length);
      this.handlers.onLevel?.(Math.min(1, level * 8));
      this.quietWindows = level < SILENCE_LEVEL ? this.quietWindows + 1 : 0;
    }
    const seconds = this.currentLength / RATE;
    const lastAllowed = this.index >= MAX_PARTS - 1;
    if (!lastAllowed && (seconds >= MAX_PART_SECONDS || (seconds >= MIN_PART_SECONDS && this.quietWindows >= PAUSE_WINDOWS))) {
      this.cut();
    }
  }

  /** Close the current part and upload it. */
  private cut() {
    if (!this.currentLength) return;
    const samples = new Int16Array(this.currentLength);
    let offset = 0;
    for (const chunk of this.current) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.current = [];
    this.currentLength = 0;
    this.quietWindows = 0;
    const index = this.index++;
    const wav = encodeWav(samples);
    this.uploads.push(this.upload(index, wav));
  }

  private async upload(index: number, wav: ArrayBuffer, attempt = 0): Promise<void> {
    const { id } = await this.session!;
    try {
      const result = await this.transport.part(id, index, wav);
      this.transcripts[index] = result.transcript;
      if (result.alternates) this.alternates[index] = result.alternates;
      this.handlers.onPartial?.(this.transcripts.filter(Boolean).join(" "));
    } catch (err) {
      if (attempt < 2) return this.upload(index, wav, attempt + 1);
      throw err;
    }
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
  }

  /** Stop recording; resolves with the prompt text. */
  async stop(): Promise<{ text: string; words: number }> {
    if (this.stopped) throw new Error("already stopped");
    this.stopped = true;
    this.handlers.onState?.("finishing");
    this.release();
    // Keep a trailing part only if it holds more than a breath.
    if (this.currentLength > RATE * 0.3) this.cut();
    try {
      const { id } = await this.session!;
      await Promise.all(this.uploads);
      const transcript = this.transcripts.filter(Boolean).join(" ").trim();
      if (!transcript) throw new Error("Nothing was heard. Check the microphone and try again.");
      const columns = Math.max(0, ...this.alternates.map((a) => a?.length ?? 0));
      const alternates = Array.from({ length: columns }, (_, k) => this.alternates.map((a) => a?.[k] ?? "").join(" ").trim());
      const done = await this.transport.finish(id, {
        transcript,
        audioSeconds: Math.round((this.totalSamples / RATE) * 10) / 10,
        ...(alternates.length ? { alternates } : {}),
      });
      this.handlers.onState?.("done");
      return done;
    } catch (err) {
      this.handlers.onState?.("failed");
      throw err;
    }
  }

  cancel() {
    this.stopped = true;
    this.release();
    this.handlers.onState?.("cancelled");
  }
}
