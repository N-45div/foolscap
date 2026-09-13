/**
 * /api/coordinator — start a run, read it, answer it, stop it.
 *
 * Loopback-only like the fleet (a run launches agents that edit code),
 * same-origin, and a custom header on anything that isn't a GET so a
 * stray form post can't start one.
 */
import { createCoordinator } from "./coordinator.mjs";
import { getFleet } from "./fleet.mjs";
import { readWorkspace, workspaceFile } from "./workspace.mjs";

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
      if (raw.length > 200_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

let singleton = null;

/** The one coordinator per process; the first caller's options stick. */
export function getCoordinator(options = {}) {
  singleton ??= createCoordinator({
    file: options.file ?? workspaceFile(),
    root: options.root ?? process.cwd(),
    fleet: options.fleet ?? getFleet(options.fleetOpts),
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl: options.baseUrl,
    model: options.model,
    fetchImpl: options.fetchImpl,
    retryDelayMs: options.retryDelayMs,
    effort: options.effort,
  });
  return singleton;
}

const RUN = /^\/runs\/([^/]+)$/;
const RUN_ACTION = /^\/runs\/([^/]+)\/(answer|cancel)$/;

export async function handleCoordinatorApi(req, res, url, options = {}) {
  if (!url.pathname.startsWith("/api/coordinator")) return false;
  if (!sameOrigin(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  if (req.method !== "GET" && req.headers["x-foolscap"] !== "coordinator") {
    json(res, 403, { error: "missing x-foolscap header" });
    return true;
  }
  const coordinator = options.coordinator ?? getCoordinator(options);
  const { file, root } = coordinator.ctx;
  const rest = url.pathname.slice("/api/coordinator".length).replace(/\/$/, "");

  try {
    if (rest === "/runs" && req.method === "GET") {
      await coordinator.reap();
      const state = await readWorkspace(file, root);
      json(res, 200, { runs: (state.runs ?? []).map((run) => coordinator.get(run.id) ?? run), model: coordinator.ctx.model, ready: Boolean(coordinator.ctx.apiKey) });
      return true;
    }
    if (rest === "/runs" && req.method === "POST") {
      if (!coordinator.ctx.apiKey) {
        json(res, 503, { error: "Set OPENAI_API_KEY to use the coordinator" });
        return true;
      }
      const input = await body(req);
      const run = await coordinator.start({
        goal: input.goal,
        budgetUsd: Number(input.budgetUsd),
        fleetUrl: `http://${req.headers.host}`,
      });
      json(res, 202, run);
      return true;
    }
    const action = RUN_ACTION.exec(rest);
    if (action && req.method === "POST") {
      const id = decodeURIComponent(action[1]);
      if (action[2] === "answer") {
        const input = await body(req);
        if (typeof input.answer !== "string" || !input.answer.trim()) throw new Error("an answer is required");
        coordinator.answer(id, input.answer.trim());
      } else {
        coordinator.cancel(id);
      }
      json(res, 202, coordinator.get(id) ?? { id });
      return true;
    }
    const match = RUN.exec(rest);
    if (match && req.method === "GET") {
      const id = decodeURIComponent(match[1]);
      const live = coordinator.get(id);
      if (live) {
        json(res, 200, live);
        return true;
      }
      const state = await readWorkspace(file, root);
      const run = (state.runs ?? []).find((item) => item.id === id);
      if (!run) throw new Error("run not found");
      json(res, 200, run);
      return true;
    }
    json(res, 404, { error: "no such coordinator route" });
  } catch (err) {
    json(res, 400, { error: err?.message ?? String(err) });
  }
  return true;
}
