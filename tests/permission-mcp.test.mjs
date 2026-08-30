/**
 * The permission relay is a stdio MCP server Claude Code calls when it
 * wants to use a tool. It must speak enough MCP to be listed, and turn
 * the fleet's answer into the JSON Claude Code expects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const RELAY = join(import.meta.dirname, "..", "server", "permission-mcp.mjs");

/** A stand-in fleet: registers the ask, says "undecided" twice, then allows. */
function fakeFleet() {
  let polls = 0;
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers["x-foolscap"] ?? "-"}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/api/fleet/abc/ask") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        assert.equal(body.tool_name, "Write");
        res.statusCode = 202;
        res.end(JSON.stringify({ requestId: "r1" }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/fleet/abc/ask/r1") {
      polls++;
      res.end(JSON.stringify(polls < 3 ? { decided: false } : { decided: true, allow: true }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })),
  );
}

test("relay: lists the permission tool and returns Claude Code's allow JSON after the fleet decides", async () => {
  const { server, port, seen } = await fakeFleet();
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, FOOLSCAP_FLEET: `http://127.0.0.1:${port}`, FOOLSCAP_SESSION: "abc" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const got = (id, ms = 8000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const r = replies.find((x) => x.id === id);
        if (r) return resolve(r);
        if (Date.now() - t0 > ms) return reject(new Error(`no reply for ${id}`));
        setTimeout(tick, 20);
      };
      tick();
    });

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } });
    const init = await got(1);
    assert.equal(init.result.serverInfo.name, "foolscap");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await got(2);
    assert.deepEqual(list.result.tools.map((t) => t.name), ["permission"]);

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "permission", arguments: { tool_name: "Write", input: { file_path: ".env" }, tool_use_id: "toolu_1" } } });
    const call = await got(3);
    const decision = JSON.parse(call.result.content[0].text);
    assert.equal(decision.behavior, "allow");
    assert.deepEqual(decision.updatedInput, { file_path: ".env" });

    assert.ok(seen.some((s) => s.startsWith("POST /api/fleet/abc/ask fleet")), "asks carry the x-foolscap header");
    assert.ok(seen.filter((s) => s.startsWith("GET /api/fleet/abc/ask/r1")).length >= 3, "polls until decided");
  } finally {
    child.kill();
    server.close();
  }
});
