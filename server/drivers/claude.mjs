/**
 * Fleet driver: Claude Code, natively.
 *
 * No adapter, no download: `claude -p --input-format stream-json
 * --output-format stream-json` is Claude Code's own multi-turn protocol.
 * We write one user message per turn to stdin and read its stream back
 * — the same message shapes it keeps in its session logs.
 *
 * Permissions: print mode has no terminal to ask on, so Claude Code's
 * `--permission-prompt-tool` calls an MCP tool and treats the JSON that
 * comes back as the decision. foolscap registers a tiny stdio MCP
 * server (permission-mcp.mjs) per session; it posts the question to the
 * fleet, which marks the session blocked — top of the queue — and polls
 * until the person answers. Deny by default if the fleet vanishes.
 *
 * `FOOLSCAP_CLAUDE="…"` overrides the binary (a pinned version, a
 * wrapper, or the fake used in tests).
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../acp.mjs";
import { titleOf } from "../claude-stream.mjs";

const MCP_SERVER = fileURLToPath(new URL("../permission-mcp.mjs", import.meta.url));

export function claudeSpec() {
  const override = process.env.FOOLSCAP_CLAUDE;
  if (override) {
    const parts = override.trim().split(/\s+/);
    return { label: "claude code", command: parts[0], args: parts.slice(1) };
  }
  return { label: "claude code", command: "claude", args: [] };
}

/** ACP-style kind for Claude Code's tool names, for the queue's labels. */
function kindOf(name) {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "edit";
  if (name === "Read") return "read";
  if (/^(Bash|PowerShell)$/.test(name)) return "execute";
  if (/^(Glob|Grep)$/.test(name)) return "search";
  if (/^Web(Fetch|Search)$/.test(name)) return "fetch";
  return "other";
}

export function createClaudeDriver({ id, cwd, fleetUrl, log, onFrame, onPermission }) {
  const spec = claudeSpec();
  let child = null;
  let buffered = "";
  let turn = null; // { resolve, reject } for the in-flight prompt
  const decisions = new Map(); // requestId → null | boolean
  const mcpFile = join(homedir(), ".foolscap", `mcp-${id}.json`);
  const driver = { kind: "claude", sessionId: null };

  function receive(msg) {
    onFrame("a2c", msg);
    if (msg.type === "system" && msg.subtype === "init") {
      driver.sessionId = msg.session_id ?? null;
    }
    if (msg.type === "result" && turn) {
      const t = turn;
      turn = null;
      let stopReason = "end_turn";
      if (msg.is_error) stopReason = "error";
      else if (msg.subtype && msg.subtype !== "success") stopReason = msg.subtype;
      t.resolve({ stopReason });
    }
  }

  driver.start = async ({ onExit }) => {
    const args = [
      ...spec.args,
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];
    if (fleetUrl) {
      // The permission relay is registered as an MCP server; the config
      // goes through a file because inline JSON does not survive shells.
      await mkdir(join(homedir(), ".foolscap"), { recursive: true });
      await writeFile(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            foolscap: {
              command: process.execPath,
              args: [MCP_SERVER],
              env: { FOOLSCAP_FLEET: fleetUrl, FOOLSCAP_SESSION: id },
            },
          },
        }),
      );
      args.push("--permission-prompt-tool", "mcp__foolscap__permission", "--mcp-config", mcpFile);
    }

    // Claude Code refuses to nest inside another Claude Code session;
    // the fleet is not a session, so drop the marker.
    const env = { ...process.env };
    delete env.CLAUDECODE;

    child = spawnAgent({ ...spec, args }, cwd, env);
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
          // not protocol
        }
      }
    });
    child.stderr.on("data", (c) => log(c.toString().trim()));
    child.on("error", (err) => {
      turn?.reject(err);
      turn = null;
      onExit(null, err);
    });
    child.on("exit", (code) => {
      turn?.reject(new Error("agent exited"));
      turn = null;
      onExit(code);
    });
    // No handshake: the first message starts the conversation.
  };

  driver.prompt = (text) =>
    new Promise((resolve, reject) => {
      turn = { resolve, reject };
      const msg = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      onFrame("c2a", msg);
      child?.stdin.write(JSON.stringify(msg) + "\n");
    });

  /** Called by the permission relay: register the question, block. */
  driver.ask = ({ tool_name = "tool", input = {}, tool_use_id } = {}) => {
    const requestId = tool_use_id || `perm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    decisions.set(requestId, null);
    onPermission({
      requestId,
      toolCall: {
        toolCallId: requestId,
        title: titleOf(tool_name, input) || tool_name,
        kind: kindOf(tool_name),
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      ],
    });
    return requestId;
  };

  driver.decision = (requestId) => {
    if (!decisions.has(requestId)) return { decided: true, allow: false };
    const d = decisions.get(requestId);
    return { decided: d !== null, allow: d === true };
  };

  driver.answerPermission = (requestId, optionId) => {
    decisions.set(requestId, /allow/i.test(optionId));
  };

  driver.cancel = ({ pendingRequestId } = {}) => {
    if (pendingRequestId !== undefined) decisions.set(pendingRequestId, false);
    // Claude Code's stream-json control channel; ignored by older builds.
    const msg = {
      type: "control_request",
      request_id: `cancel-${Date.now()}`,
      request: { subtype: "interrupt" },
    };
    onFrame("c2a", msg);
    child?.stdin.write(JSON.stringify(msg) + "\n");
  };

  driver.close = () => {
    child?.kill();
    turn?.reject(new Error("session closed"));
    turn = null;
    unlink(mcpFile).catch(() => {});
  };

  return driver;
}
