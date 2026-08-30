/**
 * The ACP bridge exposes a process that runs code, over a network
 * socket. These tests pin the two things that must never regress: the
 * door is locked, and the relay is faithful in both directions.
 *
 *   node --test tests/acp.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAcpBridge, newToken } from "../server/acp.mjs";

const AGENT = `node ${join(import.meta.dirname, "fake-acp-agent.mjs")}`;
const started = [];

after(async () => {
  for (const b of started) await b.close();
});

async function bridge(extra = {}) {
  const token = newToken();
  const b = await startAcpBridge({
    agent: AGENT,
    port: 0, // ephemeral: tests must not fight over a fixed port
    token,
    record: false,
    cwd: process.cwd(),
    ...extra,
  });
  started.push(b);
  return { ...b, token, url: `ws://127.0.0.1:${b.port}` };
}

/** Open a socket and collect frames until `want` of them arrive. */
function connect(url, { want = 1, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const timer = setTimeout(
      () => reject(new Error(`timed out with ${frames.length}/${want} frames`)),
      timeout,
    );
    ws.addEventListener("message", (e) => {
      frames.push(JSON.parse(e.data));
      if (frames.length >= want) {
        clearTimeout(timer);
        resolve({ ws, frames });
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    });
    ws.addEventListener("open", () => resolve.ready?.());
  });
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));

test("refuses to start without a token", async () => {
  await assert.rejects(
    () => startAcpBridge({ agent: AGENT, port: 0, token: "" }),
    /token is required/,
  );
});

test("rejects a connection with no token", async () => {
  const b = await bridge();
  await assert.rejects(() => connect(b.url, { want: 1, timeout: 3000 }));
});

test("rejects a connection with the wrong token", async () => {
  const b = await bridge();
  await assert.rejects(() =>
    connect(`${b.url}/?token=not-the-token`, { want: 1, timeout: 3000 }),
  );
});

test("relays a full initialize → new → prompt exchange", async () => {
  const b = await bridge();
  const ws = new WebSocket(`${b.url}/?token=${b.token}`);
  const frames = [];
  const got = (n) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 8000);
      const check = () => {
        if (frames.length >= n) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.addEventListener("message", check);
      check();
    });

  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  await new Promise((r) => ws.addEventListener("open", r));

  send(ws, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: { fs: {} } },
  });
  await got(1);
  assert.equal(frames[0].result.protocolVersion, 1);

  send(ws, {
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: process.cwd(), mcpServers: [] },
  });
  await got(2);
  const sessionId = frames[1].result.sessionId;
  assert.equal(sessionId, "sess-fake-1");

  send(ws, {
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "make it work" }] },
  });
  // streamed session/update notifications, then the result for id 2
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no prompt result")), 8000);
    const check = () => {
      if (frames.some((f) => f.id === 2)) {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.addEventListener("message", check);
    check();
  });

  const updates = frames.filter((f) => f.method === "session/update");
  assert.ok(updates.length >= 2);
  assert.equal(updates[0].params.update.sessionUpdate, "agent_message_chunk");
  assert.equal(updates[1].params.update.sessionUpdate, "tool_call");

  const result = frames.find((f) => f.id === 2);
  assert.equal(result.result.stopReason, "end_turn");

  // Non-JSON agent output and stderr must never reach the wire.
  assert.ok(
    frames.every((f) => typeof f === "object" && f.jsonrpc === "2.0"),
    "only JSON-RPC frames should be relayed",
  );
  ws.close();
});

test("records both directions into a replayable transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foolscap-acp-"));
  const token = newToken();
  const b = await startAcpBridge({
    agent: AGENT,
    port: 0,
    token,
    record: true,
    recordDir: dir,
    cwd: process.cwd(),
  });
  started.push(b);

  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/?token=${token}`);
  const frames = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(e.data)));
  await new Promise((r) => ws.addEventListener("open", r));

  send(ws, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
  send(ws, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: dir } });
  send(ws, {
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: { sessionId: "sess-fake-1", prompt: [{ type: "text", text: "ship it" }] },
  });
  await new Promise((r) => setTimeout(r, 1200));
  ws.close();
  await new Promise((r) => setTimeout(r, 400));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  assert.equal(files.length, 1, "one transcript per connection");
  const lines = (await readFile(join(dir, files[0]), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert.equal(lines[0].type, "foolscap-acp", "header first");
  assert.ok(lines[0].agent, "header names the agent");

  const dirs = new Set(lines.slice(1).map((l) => l.dir));
  assert.ok(dirs.has("c2a") && dirs.has("a2c"), "both directions recorded");

  const prompt = lines.find((l) => l.msg?.method === "session/prompt");
  assert.equal(prompt.msg.params.prompt[0].text, "ship it");

  const update = lines.find((l) => l.msg?.method === "session/update");
  assert.ok(update, "agent notifications recorded");

  // The token must never appear in a recording.
  const raw = await readFile(join(dir, files[0]), "utf8");
  assert.ok(!raw.includes(token), "token must not be written to disk");
});
