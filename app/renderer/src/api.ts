/** The shapes the main process sends, and the bridge preload.cjs exposes. */

export type Verdict = "green" | "red" | "unknown";

export interface TestRun {
  verdict: Verdict;
  reason: string;
  counts: { total: number; passed: number; failed: number } | null;
  line?: string;
  source?: string;
  outputTail?: string;
}

export interface Session {
  id: string;
  name: string;
  agent: string;
  agentLabel: string;
  cwd: string;
  status: "starting" | "idle" | "working" | "blocked" | "checking" | "done" | "exited" | "error";
  stopReason: string | null;
  activity: { kind: string; text: string } | null;
  pendingPermission: {
    requestId: string;
    toolCall?: { title?: string; kind?: string };
    options: { optionId: string; name: string; kind?: string }[];
    answer?: "text";
  } | null;
  evidence: { testsPassed: number; testsFailed: number; errors: number; edited: number };
  verified: TestRun | null;
  validations: { key: string; command: string; verdict: Verdict; reason: string }[];
  queue: string[];
  held: { reason: string } | null;
  assistant: boolean;
  lastPrompt: string | null;
  lastReply: string | null;
  turns: number;
  startedAt: string;
  turnStartedAt: string | null;
  doneAt: string | null;
  blockedSince: string | null;
  error: string | null;
  attention: { tier: 0 | 1 | 2 | 3; reason: string; since: string | null };
}

export interface Agent {
  id: string;
  label: string;
  driver: string;
  assistant: boolean;
  available: boolean;
  status: "ready" | "unverified" | "setup";
  reason: string | null;
}

export interface Settings {
  repos: { path: string; name: string }[];
  defaultAgent: string;
  useMySettings: boolean;
  codexModel: string | null;
  openAtLogin: boolean;
  notify: boolean;
  theme: "system" | "dark" | "light";
  shortcut: string;
}

export interface Licence {
  gated: boolean;
  /** source: a build you made yourself, never gated. */
  plan: "source" | "trial" | "expired" | "app" | "app+voice";
  voice: boolean;
  trialDaysLeft: number | null;
  key: string | null;
  links: { app?: string | null; appVoice?: string | null; portal?: string | null };
  lastError: string | null;
  offline: boolean;
}

export interface AppState {
  sessions: Session[];
  agents: Agent[];
  settings: Settings;
  licence: Licence;
  counts: { needs: number; working: number };
  platform: string;
}

type Result<T = object> = Promise<({ ok: true } & T) | { error: string }>;

export interface Bridge {
  state(): Promise<AppState>;
  start(spec: { agent: string; cwd: string; prompt: string; queue?: string[] }): Result<{ session: Session }>;
  answer(id: string, optionId: string, text?: string): Result;
  prompt(id: string, text: string): Result;
  enqueue(id: string, text: string): Result;
  dequeue(id: string, index: number): Result;
  sendNext(id: string): Result;
  cancel(id: string): Result;
  close(id: string): Result;
  seen(id: string, turns: number): Result;
  openFolder(id: string): Result;
  pickRepo(): Result<{ picked: string | null }>;
  setSettings(patch: Partial<Settings>): Result;
  refreshAgents(): Result;
  activateKey(key: string): Result<{ licence: Licence }>;
  deactivateKey(): Result<{ licence: Licence }>;
  checkKey(): Result<{ licence: Licence }>;
  openLink(which: "app" | "appVoice" | "portal"): Result;
  panelHeight(height: number): void;
  openFull(focusId?: string): void;
  hidePanel(): void;
  quit(): void;
  onState(fn: (state: AppState) => void): () => void;
  onFocus(fn: (id: string) => void): () => void;
}

declare global {
  interface Window {
    foolscap: Bridge;
  }
}

export const api = (): Bridge => window.foolscap;

/** "12s", "4m", "2h", "3d": how long ago, short. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** The folder's own name, for a row's meta line. */
export const folderName = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;
