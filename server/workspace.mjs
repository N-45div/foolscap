/**
 * Durable workspace state and a deliberately small local knowledge index.
 *
 * The graph is source-backed: every node records which connected source
 * produced it. Indexing is bounded and ignores generated/vendor directories,
 * so connecting a repository cannot accidentally turn the UI into a file dump.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

const IGNORED = new Set([
  ".git", ".hg", ".svn", ".foolscap", "node_modules", "dist", "build",
  ".next", ".nuxt", "coverage", "vendor", "target", "__pycache__", ".venv",
]);
const INDEXED_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".yaml", ".yml",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php",
]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_BYTES_PER_FILE = 32 * 1024;
const SEARCH_CACHE = new Map();
const DEFAULT_ROUTING = {
  mode: "balanced",
  // Native Claude Code first: it's the one driver verified end to end on
  // the real binary, and the only one that reports cost.
  defaultAgent: "claude",
  fallbackAgents: ["codex", "opencode"],
  // "auto" only ever picks from these. Devin (cloud, billed) and the
  // unverified drivers (Warp, Antigravity) run only when named.
  autoAgents: ["claude", "codex", "opencode", "claude-acp"],
  maxConcurrent: 3,
  maxPerAgent: 2,
  budgetFloorUsd: 0.25,
};

export const workspaceFile = () =>
  process.env.FOOLSCAP_WORKSPACE_FILE || join(homedir(), ".foolscap", "workspace.json");

const slash = (value) => String(value).replaceAll("\\", "/");
const idFor = (prefix, value) =>
  `${prefix}-${createHash("sha1").update(String(value).toLowerCase()).digest("hex").slice(0, 12)}`;

function layout(nodes) {
  const root = nodes[0];
  if (root) {
    root.x = 420;
    root.y = 250;
  }
  const rest = nodes.slice(1);
  rest.forEach((node, index) => {
    const ring = Math.floor(index / 36);
    const inRing = index % 36;
    const count = Math.min(36, rest.length - ring * 36);
    const angle = (inRing / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
    const radius = 145 + ring * 82;
    node.x = Math.round(420 + Math.cos(angle) * radius);
    node.y = Math.round(250 + Math.sin(angle) * radius);
  });
}

export function defaultWorkspace(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const name = basename(absoluteRoot) || "Workspace";
  return {
    version: 3,
    id: idFor("workspace", absoluteRoot),
    name,
    description: "Tasks, and the agents that run them.",
    root: absoluteRoot,
    sources: [],
    nodes: [{
      id: "workspace",
      label: name,
      kind: "workspace",
      detail: "Local workspace",
      x: 420,
      y: 250,
      sourceIds: [],
    }],
    edges: [],
    tasks: [],
    routing: { ...DEFAULT_ROUTING },
    decisions: [],
    voiceSessions: [],
    updatedAt: new Date().toISOString(),
  };
}

function validState(value) {
  return value && typeof value === "object" && typeof value.id === "string" &&
    Array.isArray(value.sources) && Array.isArray(value.nodes) &&
    Array.isArray(value.edges) && Array.isArray(value.tasks);
}

export async function readWorkspace(file = workspaceFile(), root = process.cwd()) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return validState(value) ? {
      ...value,
      routing: { ...DEFAULT_ROUTING, ...(value.routing ?? {}) },
      decisions: Array.isArray(value.decisions) ? value.decisions : [],
      voiceSessions: Array.isArray(value.voiceSessions) ? value.voiceSessions : [],
    } : defaultWorkspace(root);
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return defaultWorkspace(root);
    throw err;
  }
}

export async function writeWorkspace(state, file = workspaceFile()) {
  if (!validState(state)) throw new Error("invalid workspace state");
  await mkdir(dirname(file), { recursive: true });
  const next = {
    ...state,
    version: 3,
    routing: { ...DEFAULT_ROUTING, ...(state.routing ?? {}) },
    decisions: Array.isArray(state.decisions) ? state.decisions.slice(0, 200) : [],
    voiceSessions: Array.isArray(state.voiceSessions) ? state.voiceSessions.slice(0, 100) : [],
    updatedAt: new Date().toISOString(),
  };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(temp, file);
  return next;
}

async function walk(root) {
  const files = [];
  const visit = async (dir) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const info = await stat(full).catch(() => null);
        if (info && info.size <= MAX_FILE_BYTES) files.push({ full, bytes: info.size });
      }
    }
  };
  await visit(root);
  return files;
}

function references(text, extension) {
  const found = [];
  const add = (kind, target) => {
    const clean = target.trim().split("#")[0].split("?")[0];
    if (clean && !clean.startsWith("http:") && !clean.startsWith("https:")) found.push({ kind, target: clean });
  };

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add("links to", match[1]);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) add("links to", match[1]);
  }
  for (const match of text.matchAll(/(?:from\s+|import\s*\(?|require\s*\()\s*["']([^"']+)["']/g)) add("imports", match[1]);
  if (extension === ".py") {
    for (const match of text.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) add("imports", match[1].replaceAll(".", "/"));
  }
  return found;
}

function resolveReference(fromRelative, target, known) {
  let base;
  if (target.startsWith(".")) base = slash(join(dirname(fromRelative), target));
  else base = slash(target);
  base = base.replace(/^\.\//, "");
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".md", ".mdx"].map((ext) => base + ext),
    ...["index.ts", "index.tsx", "index.js", "index.py", "README.md"].map((name) => `${base}/${name}`),
  ];
  for (const candidate of candidates) {
    const normalized = slash(candidate).replace(/(^|\/)\.\//g, "$1").toLowerCase();
    if (known.has(normalized)) return known.get(normalized);
  }
  const name = basename(base).toLowerCase();
  return [...known.entries()].find(([path]) => basename(path, extname(path)).toLowerCase() === name)?.[1] ?? null;
}

export async function indexSource(state, path, label) {
  const absolute = resolve(String(path || ""));
  const info = await stat(absolute).catch(() => null);
  if (!info?.isDirectory()) throw new Error("source path must be an existing directory");

  const sourceId = idFor("source", absolute);
  const sourceNodeId = idFor("repo", absolute);
  const files = await walk(absolute);
  const now = new Date().toISOString();
  const previousSource = state.sources.find((source) => source.id === sourceId);
  const previousNodeIds = new Set(state.nodes.filter((node) => node.sourceIds?.includes(sourceId)).map((node) => node.id));
  const keptNodes = state.nodes.filter((node) => !previousNodeIds.has(node.id));
  const keptEdges = state.edges.filter((edge) => !previousNodeIds.has(edge.from) && !previousNodeIds.has(edge.to));
  const nodes = [{
    id: sourceNodeId,
    label: label?.trim() || basename(absolute),
    kind: "repository",
    detail: `${files.length} indexed files`,
    x: 0,
    y: 0,
    sourceIds: [sourceId],
  }];
  const edges = [{ from: "workspace", to: sourceNodeId, label: "contains" }];
  const known = new Map();
  const contents = new Map();

  for (const file of files) {
    const rel = slash(relative(absolute, file.full));
    const nodeId = idFor("file", `${absolute}:${rel}`);
    const extension = extname(rel).toLowerCase();
    known.set(rel.toLowerCase(), nodeId);
    nodes.push({
      id: nodeId,
      label: basename(rel),
      kind: DOCUMENT_EXTENSIONS.has(extension) ? "document" : "module",
      detail: rel,
      x: 0,
      y: 0,
      sourceIds: [sourceId],
    });
    edges.push({ from: sourceNodeId, to: nodeId, label: "contains" });
    const text = await readFile(file.full, "utf8").catch(() => "");
    contents.set(rel, { text, extension, nodeId });
  }

  const seenEdges = new Set(edges.map((edge) => `${edge.from}:${edge.to}:${edge.label}`));
  for (const [rel, entry] of contents) {
    for (const ref of references(entry.text, entry.extension)) {
      const targetId = resolveReference(rel, ref.target, known);
      const key = `${entry.nodeId}:${targetId}:${ref.kind}`;
      if (!targetId || targetId === entry.nodeId || seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from: entry.nodeId, to: targetId, label: ref.kind });
    }
  }

  const source = {
    id: sourceId,
    label: label?.trim() || basename(absolute),
    kind: "repository",
    path: absolute,
    status: "indexed",
    updatedAt: now,
    stats: {
      files: files.length,
      nodes: nodes.length,
      relationships: edges.length,
      truncated: files.length >= MAX_FILES,
    },
  };
  SEARCH_CACHE.set(sourceId, {
    updatedAt: now,
    entries: [...contents.entries()].map(([rel, entry]) => ({
      nodeId: entry.nodeId,
      path: rel,
      text: entry.text.slice(0, MAX_SEARCH_BYTES_PER_FILE),
    })),
  });
  const sources = state.sources.filter((item) => item.id !== sourceId).concat(source);
  const allNodes = keptNodes.concat(nodes);
  layout(allNodes);
  return {
    ...state,
    root: state.root || absolute,
    sources,
    nodes: allNodes,
    edges: keptEdges.concat(edges),
    updatedAt: now,
    lastIndexedSource: previousSource ? sourceId : undefined,
  };
}

/**
 * Spend is the sum of what agents *reported*. Claude Code reports cost
 * natively; ACP agents, Devin and command agents do not, so their
 * attempts carry `costUsd: null` and the task is marked `spentKnown:
 * false` rather than pretending the work was free.
 */
