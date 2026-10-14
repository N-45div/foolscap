/**
 * A minimal stdio ACP agent, for testing the bridge and the fleet
 * without spending a real agent's tokens. It speaks just enough of the
 * protocol to prove the relay and the cockpit are faithful:
 *
 *   initialize      → protocolVersion + capabilities
 *   session/new     → a sessionId
 *   session/prompt  → streamed session/update notifications, then a
 *                     result. The prompt text picks the scenario:
 *       "ask"   the agent asks permission before finishing
 *       "fail"  the test run comes back red
 *       "slow"  the turn takes a while (for cancel tests)
 *   session/cancel  → the in-flight prompt ends with "cancelled"
 *
 * It also emits a line of noise on stderr and a non-JSON line on stdout,
 * so the tests can pin that neither reaches the wire.
 */
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const update = (sessionId, update) =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

process.stderr.write("fake-acp-agent: starting\n");
process.stdout.write("this line is not json and must be dropped\n");

let inflight = null; // { id, cancelled }
const waiting = new Map(); // permission request id → resolver

async function runTurn(req) {
  const sessionId = req.params?.sessionId;
  const text = (req.params?.prompt ?? []).map((b) => b.text ?? "").join(" ");
  inflight = { id: req.id, cancelled: false };

  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "working on it" },
  });
  await sleep(text.includes("slow") ? 1500 : 30);
  if (inflight?.cancelled) return;

  if (text.includes("ask")) {
    const permId = "perm-1";
    send({
      jsonrpc: "2.0",
      id: permId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "t-ask", title: "Write .env", kind: "edit", status: "pending" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    const decision = await new Promise((resolve) => waiting.set(permId, resolve));
    if (inflight?.cancelled) return;
    const allowed = decision?.outcome?.outcome === "selected" && decision.outcome.optionId === "allow-once";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t-ask",
      status: allowed ? "completed" : "failed",
      rawOutput: allowed ? "wrote .env" : "permission denied",
    });
  }

  const red = text.includes("fail");
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "pnpm test",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "pnpm test" },
  });
  await sleep(20);
  if (inflight?.cancelled) return;
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: red ? "failed" : "completed",
    rawOutput: red ? "Tests  2 failed, 9 passed\nFAIL tests/a.ts" : "Tests  11 passed (11)",
  });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: red ? "two tests are red" : "all green" },
  });
  send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
  inflight = null;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  // A response to one of our permission requests.
  if (req.id !== undefined && req.method === undefined && waiting.has(req.id)) {
    waiting.get(req.id)(req.result);
    waiting.delete(req.id);
    return;
  }

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (req.method === "session/new") {
    send({ jsonrpc: "2.0", id: req.id, result: { sessionId: "sess-fake-1" } });
    return;
  }

  if (req.method === "session/prompt") {
    runTurn(req);
    return;
  }

  if (req.method === "session/cancel") {
    if (inflight) {
      inflight.cancelled = true;
      send({ jsonrpc: "2.0", id: inflight.id, result: { stopReason: "cancelled" } });
      inflight = null;
    }
    return;
  }

  if (req.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `unknown method ${req.method}` },
    });
  }
});
