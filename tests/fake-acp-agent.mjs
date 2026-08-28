/**
 * A minimal stdio ACP agent, for testing the bridge without spending a
 * real agent's tokens. It speaks just enough of the protocol to prove
 * the relay is faithful in both directions:
 *
 *   initialize      → protocolVersion + capabilities
 *   session/new     → a sessionId
 *   session/prompt  → two session/update notifications, then a result
 *
 * It also emits a line of noise on stderr and a non-JSON line on stdout,
 * so the tests can pin that neither reaches the wire.
 */
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

process.stderr.write("fake-acp-agent: starting\n");
process.stdout.write("this line is not json and must be dropped\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
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
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { sessionId: "sess-fake-1" },
    });
    return;
  }

  if (req.method === "session/prompt") {
    const sessionId = req.params?.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          type: "agent_message_chunk",
          content: { type: "text", text: "working on it" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          type: "tool_call",
          toolCallId: "t1",
          title: "pnpm test",
          kind: "execute",
          status: "completed",
          rawInput: { command: "pnpm test" },
        },
      },
    });
    send({ jsonrpc: "2.0", id: req.id, result: { stopReason: "end_turn" } });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `unknown method ${req.method}` },
  });
});