export function spendOf(attempts = []) {
  const reported = attempts.filter((attempt) => typeof attempt.costUsd === "number");
  return {
    spentUsd: reported.reduce((sum, attempt) => sum + attempt.costUsd, 0),
    spentKnown: reported.length === attempts.length,
  };
}

export function createTask(state, input) {
  const title = String(input?.title ?? "").trim();
  if (!title) throw new Error("task title is required");
  const id = `task-${randomUUID()}`;
  const task = {
    id,
    title,
    detail: String(input?.detail ?? "New task captured in the workspace."),
    status: "backlog",
    priority: ["P0", "P1", "P2"].includes(input?.priority) ? input.priority : "P1",
    agent: "unassigned",
    model: "—",
    sourceIds: Array.isArray(input?.sourceIds) ? input.sourceIds : [],
    nodeIds: [],
    spentUsd: 0,
    spentKnown: true,
    budgetUsd: Number.isFinite(input?.budgetUsd) ? Math.max(0, input.budgetUsd) : 3,
    progress: 0,
    attempts: [],
    updatedAt: new Date().toISOString(),
  };
  const node = {
    id,
    label: title,
    kind: "task",
    detail: task.detail,
    x: 420,
    y: 400,
    sourceIds: task.sourceIds,
  };
  return { ...state, tasks: [task, ...state.tasks], nodes: [...state.nodes, node], edges: [...state.edges, { from: "workspace", to: id, label: "tracks" }] };
}

