/**
 * GPT-Live WebRTC session broker.
 *
 * The browser sends its SDP offer here; the project key stays in this
 * loopback server. GPT-Live handles the spoken conversation while a small
 * Responses delegation chooses from workspace tools. Tool execution still
 * happens through the local workspace API and its budget/capacity policy.
 */
import { createHash } from "node:crypto";
import { readWorkspace, workspaceFile } from "./workspace.mjs";

const LIVE_URL = "https://api.openai.com/v1/live/sessions";

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
      if (raw.length > 128_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

const TOOLS = [
  {
    type: "function",
    name: "workspace_create_task",
    description: "Create a durable task on the workspace board. This records work but does not start an agent.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, concrete task title." },
        detail: { type: "string", description: "Full task objective and acceptance details." },
        priority: { type: "string", enum: ["P0", "P1", "P2"] },
        budget_usd: { type: "number", minimum: 0.25, maximum: 100 },
        ready: { type: "boolean", description: "Place the task in Ready when the user wants it eligible for dispatch." },
      },
      required: ["title", "detail", "priority", "budget_usd", "ready"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "workspace_list_tasks",
    description: "List current tasks, their stable IDs, states, budgets, assigned agents, and latest evidence.",
    parameters: {
      type: "object",
      properties: {
        status: { type: ["string", "null"], enum: ["backlog", "ready", "running", "review", "blocked", "done", null] },
      },
      required: ["status"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "workspace_search",
    description: "Search connected repository files, notes, graph entities, and task text.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "workspace_update_task",
    description: "Move an existing task to another board state using the exact task ID returned by workspace_list_tasks.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["backlog", "ready", "review", "blocked", "done"] },
      },
      required: ["task_id", "status"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "workspace_dispatch_ready",
    description: "Start agents for ready tasks through the coordinator. Call only after the user explicitly says to run, start, execute, begin, or dispatch the work.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 3 } },
      required: ["limit"],
      additionalProperties: false,
    },
    strict: true,
  },
];

function sessionConfig(state, backendModel) {
  const sourceSummary = state.sources.slice(0, 8).map((source) => source.label).join(", ") || "none";
  return {
    model: "gpt-live-1",
    instructions: [
      "You are the voice interface for Foolscap, a local workspace and coding-agent coordinator.",
      "Speak briefly and naturally. Help the user capture, inspect, organize, and start work without switching tabs.",
      "Delegate workspace questions and actions to the backend tools. Do not claim an action completed until its tool result confirms it.",
      "Starting agents changes code. Use workspace_dispatch_ready only when the user's latest words explicitly ask to run, start, execute, begin, or dispatch work.",
      `Current workspace: ${state.name}. Connected sources: ${sourceSummary}. Tasks: ${state.tasks.length}.`,
    ].join("\n"),
    delegation: {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: [
          "Translate the live conversation into precise Foolscap workspace tool calls.",
          "Treat transcripts as potentially imperfect and honor the user's latest correction.",
          "Use list/search before updating when an exact task ID is unknown.",
          "Creating a task is separate from dispatching it. Never report success before receiving a successful function result.",
          "Return concise facts and the next useful action for a spoken conversation.",
        ].join("\n"),
        tools: TOOLS,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_output_tokens: 512,
      },
    },
  };
}

/** Handle the local GPT-Live session endpoint. */
export async function handleLiveApi(req, res, url, options = {}) {
  if (!url.pathname.startsWith("/api/live")) return false;
  if (!sameOrigin(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  if (req.method !== "POST" || req.headers["x-foolscap"] !== "live") {
    json(res, req.method === "POST" ? 403 : 405, { error: req.method === "POST" ? "missing x-foolscap header" : "POST required" });
    return true;
  }
  if (url.pathname.replace(/\/$/, "") !== "/api/live/session") {
    json(res, 404, { error: "no such live route" });
    return true;
  }

  const input = await body(req);
  if (typeof input.sdp !== "string" || !input.sdp.trim()) {
    json(res, 400, { error: "an SDP offer is required" });
    return true;
  }
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    json(res, 503, { error: "Set OPENAI_API_KEY to use GPT-Live voice" });
    return true;
  }

  try {
    const state = await readWorkspace(options.file ?? workspaceFile(), options.root ?? process.cwd());
    const backendModel = options.backendModel ?? process.env.FOOLSCAP_VOICE_BACKEND_MODEL ?? "gpt-5.6-luna";
    const safetyId = createHash("sha256").update(`foolscap:${state.id}`).digest("hex");
    const upstream = await (options.fetchImpl ?? fetch)(LIVE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "openai-safety-identifier": safetyId,
      },
      body: JSON.stringify({
        session: sessionConfig(state, backendModel),
        transport: { type: "webrtc", sdp: input.sdp },
      }),
    });
    const raw = await upstream.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = null; }
    if (!upstream.ok) {
      json(res, upstream.status, { error: result?.error?.message ?? "GPT-Live session creation failed" });
      return true;
    }
    if (!result?.session?.id || !result?.transport?.sdp) {
      json(res, 502, { error: "GPT-Live returned an invalid session response" });
      return true;
    }
    json(res, 201, { ...result, foolscap: { backendModel } });
  } catch (error) {
    json(res, 502, { error: error?.message ?? "GPT-Live session creation failed" });
  }
  return true;
}

export { TOOLS as LIVE_WORKSPACE_TOOLS, sessionConfig as liveSessionConfig };
