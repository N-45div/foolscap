/**
 * Fleet driver: any agent that speaks ACP over stdio.
 *
 * A driver owns the transport and nothing else. It launches the agent,
 * hands every frame to the session (which records it, builds the
 * document and derives evidence), and turns the protocol's permission
 * requests into a driver-neutral "this agent is blocked on you". The
 * session core never sees JSON-RPC.
 */
import { spawnAgent } from "../acp.mjs";

const CLIENT_INFO = { name: "foolscap", title: "foolscap", version: "0.4.0" };

export function createAcpDriver({ spec, cwd, log, onFrame, onPermission }) {
  let child = null;
  let buffered = "";
  let rpcId = 0;
  const pending = new Map();
  const driver = { kind: "acp", sessionId: null };

  const send = (msg) => {
    onFrame("c2a", msg);
    child?.stdin.write(JSON.stringify(msg) + "\n");
  };

  const rpc = (method, params, { timeout = 90_000 } = {}) =>
    new Promise((resolve, reject) => {
      const id = rpcId++;
      const timer =
        timeout > 0
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`${method} timed out`));
            }, timeout)
          : null;
      pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const failPending = (why) => {
    for (const [, p] of pending) p.reject(new Error(why));
    pending.clear();
  };

  function receive(msg) {
    onFrame("a2c", msg);
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "agent error"));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        onPermission({
          requestId: msg.id,
          toolCall: msg.params?.toolCall ?? {},
          options: msg.params?.options ?? [],
        });
      } else {
        // We advertised no fs/terminal capabilities; say so honestly.
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `foolscap does not provide ${msg.method}` },
        });
      }
    }
    // Notifications (session/update) are handled by the session via onFrame.
  }

  driver.start = async ({ onExit }) => {
    child = spawnAgent(spec, cwd);
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        try {
          receive(JSON.parse(line));
        } catch {
          // banners and warnings are not protocol
        }
      }
    });
    child.stderr.on("data", (c) => log(c.toString().trim()));
    child.on("error", (err) => {
      failPending(err.message);
      onExit(null, err);
    });
    child.on("exit", (code) => {
      failPending("agent exited");
      onExit(code);
    });

    await rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: CLIENT_INFO,
    });
    const r = await rpc("session/new", { cwd, mcpServers: [] });
    driver.sessionId = r?.sessionId ?? null;
  };

  driver.prompt = (text) =>
    rpc(
      "session/prompt",
      { sessionId: driver.sessionId, prompt: [{ type: "text", text }] },
      { timeout: 0 },
    ).then((r) => ({ stopReason: r?.stopReason ?? "end_turn" }));

  driver.answerPermission = (requestId, optionId) => {
    send({
      jsonrpc: "2.0",
      id: requestId,
      result: { outcome: { outcome: "selected", optionId } },
    });
  };

  driver.cancel = ({ pendingRequestId } = {}) => {
    if (pendingRequestId !== undefined) {
      send({
        jsonrpc: "2.0",
        id: pendingRequestId,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: driver.sessionId },
    });
  };

  driver.close = () => {
    child?.kill();
    failPending("session closed");
  };

  return driver;
}