export function taskPrompt(state, task) {
  const sources = task.sourceIds
    .map((id) => state.sources.find((source) => source.id === id))
    .filter(Boolean);
  const nodes = task.nodeIds
    .map((id) => state.nodes.find((node) => node.id === id))
    .filter(Boolean);
  const sourceLines = (sources.length ? sources : state.sources.slice(0, 8))
    .map((source) => `- ${source.label}: ${source.path}`);
  const nodeLines = nodes.map((node) => `- ${node.kind}: ${node.label} (${node.detail})`);
  const remaining = Math.max(0, Number(task.budgetUsd || 0) - Number(task.spentUsd || 0));
  return [
    `Complete this workspace task: ${task.title}`,
    "",
    task.detail,
    "",
    `Workspace root: ${state.root}`,
    `Priority: ${task.priority}`,
    `Remaining task budget: $${remaining.toFixed(2)}${task.spentKnown === false ? " (earlier spend was not reported by the agent)" : ""}`,
    sourceLines.length ? `Connected sources:\n${sourceLines.join("\n")}` : "Connected sources: none",
    nodeLines.length ? `Relevant graph context:\n${nodeLines.join("\n")}` : "Relevant graph context: none attached",
    "",
    "Work autonomously inside the workspace. Inspect the relevant code before editing, keep the change bounded to this task, run the relevant validation, and report the changed files and evidence when finished.",
  ].join("\n");
}

