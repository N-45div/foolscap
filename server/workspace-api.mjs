import {
  attachTaskAttempt,
  chooseAgent,
  createTask,
  indexSource,
  mutateWorkspace,
  readWorkspace,
  reconcileWorkspace,
  searchWorkspaceContents,
  taskPrompt,
  updateTask,
  workspaceFile,
} from "./workspace.mjs";
import { FLEET_AGENTS, getFleet } from "./fleet.mjs";
import { resolve } from "node:path";

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function body(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

const TASK = /^\/tasks\/([^/]+)$/;
const TASK_ACTION = /^\/tasks\/([^/]+)\/(run|cancel)$/;
const ACTIVE = new Set(["starting", "idle", "working", "blocked"]);

export function waitUntilReady(session, timeoutMs = 30_000) {
  if (session.status !== "starting") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("agent did not become ready in time")), timeoutMs);
    const onChange = () => {
      if (session.status === "idle" || session.status === "done") finish();
      else if (session.status === "error" || session.status === "exited") finish(new Error(session.error || `agent ${session.status}`));
    };
    const finish = (error) => {
      clearTimeout(timer);
      session.off("change", onChange);
      if (error) reject(error); else resolve();
    };
    session.on("change", onChange);
    onChange();
  });
}

const hasActiveAttempt = (state) =>
  (state.tasks ?? []).some((task) => ACTIVE.has(task.attempts?.at(-1)?.status));

/** The file, with live fleet evidence projected onto any running task. */
export function synchronizedState(file, root, fleet) {
  return mutateWorkspace(file, root, (current) => {
    if (!hasActiveAttempt(current)) return current;
    const reconciled = reconcileWorkspace(current, fleet.list());
    return reconciled.changed ? reconciled.state : current;
  });
}

/**
 * Route a task, launch the agent, brief it. Used by the board's "run",
 * by "dispatch ready", and by the coordinator's async dispatch tool.
 * `instructions` are appended to the brief for this attempt only.
 */
export async function launchWorkspaceTask({ taskId, requestedAgent = "auto", cwd, instructions, fleet, file, root, fleetUrl, onLaunch }) {
  let launched = null;
  try {
    await mutateWorkspace(file, root, (state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("task not found");
      const current = task.attempts?.at(-1);
      if (current && ACTIVE.has(current.status)) throw new Error("task already has an active agent session");

      // Two coding agents in one checkout can overwrite each other's edits.
      // Keep one writer per checkout; separate repositories can still run up
      // to the configured global capacity.
      const workdir = resolve(typeof cwd === "string" && cwd.trim() ? cwd.trim() : state.root);
      const key = process.platform === "win32" ? workdir.toLowerCase() : workdir;
      const snapshots = fleet.list();
      const occupant = snapshots.find((snapshot) => {
        if (!ACTIVE.has(snapshot.status) || !snapshot.cwd) return false;
        const activeDir = resolve(snapshot.cwd);
        return (process.platform === "win32" ? activeDir.toLowerCase() : activeDir) === key;
      });
      if (occupant) throw new Error(`workspace is busy with ${occupant.name || occupant.agent || "another agent"}`);

      const decision = chooseAgent(state, task, requestedAgent, snapshots, Object.keys(FLEET_AGENTS));
      const snapshot = fleet.launch({
        agent: decision.agent,
        cwd: workdir,
        name: task.title,
        fleetUrl,
      });
      launched = { snapshot, decision };
      onLaunch?.(snapshot.id);
      return attachTaskAttempt(state, task.id, snapshot, decision);
    });
  } catch (error) {
    // A failed state write must not leave an untracked process editing code.
    const session = launched ? fleet.get(launched.snapshot.id) : null;
    if (session && ACTIVE.has(session.status)) session.cancel();
    throw error;
  }
  const session = fleet.get(launched.snapshot.id);
  try {
    await waitUntilReady(session);
    const state = await readWorkspace(file, root);
    const task = state.tasks.find((item) => item.id === taskId);
    const brief = taskPrompt(state, task) + (instructions ? `\n\nInstructions for this attempt:\n${instructions}` : "");
    session.prompt(brief);
  } catch (error) {
    if (session && session.status !== "error" && session.status !== "exited") session.fail(error?.message ?? String(error));
    await synchronizedState(file, root, fleet);
    throw error;
  }
  return { state: await synchronizedState(file, root, fleet), sessionId: launched.snapshot.id, decision: launched.decision };
}

