/**
 * The permission relay: how Claude Code's permission prompts reach the app.
 *
 * Claude Code in print mode asks through an MCP tool (server/permission-
 * mcp.mjs), which posts the question here and polls for the answer. This
 * is the app's only HTTP listener: loopback only, and every request must
 * carry this run's random token, so nothing else on the machine can read
 * or answer a prompt.
 */
import { createServer } from "node:http";

const ROUTE = /^\/api\/fleet\/([\w-]+)\/ask(?:\/([\w-]+))?$/;

export function startRelay(fleet, token) {
  const server = createServer(async (req, res) => {
    const json = (status, body) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.headers["x-foolscap-token"] !== token) return json(403, { error: "forbidden" });
    const m = ROUTE.exec(req.url ?? "");
    const session = m && fleet.get(m[1]);
    if (!session) return json(404, { error: "no such session" });
    try {
      if (req.method === "POST" && !m[2]) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000_000) return json(413, { error: "too large" });
        }
        return json(200, { requestId: session.ask(JSON.parse(body || "{}")) });
      }
      if (req.method === "GET" && m[2]) return json(200, session.decision(m[2]));
      return json(405, { error: "method not allowed" });
    } catch (err) {
      return json(500, { error: String(err?.message ?? err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server }));
  });
}