export function chooseAgent(state, task, requested, snapshots, availableAgents) {
  const routing = { ...DEFAULT_ROUTING, ...(state.routing ?? {}) };
  const remaining = Number(task.budgetUsd || 0) - Number(task.spentUsd || 0);
  if (remaining < routing.budgetFloorUsd) throw new Error(`task needs at least $${routing.budgetFloorUsd.toFixed(2)} of remaining budget`);
  const active = snapshots.filter((snapshot) => ["starting", "idle", "working", "blocked"].includes(snapshot.status));
  if (active.length >= routing.maxConcurrent) throw new Error(`coordinator capacity reached (${routing.maxConcurrent} active tasks)`);
  const available = new Set(availableAgents);
  const explicit = requested && requested !== "auto" ? String(requested) : null;
  if (explicit && !available.has(explicit)) throw new Error("requested agent is not available");
  const counts = new Map();
  for (const snapshot of active) counts.set(snapshot.agent, (counts.get(snapshot.agent) ?? 0) + 1);
  const auto = new Set(routing.autoAgents ?? []);
  const candidates = explicit ? [explicit] : [
    task.agent,
    routing.defaultAgent,
    ...(routing.fallbackAgents ?? []),
    ...auto,
  ].filter((agent, index, all) => agent && available.has(agent) && auto.has(agent) && all.indexOf(agent) === index);
  const agent = candidates
    .filter((candidate) => (counts.get(candidate) ?? 0) < routing.maxPerAgent)
    .sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0))[0];
  if (!agent) throw new Error(explicit ? `${explicit} is at its per-agent limit (${routing.maxPerAgent})` : `every auto-routable agent is at its per-agent limit (${routing.maxPerAgent})`);
  const load = counts.get(agent) ?? 0;
  return {
    id: `decision-${randomUUID()}`,
    taskId: task.id,
    agent,
    requested: explicit ?? "auto",
    reason: (explicit ? `explicit agent selection; ${load} active on ${agent}` : `balanced route; ${load} active on ${agent}; $${remaining.toFixed(2)} remaining`) +
      (task.spentKnown === false ? "; earlier spend not reported" : ""),
    remainingBudgetUsd: remaining,
    activeSessions: active.length,
    createdAt: new Date().toISOString(),
  };
}

export function attachTaskAttempt(state, id, snapshot, decision) {
  let found = false;
  const now = new Date().toISOString();
  const tasks = state.tasks.map((task) => {
    if (task.id !== id) return task;
    found = true;
    const remaining = Number(task.budgetUsd || 0) - Number(task.spentUsd || 0);
    if (remaining <= 0) throw new Error("task budget is exhausted");
    const attempt = {
      id: `attempt-${randomUUID()}`,
      sessionId: snapshot.id,
      agent: snapshot.agent,
      agentLabel: snapshot.agentLabel,
      driver: snapshot.driver,
      model: snapshot.model ?? null,
      status: snapshot.status,
      stopReason: snapshot.stopReason ?? null,
      evidence: snapshot.evidence ?? { testsPassed: 0, testsFailed: 0, errors: 0, edited: 0 },
      outputTokens: snapshot.outputTokens ?? 0,
      costUsd: typeof snapshot.costUsd === "number" ? snapshot.costUsd : null,
      routeDecisionId: decision?.id ?? null,
      startedAt: snapshot.startedAt ?? now,
      updatedAt: now,
      endedAt: null,
      error: snapshot.error ?? null,
    };
    return {
      ...task,
      status: "running",
      progress: Math.max(5, task.progress),
      agent: snapshot.agent,
      model: snapshot.model ?? snapshot.agentLabel ?? "detecting…",
      attempts: [...(task.attempts ?? []), attempt],
      updatedAt: now,
    };
  });
  if (!found) throw new Error("task not found");
  return { ...state, tasks, decisions: decision ? [decision, ...(state.decisions ?? [])].slice(0, 200) : state.decisions, updatedAt: now };
}

const ACTIVE_ATTEMPT = new Set(["starting", "idle", "working", "blocked"]);

