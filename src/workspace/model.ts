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
  costUsd?: number;
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
  updatedAt?: string;
};

const now = "2026-09-12T09:30:00.000Z";

export const seedWorkspace = (): WorkspaceState => ({
  id: "spatialize",
  name: "Spatialize",
  description: "The operating map for your code, decisions, and delegated work.",
  root: "C:/Users/DivijN/Spatialize",
  sources: [
    { id: "src-repo", label: "Spatialize repository", kind: "repository", path: "C:/Users/DivijN/Spatialize", status: "indexed", updatedAt: now },
    { id: "foolscap-repo", label: "foolscap repository", kind: "repository", path: "C:/Users/DivijN/foolscap", status: "indexed", updatedAt: now },
    { id: "architecture", label: "ARCHITECTURE.md", kind: "document", path: "C:/Users/DivijN/Spatialize/ARCHITECTURE.md", status: "indexed", updatedAt: now },
    { id: "agent-history", label: "Agent session archive", kind: "session", path: "~/.foolscap/acp", status: "indexed", updatedAt: now },
  ],
  nodes: [
    { id: "workspace", label: "Spatialize", kind: "workspace", detail: "Product workspace", x: 420, y: 190, sourceIds: ["src-repo", "architecture"] },
    { id: "fleet", label: "Agent fleet", kind: "service", detail: "ACP session coordination", x: 180, y: 90, sourceIds: ["foolscap-repo"] },
    { id: "knowledge", label: "Knowledge layer", kind: "service", detail: "Source and relationship index", x: 650, y: 90, sourceIds: ["architecture", "agent-history"] },
    { id: "tasks", label: "Task state", kind: "module", detail: "Durable plan and attempts", x: 180, y: 300, sourceIds: ["foolscap-repo"] },
    { id: "voice", label: "Voice control", kind: "module", detail: "GPT-Live conversation", x: 650, y: 300, sourceIds: ["architecture"] },
    { id: "milestone", label: "Milestone 1", kind: "task", detail: "Workspace foundation", x: 420, y: 390, sourceIds: ["agent-history"] },
  ],
  edges: [
    { from: "workspace", to: "fleet", label: "coordinates" },
    { from: "workspace", to: "knowledge", label: "understands" },
    { from: "workspace", to: "tasks", label: "tracks" },
    { from: "workspace", to: "voice", label: "controls" },
    { from: "tasks", to: "milestone", label: "contains" },
    { from: "knowledge", to: "milestone", label: "informs" },
    { from: "voice", to: "milestone", label: "updates" },
  ],
  tasks: [
    { id: "task-context", title: "Index repository context", detail: "Build the first source map from code and architecture notes.", status: "done", priority: "P1", agent: "codex", model: "gpt-5.3-codex", sourceIds: ["src-repo", "architecture"], nodeIds: ["knowledge"], spentUsd: 1.24, budgetUsd: 3, progress: 100, updatedAt: now },
    { id: "task-board", title: "Workspace foundation", detail: "Connect tasks, sources, agents, and graph entities in one surface.", status: "running", priority: "P0", agent: "claude code", model: "claude-sonnet", sourceIds: ["foolscap-repo", "agent-history"], nodeIds: ["tasks", "milestone"], spentUsd: 0.82, budgetUsd: 4, progress: 62, updatedAt: now },
    { id: "task-review", title: "Review coordination contract", detail: "Check the runner boundary before adding hosted execution.", status: "review", priority: "P1", agent: "gemini", model: "gemini-2.5-pro", sourceIds: ["foolscap-repo"], nodeIds: ["fleet"], spentUsd: 0.44, budgetUsd: 2, progress: 85, updatedAt: now },
    { id: "task-voice", title: "Voice handoff prototype", detail: "Route a spoken request to a bounded task plan.", status: "ready", priority: "P1", agent: "unassigned", model: "—", sourceIds: ["architecture"], nodeIds: ["voice"], spentUsd: 0, budgetUsd: 5, progress: 0, updatedAt: now },
    { id: "task-cloud", title: "Hosted runner spike", detail: "Define tenant isolation and metering boundaries.", status: "backlog", priority: "P2", agent: "unassigned", model: "—", sourceIds: ["foolscap-repo"], nodeIds: ["fleet"], spentUsd: 0, budgetUsd: 8, progress: 0, updatedAt: now },
  ],
});

const STORAGE_KEY = "foolscap.workspace.v1";

export function loadWorkspace(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as WorkspaceState;
  } catch {
    // Private browsing or an older schema falls back to a useful workspace.
  }
  return seedWorkspace();
}

export function saveWorkspace(state: WorkspaceState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The UI remains usable when persistence is unavailable.
  }
}

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
