/**
 * The fleet's HTTP surface: a snapshot, a live event stream, the verbs
 * (launch, prompt, permission, cancel/close), and the permission relay
 * a native Claude Code agent asks through.
 *
 * Launching an agent runs code on this machine. The viewer binds to
 * loopback, but a web page on any origin can still make the browser
 * send requests to localhost — so cross-origin requests are refused
 * outright, and every POST must carry a header a simple cross-origin
 * request cannot (the browser would need a CORS preflight, which we
 * never answer).
 */
import { rank } from "./attention.mjs";
import { FLEET_AGENTS, getFleet } from "./fleet.mjs";

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, the CLI, the relay, same-origin navigations
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
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

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function events(req, res, fleet) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const push = () => res.write(`data: ${JSON.stringify(rank(fleet.list()))}\n\n`);
  // Coalesce bursts: a streaming agent changes state many times a second.
  let timer = null;
  const onChange = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      push();
    }, 80);
  };
  push();
  fleet.on("change", onChange);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    fleet.off("change", onChange);
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
  });
}

const ROUTE = /^\/([a-z0-9]+)(?:\/(prompt|permission|cancel|close|ask)(?:\/([A-Za-z0-9_-]+))?)?$/;

/** @returns {Promise<boolean>} true if the request was handled. */
export async function handleFleetApi(req, res, url, fleetOpts) {
  if (!url.pathname.startsWith("/api/fleet")) return false;

  if (!sameOrigin(req)) {
    json(res, 403, { error: "cross-origin request refused" });
    return true;
  }
  if (req.method === "POST" && req.headers["x-foolscap"] !== "fleet") {
    json(res, 403, { error: "missing x-foolscap header" });
    return true;
  }

  const fleet = getFleet(fleetOpts);
  const rest = url.pathname.slice("/api/fleet".length).replace(/\/$/, "");

  if (rest === "") {
    json(res, 200, rank(fleet.list()));
    return true;
  }
  if (rest === "/agents") {
    json(
      res,
      200,
      Object.entries(FLEET_AGENTS).map(([id, a]) => ({ id, label: a.label, driver: a.driver })),
    );
    return true;
  }
  if (rest === "/events") {
    events(req, res, fleet);
    return true;
  }
  if (rest === "/launch" && req.method === "POST") {
    const b = await readBody(req);
    const snap = fleet.launch({
      agent: b.agent,
      cwd: b.cwd,
      name: b.name,
      // The permission relay calls back to this same server.
      fleetUrl: `http://${req.headers.host}`,
    });
    json(res, 201, snap);
    return true;
  }

  const m = ROUTE.exec(rest);
  if (!m) {
    json(res, 404, { error: "no such route" });
    return true;
  }
  const [, id, action, arg] = m;
  const s = fleet.get(id);
  if (!s) {
    json(res, 404, { error: "no such session" });
    return true;
  }

  try {
    if (!action) {
      json(res, 200, { ...s.snapshot(), doc: s.doc() });
    } else if (action === "ask" && req.method === "GET" && arg) {
      json(res, 200, s.decision(arg));
    } else if (req.method !== "POST") {
      json(res, 405, { error: "POST required" });
    } else if (action === "ask") {
      const b = await readBody(req);
      json(res, 202, { requestId: s.ask(b) });
    } else if (action === "prompt") {
      const b = await readBody(req);
      if (typeof b.text !== "string" || !b.text.trim()) {
        json(res, 400, { error: "text required" });
        return true;
      }
      s.prompt(b.text);
      json(res, 200, s.snapshot());
    } else if (action === "permission") {
      const b = await readBody(req);
      s.answerPermission(String(b.optionId ?? ""));
      json(res, 200, s.snapshot());
    } else if (action === "cancel") {
      s.cancel();
      json(res, 200, s.snapshot());
    } else if (action === "close") {
      fleet.close(id);
      json(res, 200, { closed: id });
    }
  } catch (err) {
    json(res, 409, { error: err.message });
  }
  return true;
}