/** Handle the local workspace API. */
export async function handleWorkspaceApi(req, res, url, options = {}) {
  if (!url.pathname.startsWith("/api/workspace")) return false;
  if (!sameOrigin(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  if (req.method !== "GET" && req.headers["x-foolscap"] !== "workspace") {
    json(res, 403, { error: "missing x-foolscap header" });
    return true;
  }

  const file = options.file ?? workspaceFile();
  const root = options.root ?? process.cwd();
  const fleet = options.fleet ?? getFleet(options.fleetOpts);
  const rest = url.pathname.slice("/api/workspace".length).replace(/\/$/, "");
  try {
    if (rest === "" && req.method === "GET") {
      json(res, 200, await synchronizedState(file, root, fleet));
      return true;
    }
    if (rest === "" && req.method === "PUT") {
      // The UI edits tasks, nodes, edges and routing. Runs, decisions and
      // voice sessions are the server's; a stale client copy can't erase them.
      const input = await body(req);
      json(res, 200, await mutateWorkspace(file, root, (current) => ({
        ...current,
        tasks: Array.isArray(input.tasks) ? input.tasks : current.tasks,
        nodes: Array.isArray(input.nodes) ? input.nodes : current.nodes,
        edges: Array.isArray(input.edges) ? input.edges : current.edges,
        routing: input.routing && typeof input.routing === "object" ? input.routing : current.routing,
      })));
      return true;
    }
    if (rest === "/search" && req.method === "GET") {
      json(res, 200, await searchWorkspaceContents(await readWorkspace(file, root), url.searchParams.get("q")));
      return true;
    }
    if (rest === "/sources" && req.method === "POST") {
      const input = await body(req);
      json(res, 201, await mutateWorkspace(file, root, (current) => indexSource(current, input.path, input.label)));
      return true;
    }
    if (rest === "/tasks" && req.method === "POST") {
      const input = await body(req);
      json(res, 201, await mutateWorkspace(file, root, (current) => createTask(current, input)));
      return true;
    }
    if (rest === "/voice/sessions" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.id !== "string" || !input.id.trim()) throw new Error("voice session id is required");
      const usage = input.usage && typeof input.usage === "object" &&
        JSON.stringify(input.usage).length <= 50_000 ? input.usage : {};
      const record = {
        id: input.id.slice(0, 200),
        model: "gpt-live-1",
        backendModel: typeof input.backendModel === "string" ? input.backendModel.slice(0, 100) : "gpt-5.6-luna",
        startedAt: typeof input.startedAt === "string" ? input.startedAt : new Date().toISOString(),
        endedAt: typeof input.endedAt === "string" ? input.endedAt : new Date().toISOString(),
        usage,
      };
      json(res, 201, await mutateWorkspace(file, root, (current) => ({
        ...current,
        voiceSessions: [record, ...(current.voiceSessions ?? []).filter((item) => item.id !== record.id)],
      })));
      return true;
    }
    if (rest === "/coordinator/dispatch" && req.method === "POST") {
      const input = await body(req);
      const current = await synchronizedState(file, root, fleet);
      const priority = { P0: 0, P1: 1, P2: 2 };
      const ready = current.tasks.filter((task) => task.status === "ready")
        .sort((a, b) => (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9) || a.updatedAt.localeCompare(b.updatedAt));
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(10, input.limit)) : 10;
      let launched = 0;
      const errors = [];
      for (const candidate of ready.slice(0, limit)) {
        try {
          await launchWorkspaceTask({ taskId: candidate.id, requestedAgent: "auto", fleet, file, root, fleetUrl: `http://${req.headers.host}` });
          launched++;
        } catch (error) {
          errors.push({ taskId: candidate.id, error: error?.message ?? String(error) });
          if (/capacity|limit/.test(error?.message ?? "")) break;
        }
      }
      if (!launched && !ready.length) throw new Error("no ready tasks to dispatch");
      json(res, 202, { ...(await synchronizedState(file, root, fleet)), dispatch: { launched, errors } });
      return true;
    }
    const action = TASK_ACTION.exec(rest);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      const state = await synchronizedState(file, root, fleet);
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("task not found");
      const current = task.attempts?.at(-1);
      if (action[2] === "cancel") {
        if (!current || !ACTIVE.has(current.status)) throw new Error("task has no active agent session");
        const session = fleet.get(current.sessionId);
        if (!session) throw new Error("agent session is no longer active");
        session.cancel();
        json(res, 202, await synchronizedState(file, root, fleet));
        return true;
      }
      const input = await body(req);
      const { state: next } = await launchWorkspaceTask({
        taskId: id, requestedAgent: input.agent ?? "auto", cwd: input.cwd, fleet, file, root,
        fleetUrl: `http://${req.headers.host}`,
      });
      json(res, 202, next);
      return true;
    }
    const match = TASK.exec(rest);
    if (match && req.method === "PATCH") {
      const patch = await body(req);
      json(res, 200, await mutateWorkspace(file, root, (current) => updateTask(current, decodeURIComponent(match[1]), patch)));
      return true;
    }
    json(res, 404, { error: "no such workspace route" });
  } catch (err) {
    json(res, 400, { error: err?.message ?? String(err) });
  }
  return true;
}
