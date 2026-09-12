import {
  attachTaskAttempt,
  chooseAgent,
  createTask,
  indexSource,
  readWorkspace,
  reconcileWorkspace,
  searchWorkspace,
  searchWorkspaceContents,
  taskPrompt,
  updateTask,
  workspaceFile,
  writeWorkspace,
} from "./workspace.mjs";
import { FLEET_AGENTS, getFleet } from "./fleet.mjs";

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

function waitUntilReady(session, timeoutMs = 30_000) {
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

async function synchronizedState(file, root, fleet) {
  const current = await readWorkspace(file, root);
  if (!(current.tasks ?? []).some((task) => {
    const status = task.attempts?.at(-1)?.status;
    return ["starting", "idle", "working", "blocked"].includes(status);
  })) return current;
  const reconciled = reconcileWorkspace(current, fleet.list());
  return reconciled.changed ? writeWorkspace(reconciled.state, file) : current;
}

async function launchWorkspaceTask({ state, task, requestedAgent, cwd, fleet, file, root, fleetUrl }) {
  const decision = chooseAgent(state, task, requestedAgent, fleet.list(), Object.keys(FLEET_AGENTS));
  const snapshot = fleet.launch({
    agent: decision.agent,
    cwd: typeof cwd === "string" && cwd.trim() ? cwd.trim() : state.root,
    name: task.title,
    fleetUrl,
  });
  let next = await writeWorkspace(attachTaskAttempt(state, task.id, snapshot, decision), file);
  const session = fleet.get(snapshot.id);
  try {
    await waitUntilReady(session);
    session.prompt(taskPrompt(next, next.tasks.find((item) => item.id === task.id)));
  } catch (error) {
    if (session && session.status !== "error" && session.status !== "exited") session.fail(error?.message ?? String(error));
    await synchronizedState(file, root, fleet);
    throw error;
  }
  return synchronizedState(file, root, fleet);
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
      json(res, 200, await writeWorkspace(await body(req), file));
      return true;
    }
    if (rest === "/search" && req.method === "GET") {
      json(res, 200, await searchWorkspaceContents(await readWorkspace(file, root), url.searchParams.get("q")));
      return true;
    }
    if (rest === "/sources" && req.method === "POST") {
      const input = await body(req);
      const next = await indexSource(await readWorkspace(file, root), input.path, input.label);
      json(res, 201, await writeWorkspace(next, file));
      return true;
    }
    if (rest === "/tasks" && req.method === "POST") {
      const next = createTask(await readWorkspace(file, root), await body(req));
      json(res, 201, await writeWorkspace(next, file));
      return true;
    }
    if (rest === "/voice/sessions" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.id !== "string" || !input.id.trim()) throw new Error("voice session id is required");
      const current = await readWorkspace(file, root);
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
      const next = { ...current, voiceSessions: [record, ...(current.voiceSessions ?? []).filter((item) => item.id !== record.id)] };
      json(res, 201, await writeWorkspace(next, file));
      return true;
    }
    if (rest === "/coordinator/dispatch" && req.method === "POST") {
      const input = await body(req);
      let next = await synchronizedState(file, root, fleet);
      const priority = { P0: 0, P1: 1, P2: 2 };
      const ready = next.tasks.filter((task) => task.status === "ready")
        .sort((a, b) => (priority[a.priority] ?? 9) - (priority[b.priority] ?? 9) || a.updatedAt.localeCompare(b.updatedAt));
      const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(10, input.limit)) : 10;
      let launched = 0;
      const errors = [];
      for (const candidate of ready.slice(0, limit)) {
        try {
          const task = next.tasks.find((item) => item.id === candidate.id);
          next = await launchWorkspaceTask({ state: next, task, requestedAgent: "auto", fleet, file, root, fleetUrl: `http://${req.headers.host}` });
          launched++;
        } catch (error) {
          errors.push({ taskId: candidate.id, error: error?.message ?? String(error) });
          if (/capacity|limit/.test(error?.message ?? "")) break;
        }
      }
      if (!launched && !ready.length) throw new Error("no ready tasks to dispatch");
      json(res, 202, { ...next, dispatch: { launched, errors } });
      return true;
    }
    const action = TASK_ACTION.exec(rest);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      const state = await synchronizedState(file, root, fleet);
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("task not found");
      const current = task.attempts?.at(-1);
      if (current && ["starting", "idle", "working", "blocked"].includes(current.status)) {
        if (action[2] === "cancel") {
          const session = fleet.get(current.sessionId);
          if (!session) throw new Error("agent session is no longer active");
          session.cancel();
          json(res, 202, await synchronizedState(file, root, fleet));
          return true;
        }
        throw new Error("task already has an active agent session");
      }
      if (action[2] === "cancel") throw new Error("task has no active agent session");

      const input = await body(req);
      const next = await launchWorkspaceTask({
        state, task, requestedAgent: input.agent ?? "auto", cwd: input.cwd, fleet, file, root,
        fleetUrl: `http://${req.headers.host}`,
      });
      json(res, 202, next);
      return true;
    }
    const match = TASK.exec(rest);
    if (match && req.method === "PATCH") {
      const next = updateTask(await readWorkspace(file, root), decodeURIComponent(match[1]), await body(req));
      json(res, 200, await writeWorkspace(next, file));
      return true;
    }
    json(res, 404, { error: "no such workspace route" });
  } catch (err) {
    json(res, 400, { error: err?.message ?? String(err) });
  }
  return true;
}
