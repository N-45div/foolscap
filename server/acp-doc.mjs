/**
 * From ACP frames to a document.
 *
 * One builder serves two tenses. Live, the fleet feeds it frames as
 * they cross the bridge and reads the cells back for the cockpit.
 * Later, the archive adapter feeds it the recorded frames from disk and
 * gets the identical document — so a session looks the same while it
 * runs and after it ends, and every ACP harness is covered by this one
 * file instead of an adapter each.
 *
 * Cells match the viewer's SessionDoc shape exactly: a prompt opens a
 * cell; agent text, thoughts and tool calls nest inside it in order.
 * Tolerant like every other parser here — an update it doesn't know is
 * counted, never fatal.
 */

const textOf = (content) => {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "content") return textOf(content.content);
  return "";
};

const stringify = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

export class TranscriptBuilder {
  constructor() {
    /** SessionDoc cells — the document itself. */
    this.cells = [];
    this.current = null;
    this.toolsById = new Map();
    /** Prompt request id → the cell it opened, to attach the stop reason. */
    this.pendingPrompts = new Map();
    /** Permission request id → the tool it concerns. */
    this.pendingPermissions = new Map();
    this.entryCount = 0;
    /** Latest plan the agent announced, if any. */
    this.plan = null;
    /** What the agent is doing right now, for the fleet row. */
    this.activity = null;
  }

  openCell(prompt, at) {
    this.current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    this.cells.push(this.current);
    return this.current;
  }

  cell(at) {
    return this.current ?? this.openCell("(session resumed)", at);
  }

  /** Feed one frame. dir is "c2a" (client → agent) or "a2c". */
  feed(dir, msg, at) {
    if (!msg || typeof msg !== "object") return;
    this.entryCount++;
    if (dir === "c2a") this.fromClient(msg, at);
    else this.fromAgent(msg, at);
  }

  fromClient(msg, at) {
    if (msg.method === "session/prompt") {
      const text = textOf(msg.params?.prompt).trim();
      const cell = this.openCell(text || "(empty prompt)", at);
      if (msg.id !== undefined) this.pendingPrompts.set(msg.id, cell);
      this.activity = { kind: "thinking", text: "starting the turn" };
      return;
    }
    if (msg.method === "session/cancel") {
      if (this.current) this.current.stopReason = "cancelled";
      return;
    }
    // A response from the client to an agent request — a permission
    // decision is the one we care about.
    if (msg.id !== undefined && this.pendingPermissions.has(msg.id)) {
      const tool = this.pendingPermissions.get(msg.id);
      this.pendingPermissions.delete(msg.id);
      const outcome = msg.result?.outcome;
      tool.decision =
        outcome?.outcome === "selected"
          ? outcome.optionId
          : (outcome?.outcome ?? "answered");
      if (/reject/i.test(tool.decision)) tool.isError = true;
      this.noteDecision(tool);
    }
  }

  /** Keep the permission decision visible in the tool's result, even
      when the agent later overwrites the result with its own output. */
  noteDecision(tool) {
    if (!tool.decision) return;
    const line = `permission: ${tool.decision}`;
    if (tool.result?.includes(line)) return;
    tool.result = [tool.result, line].filter(Boolean).join("\n");
  }

  fromAgent(msg, at) {
    if (msg.method === "session/update") {
      this.update(msg.params?.update ?? {}, at);
      return;
    }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const tc = msg.params?.toolCall ?? {};
      const tool = this.toolFor(tc.toolCallId, tc, at);
      tool.input.permission = (msg.params?.options ?? []).map((o) => o.name ?? o.optionId);
      this.pendingPermissions.set(msg.id, tool);
      this.activity = { kind: "blocked", text: tc.title ?? "asking permission" };
      return;
    }
    if (msg.id !== undefined && this.pendingPrompts.has(msg.id)) {
      const cell = this.pendingPrompts.get(msg.id);
      this.pendingPrompts.delete(msg.id);
      cell.stopReason = msg.error ? "error" : (msg.result?.stopReason ?? "end_turn");
      if (msg.error) {
        cell.parts.push({
          kind: "text",
          text: `**error:** ${msg.error.message ?? "unknown"}`,
          at,
        });
      }
      this.activity = null;
    }
  }

  /** Find or create the ToolInteraction for a tool call id. */
  toolFor(id, u, at) {
    let tool = id ? this.toolsById.get(id) : undefined;
    if (!tool) {
      tool = {
        id: id ?? `tool-${this.entryCount}`,
        name: u.kind ?? "tool",
        input: {},
        isError: false,
        status: u.status ?? "pending",
      };
      if (id) this.toolsById.set(id, tool);
      this.cell(at).parts.push({ kind: "tool", tool, at });
    }
    return tool;
  }

  applyToolFields(tool, u) {
    if (u.kind) tool.name = u.kind;
    if (u.title) tool.input.title = u.title;
    if (u.rawInput && typeof u.rawInput === "object") {
      for (const [k, v] of Object.entries(u.rawInput)) {
        if (!(k in tool.input)) tool.input[k] = v;
      }
    }
    if (u.status) {
      tool.status = u.status;
      tool.isError = u.status === "failed";
    }
    if (u.rawOutput !== undefined) tool.result = stringify(u.rawOutput).slice(0, 20000);
    if (Array.isArray(u.content)) {
      for (const c of u.content) {
        if (c?.type === "diff") {
          // The viewer's diff renderer keys on these names.
          tool.input.file_path = c.path;
          tool.input.old_string = c.oldText ?? "";
          tool.input.new_string = c.newText ?? "";
          tool.name = tool.name === "tool" ? "edit" : tool.name;
        } else {
          const t = textOf(c);
          if (t) tool.result = [tool.result, t].filter(Boolean).join("\n").slice(0, 20000);
        }
      }
    }
    if (Array.isArray(u.locations) && u.locations.length && !tool.input.file_path) {
      tool.input.file_path = u.locations[0]?.path;
    }
    this.noteDecision(tool);
  }

  update(u, at) {
    const kind = u.sessionUpdate ?? u.type;
    switch (kind) {
      case "agent_message_chunk": {
        const text = textOf(u.content);
        if (!text) return;
        const cell = this.cell(at);
        const last = cell.parts.at(-1);
        if (last?.kind === "text") last.text += text;
        else cell.parts.push({ kind: "text", text, at });
        this.activity = { kind: "message", text: "replying" };
        return;
      }
      case "agent_thought_chunk": {
        const text = textOf(u.content);
        if (!text) return;
        const cell = this.cell(at);
        const last = cell.parts.at(-1);
        if (last?.kind === "thinking") last.text += text;
        else cell.parts.push({ kind: "thinking", text, at });
        this.activity = { kind: "thinking", text: "thinking" };
        return;
      }
      case "user_message_chunk": {
        // Echo of the prompt (or a replayed one on session/load).
        if (!this.current) this.openCell(textOf(u.content), at);
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const tool = this.toolFor(u.toolCallId, u, at);
        this.applyToolFields(tool, u);
        const running = tool.status === "pending" || tool.status === "in_progress";
        if (running || kind === "tool_call") {
          this.activity = { kind: "tool", text: tool.input.title ?? tool.name };
        }
        return;
      }
      case "plan":
        this.plan = Array.isArray(u.entries) ? u.entries : null;
        return;
      default:
        // current_mode_update, available_commands_update, future kinds.
        return;
    }
  }
}
