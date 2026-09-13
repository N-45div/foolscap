export type TaskStatus = "backlog" | "ready" | "running" | "review" | "blocked" | "done";
export type TaskPriority = "P0" | "P1" | "P2";
export type SourceKind = "repository" | "document" | "decision" | "session";
export type NodeKind = "workspace" | "repository" | "service" | "module" | "document" | "task" | "agent";

export type WorkspaceSource = {
  id: string;
  label: string;
  kind: SourceKind;
  path: string;
  status: "indexed" | "syncing" | "stale";
  updatedAt: string;
  stats?: {
    files: number;
    nodes: number;
    relationships: number;
    truncated: boolean;
  };
};

export type WorkspaceNode = {
  id: string;
  label: string;
  kind: NodeKind;
  detail: string;
  x: number;
  y: number;
  sourceIds: string[];
};

export type WorkspaceEdge = {
  from: string;
  to: string;
  label: string;
};

export type TaskAttempt = {
  id: string;
  sessionId: string;
  agent: string;
  agentLabel: string;
  driver: string;
  model: string | null;
  status: "starting" | "idle" | "working" | "blocked" | "done" | "exited" | "error";
  stopReason?: string | null;
  evidence: {
    testsPassed: number;
    testsFailed: number;
    errors: number;
    edited: number;
  };
  outputTokens: number;
  costUsd?: number | null;
  routeDecisionId?: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  error: string | null;
};

export type WorkspaceTask = {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  agent: string;
  model: string;
  sourceIds: string[];
  nodeIds: string[];
  spentUsd: number;
  /** false when an attempt's agent never reported cost — spend is then a lower bound, not zero */
  spentKnown?: boolean;
  budgetUsd: number;
  progress: number;
  attempts?: TaskAttempt[];
  updatedAt: string;
};

export type WorkspaceAgent = {
  id: string;
  label: string;
  driver: string;
};

export type WorkspaceSearchHit = {
  type: "node" | "task" | "content";
  id: string;
  label: string;
  detail: string;
  kind: string;
  sourceId?: string;
};

export type RoutingPolicy = {
  mode: "balanced";
  defaultAgent: string;
  fallbackAgents: string[];
  autoAgents?: string[];
  maxConcurrent: number;
  maxPerAgent: number;
  budgetFloorUsd: number;
};

export type VoiceSessionRecord = {
  id: string;
  model: string;
  backendModel: string;
  startedAt: string;
  endedAt: string;
  usage: Record<string, unknown>;
};

export type CoordinationDecision = {
  id: string;
  taskId: string;
  agent: string;
  requested: string;
  reason: string;
  remainingBudgetUsd: number;
  activeSessions: number;
  createdAt: string;
};

export type RunEvent = {
  t: string;
  kind: "message" | "task" | "call" | "result" | "dispatch" | "blocked" | "evidence" | "question" | "answer" | "retry" | "error" | "done" | "cancelled" | string;
  text?: string;
  name?: string;
  args?: Record<string, unknown>;
  callId?: string;
  async?: boolean;
  summary?: string;
  taskId?: string;
  title?: string;
  agent?: string;
  sessionId?: string;
  reason?: string;
  testsPassed?: number;
  testsFailed?: number;
  errors?: number;
  edited?: number;
  attemptState?: string | null;
  status?: number;
  attempt?: number;
};

export type CoordinatorRun = {
  id: string;
  goal: string;
  status: "planning" | "working" | "needs-you" | "done" | "failed" | "cancelled" | "interrupted";
  model: string;
  budgetUsd: number;
  costUsd: number | null;
  usage: { input: number; cached: number; output: number };
  turns: number;
  taskIds: string[];
  question: { text: string; askedAt: string } | null;
  summary: string | null;
  error: string | null;
  events: RunEvent[];
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type WorkspaceState = {
  version?: number;
  id: string;
  name: string;
  description: string;
  root: string;
  sources: WorkspaceSource[];
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  tasks: WorkspaceTask[];
  routing?: RoutingPolicy;
  decisions?: CoordinationDecision[];
  voiceSessions?: VoiceSessionRecord[];
  runs?: CoordinatorRun[];
  updatedAt?: string;
};

/**
 * What the UI shows before the server answers. Deliberately empty: the
 * workspace is server state, and a sample here would be shown to every
 * first-time user as if it were theirs.
 */
export const emptyWorkspace = (): WorkspaceState => ({
  id: "",
  name: "",
  description: "",
  root: "",
  sources: [],
  nodes: [],
  edges: [],
  tasks: [],
  decisions: [],
  voiceSessions: [],
});

const API_HEADERS = { "content-type": "application/json", "x-foolscap": "workspace" };

async function workspaceResponse(response: Response): Promise<WorkspaceState> {
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error ?? `workspace: ${response.status}`);
  return value as WorkspaceState;
}

