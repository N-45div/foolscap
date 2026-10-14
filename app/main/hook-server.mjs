/**
 * The address Claude Code's hooks post to: http://127.0.0.1:<port>/hooks/claude.
 *
 * Unlike the permission relay, this port is fixed (47821 unless the person
 * changes it), because the URL lives in their Claude Code settings and
 * must still be right after foolscap restarts. It listens on loopback
 * only, and every request must carry the token written into that URL.
 */
import { createServer } from "node:http";

export function startHookServer({ port, token, external, log = () => {} }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status, body) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname !== "/hooks/claude" || req.method !== "POST") return json(404, {});
    if (url.searchParams.get("t") !== token) return json(403, {});
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) return json(413, {});
    }
    try {
      return json(200, await external.handle(JSON.parse(body || "{}")));
    } catch (err) {
      log(`hook failed: ${err.message}`);
      // An empty answer lets Claude Code carry on as if foolscap were not there.
      return json(200, {});
    }
  });
  // A permission or a Stop with tests to run may take a while to answer.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