/** Project live fleet evidence back onto durable Kanban state. */
export function reconcileWorkspace(state, snapshots) {
  const sessions = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  let changed = false;
  const tasks = state.tasks.map((task) => {
    const attempts = task.attempts ?? [];
    const current = attempts.at(-1);
    if (!current || !ACTIVE_ATTEMPT.has(current.status)) return task;
    const snapshot = sessions.get(current.sessionId);
    const now = new Date().toISOString();
    if (!snapshot) {
      changed = true;
      const failed = { ...current, status: "error", error: "agent session is no longer active", endedAt: now, updatedAt: now };
      return { ...task, status: "blocked", attempts: [...attempts.slice(0, -1), failed], updatedAt: now };
    }

    const evidence = snapshot.evidence ?? current.evidence;
    const cancelled = snapshot.status === "done" && snapshot.stopReason === "cancelled";
    const failed = snapshot.status === "error" || snapshot.status === "exited" ||
      (snapshot.status === "done" && (evidence?.testsFailed > 0 || evidence?.errors > 0));
    const taskStatus = cancelled ? "ready" : snapshot.status === "blocked" || failed ? "blocked" :
      snapshot.status === "done" ? "review" : "running";
    const progress = cancelled ? task.progress : snapshot.status === "done" ? Math.max(85, task.progress) :
      snapshot.status === "working" ? Math.max(35, task.progress) : task.progress;
    const nextAttempt = {
      ...current,
      agent: snapshot.agent,
      agentLabel: snapshot.agentLabel,
      driver: snapshot.driver,
      model: snapshot.model ?? current.model,
      status: snapshot.status,
      stopReason: snapshot.stopReason ?? current.stopReason,
      evidence,
      outputTokens: snapshot.outputTokens ?? current.outputTokens,
      costUsd: typeof snapshot.costUsd === "number" ? snapshot.costUsd : current.costUsd ?? null,
      updatedAt: snapshot.lastActivityAt ?? now,
      endedAt: snapshot.doneAt ?? snapshot.endedAt ?? current.endedAt,
      error: snapshot.error ?? current.error,
    };
    const signature = (value) => JSON.stringify({
      status: value.status,
      stopReason: value.stopReason,
      model: value.model,
      evidence: value.evidence,
      outputTokens: value.outputTokens,
      costUsd: value.costUsd,
      endedAt: value.endedAt,
      error: value.error,
    });
    if (signature(nextAttempt) === signature(current) && task.status === taskStatus && task.progress === progress) return task;
    changed = true;
    const nextAttempts = [...attempts.slice(0, -1), nextAttempt];
    return {
      ...task,
      status: taskStatus,
      progress,
      agent: snapshot.agent,
      model: snapshot.model ?? task.model,
      ...spendOf(nextAttempts),
      attempts: nextAttempts,
      updatedAt: now,
    };
  });
  return { state: changed ? { ...state, tasks, updatedAt: new Date().toISOString() } : state, changed };
}

export function updateTask(state, id, patch) {
  const allowedStatuses = new Set(["backlog", "ready", "running", "review", "blocked", "done"]);
  let found = false;
  const tasks = state.tasks.map((task) => {
    if (task.id !== id) return task;
    found = true;
    const status = allowedStatuses.has(patch?.status) ? patch.status : task.status;
    const progress = Number.isFinite(patch?.progress) ? Math.max(0, Math.min(100, patch.progress)) : task.progress;
    return { ...task, status, progress, updatedAt: new Date().toISOString() };
  });
  if (!found) throw new Error("task not found");
  return { ...state, tasks };
}

export function searchWorkspace(state, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length < 2) return [];
  const results = [];
  for (const node of state.nodes) {
    const haystack = `${node.label} ${node.detail} ${node.kind}`.toLowerCase();
    if (haystack.includes(q)) results.push({ type: "node", id: node.id, label: node.label, detail: node.detail, kind: node.kind });
  }
  for (const task of state.tasks) {
    const haystack = `${task.title} ${task.detail} ${task.status}`.toLowerCase();
    if (haystack.includes(q)) results.push({ type: "task", id: task.id, label: task.title, detail: task.detail, kind: task.status });
  }
  return results.slice(0, 50);
}

async function warmSearchSource(source) {
  const cached = SEARCH_CACHE.get(source.id);
  if (cached?.updatedAt === source.updatedAt) return cached.entries;
  const files = await walk(source.path);
  const entries = [];
  for (const file of files) {
    const rel = slash(relative(source.path, file.full));
    const text = await readFile(file.full, "utf8").catch(() => "");
    entries.push({
      nodeId: idFor("file", `${source.path}:${rel}`),
      path: rel,
      text: text.slice(0, MAX_SEARCH_BYTES_PER_FILE),
    });
  }
  SEARCH_CACHE.set(source.id, { updatedAt: source.updatedAt, entries });
  return entries;
}

/** Search graph metadata plus bounded source content, warming an in-memory index after restart. */
export async function searchWorkspaceContents(state, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length < 2) return [];
  const results = searchWorkspace(state, q);
  for (const source of state.sources) {
    if (results.length >= 50 || source.kind !== "repository") break;
    for (const entry of await warmSearchSource(source)) {
      if (results.length >= 50) break;
      const lower = entry.text.toLowerCase();
      const first = lower.indexOf(q);
      if (first === -1) continue;
      const start = Math.max(0, first - 90);
      const end = Math.min(entry.text.length, first + q.length + 150);
      const snippet = entry.text.slice(start, end).replace(/\s+/g, " ").trim();
      results.push({
        type: "content",
        id: entry.nodeId,
        label: entry.path,
        detail: `${start > 0 ? "…" : ""}${snippet}${end < entry.text.length ? "…" : ""}`,
        kind: "source match",
        sourceId: source.id,
      });
    }
  }
  return results.slice(0, 50);
}