export async function fetchWorkspace(): Promise<WorkspaceState> {
  return workspaceResponse(await fetch("/api/workspace"));
}

export async function persistWorkspace(state: WorkspaceState): Promise<WorkspaceState> {
  return workspaceResponse(await fetch("/api/workspace", {
    method: "PUT",
    headers: API_HEADERS,
    body: JSON.stringify(state),
  }));
}

export async function indexWorkspaceSource(path: string): Promise<WorkspaceState> {
  return workspaceResponse(await fetch("/api/workspace/sources", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ path }),
  }));
}

export async function fetchWorkspaceAgents(): Promise<WorkspaceAgent[]> {
  const response = await fetch("/api/fleet/agents");
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error ?? `agents: ${response.status}`);
  return value as WorkspaceAgent[];
}

export async function searchWorkspaceKnowledge(query: string): Promise<WorkspaceSearchHit[]> {
  const response = await fetch(`/api/workspace/search?q=${encodeURIComponent(query)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error ?? `search: ${response.status}`);
  return result as WorkspaceSearchHit[];
}

export async function runWorkspaceTask(id: string, agent: string): Promise<WorkspaceState> {
  return workspaceResponse(await fetch(`/api/workspace/tasks/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ agent }),
  }));
}

export async function cancelWorkspaceTask(id: string): Promise<WorkspaceState> {
  return workspaceResponse(await fetch(`/api/workspace/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: API_HEADERS,
    body: "{}",
  }));
}

export async function dispatchWorkspaceTasks(limit = 10): Promise<WorkspaceState & { dispatch?: { launched: number; errors: Array<{ taskId: string; error: string }> } }> {
  return workspaceResponse(await fetch("/api/workspace/coordinator/dispatch", {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ limit }),
  })) as Promise<WorkspaceState & { dispatch?: { launched: number; errors: Array<{ taskId: string; error: string }> } }>;
}

const money = (value: number) => `$${value.toFixed(2)}`;

/** "$0.31 / $3.00", or "≥ $0.31 / $3.00" with a note when some agent didn't report. */
export function spendLabel(task: Pick<WorkspaceTask, "spentUsd" | "spentKnown" | "budgetUsd">): { text: string; note: string | null } {
  const unknown = task.spentKnown === false;
  const prefix = unknown && task.spentUsd > 0 ? "≥ " : "";
  return {
    text: `${prefix}${money(task.spentUsd)} / ${money(task.budgetUsd)}`,
    note: unknown ? "this agent doesn't report cost" : null,
  };
}

const COORDINATOR_HEADERS = { "content-type": "application/json", "x-foolscap": "coordinator" };

async function coordinatorResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error ?? `coordinator: ${response.status}`);
  return value as T;
}

export function fetchRuns(): Promise<{ runs: CoordinatorRun[]; model: string; ready: boolean }> {
  return fetch("/api/coordinator/runs").then((r) => coordinatorResponse(r));
}

export function startRun(goal: string, budgetUsd?: number): Promise<CoordinatorRun> {
  return fetch("/api/coordinator/runs", { method: "POST", headers: COORDINATOR_HEADERS, body: JSON.stringify({ goal, budgetUsd }) }).then((r) => coordinatorResponse(r));
}

export function answerRun(id: string, answer: string): Promise<CoordinatorRun> {
  return fetch(`/api/coordinator/runs/${encodeURIComponent(id)}/answer`, { method: "POST", headers: COORDINATOR_HEADERS, body: JSON.stringify({ answer }) }).then((r) => coordinatorResponse(r));
}

export function cancelRun(id: string): Promise<CoordinatorRun> {
  return fetch(`/api/coordinator/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: COORDINATOR_HEADERS, body: "{}" }).then((r) => coordinatorResponse(r));
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  running: "Running",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

export const NODE_COLORS: Record<NodeKind, string> = {
  workspace: "var(--brass-bright)",
  repository: "#e3b173",
  service: "var(--moss)",
  module: "#7aa6c2",
  document: "#b48bd4",
  task: "var(--oxide)",
  agent: "#d29c5c",
};
