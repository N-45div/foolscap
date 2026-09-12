import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLiveApi } from "../server/live-api.mjs";

const servers = [];
after(async () => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

async function serve(options) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await handleLiveApi(req, res, url, options);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("GPT-Live session creation requires a server-side project key", async () => {
  const root = await mkdtemp(join(tmpdir(), "foolscap-live-no-key-"));
  const base = await serve({ apiKey: "", file: join(root, "workspace.json"), root });
  const response = await fetch(`${base}/api/live/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "live" },
    body: JSON.stringify({ sdp: "offer" }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
});

test("the live broker keeps the key server-side and configures workspace delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "foolscap-live-session-"));
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      session: { id: "live_test" },
      transport: { type: "webrtc", sdp: "answer" },
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const base = await serve({
    apiKey: "server-secret",
    backendModel: "gpt-5.6-luna",
    fetchImpl,
    file: join(root, "workspace.json"),
    root,
  });
  const response = await fetch(`${base}/api/live/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "live" },
    body: JSON.stringify({ sdp: "browser-offer" }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.transport.sdp, "answer");
  assert.equal(created.foolscap.backendModel, "gpt-5.6-luna");
  assert.equal(request.url, "https://api.openai.com/v1/live/sessions");
  assert.equal(request.init.headers.authorization, "Bearer server-secret");
  assert.equal(request.init.headers["openai-safety-identifier"].length, 64);
  assert.equal(request.body.session.model, "gpt-live-1");
  assert.equal(request.body.session.delegation.type, "responses");
  assert.equal(request.body.session.delegation.responses.model, "gpt-5.6-luna");
  assert.equal(request.body.transport.sdp, "browser-offer");
  assert.deepEqual(
    request.body.session.delegation.responses.tools.map((tool) => tool.name),
    ["workspace_create_task", "workspace_list_tasks", "workspace_search", "workspace_update_task", "workspace_dispatch_ready"],
  );
});

test("the live broker refuses browser requests from another origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "foolscap-live-origin-"));
  const base = await serve({ apiKey: "server-secret", file: join(root, "workspace.json"), root });
  const response = await fetch(`${base}/api/live/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-foolscap": "live", origin: "https://example.com" },
    body: JSON.stringify({ sdp: "offer" }),
  });
  assert.equal(response.status, 403);
});
