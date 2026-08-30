#!/usr/bin/env node
/**
 * The permission relay — how a native Claude Code agent's permission
 * prompts reach the fleet queue.
 *
 * Claude Code in print mode has no terminal to ask "allow this?" on.
 * Its answer is `--permission-prompt-tool`: it calls an MCP tool and
 * treats the JSON that comes back as the decision. This is that tool,
 * as a tiny stdio MCP server foolscap registers for each session. It
 * posts the question to the fleet (which marks the session blocked, so
 * it rises to the top of the queue), polls until the person answers
 * with `a`/`d` or a click, and returns the verdict.
 *
 * Hand-rolled JSON-RPC rather than an SDK dependency: three methods.
 */
import { createInterface } from "node:readline";

const FLEET = process.env.FOOLSCAP_FLEET;
const SESSION = process.env.FOOLSCAP_SESSION;
const HEADERS = { "content-type": "application/json", "x-foolscap": "fleet" };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(args) {
  const opened = await fetch(`${FLEET}/api/fleet/${SESSION}/ask`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(args),
  });
  if (!opened.ok) {
    return { behavior: "deny", message: `foolscap could not register the request (${opened.status})` };
  }
  const { requestId } = await opened.json();
  // Poll rather than long-poll: a person may take longer than any
  // HTTP client's idle timeout to come back to the keyboard.
  for (;;) {
    await sleep(400);
    const r = await fetch(`${FLEET}/api/fleet/${SESSION}/ask/${requestId}`, { headers: HEADERS });
    if (!r.ok) return { behavior: "deny", message: "the fleet session went away" };
    const s = await r.json();
    if (!s.decided) continue;
    return s.allow
      ? { behavior: "allow", updatedInput: args.input ?? {} }
      : { behavior: "deny", message: "Denied by the operator in foolscap." };
  }
}

const TOOL = {
  name: "permission",
  description:
    "Ask the person running the foolscap fleet whether this tool call may proceed.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (result) => send({ jsonrpc: "2.0", id: req.id, result });

  switch (req.method) {
    case "initialize":
      reply({
        protocolVersion: req.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "foolscap", version: "0.3.0" },
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools: [TOOL] });
      return;
    case "tools/call": {
      const decision = await ask(req.params?.arguments ?? {});
      reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
      return;
    }
    default:
      if (req.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32601, message: `unknown method ${req.method}` },
        });
      }
  }
});
