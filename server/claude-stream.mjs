/**
 * From Claude Code's stream-json to a document.
 *
 * `claude -p --output-format stream-json --input-format stream-json` is
 * Claude Code's own multi-turn wire protocol: one JSON object per line,
 * the same message shapes it writes to its session logs. This builder
 * turns that stream into the viewer's cells — live for the fleet, and
 * again from a recording for the archive — exactly as TranscriptBuilder
 * does for ACP. Same interface, so the session core and the archive
 * adapter never know which driver produced the document.
 *
 *   c2a  {type:"user", message:{role:"user", content:[{type:"text"}]}}
 *   a2c  {type:"system", subtype:"init", model, session_id, tools…}
 *        {type:"assistant", message:{content:[text | thinking | tool_use]}}
 *        {type:"user", message:{content:[tool_result…]}}
 *        {type:"result", subtype, is_error, total_cost_usd, usage}
 */

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b?.type === "text" ? (b.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
};

/** A one-line human title for a tool call, the way ACP would phrase it. */
export function titleOf(name, input) {
  const i = input ?? {};
  const first = (...keys) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k]) return i[k];
    return "";
  };
  switch (name) {
    case "Bash":
    case "PowerShell":
      return first("command").split("\n")[0].slice(0, 80);
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `${name} ${first("file_path")}`;
    case "Glob":
    case "Grep":
      return `${name} ${first("pattern")}`;
    case "Agent":
      return first("description");
    default:
      return name;
  }
}

export class ClaudeStreamBuilder {
  constructor() {
    this.cells = [];
    this.current = null;
    this.toolsById = new Map();
    this.entryCount = 0;
    this.plan = null;
    this.activity = null;
    this.model = null;
    this.sessionId = null;
    this.costUsd = 0;
    this.totalOutputTokens = 0;
  }

  openCell(prompt, at) {
    this.current = { prompt, promptAt: at, parts: [], outputTokens: 0 };
    this.cells.push(this.current);
    return this.current;
  }

  cell(at) {
    return this.current ?? this.openCell("(session resumed)", at);
  }

  feed(dir, msg, at) {
    if (!msg || typeof msg !== "object") return;
    this.entryCount++;
    if (dir === "c2a") {
      if (msg.type === "user") {
        const text = textOf(msg.message?.content).trim();
        this.openCell(text || "(empty prompt)", at);
        this.activity = { kind: "thinking", text: "starting the turn" };
      }
      return;
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.model = msg.model ?? this.model;
          this.sessionId = msg.session_id ?? this.sessionId;
        }
        return;

      case "assistant": {
        const cell = this.cell(at);
        const usage = msg.message?.usage;
        if (usage?.output_tokens) {
          cell.outputTokens += usage.output_tokens;
          this.totalOutputTokens += usage.output_tokens;
        }
        for (const b of msg.message?.content ?? []) {
          if (b?.type === "text" && b.text) {
            const last = cell.parts.at(-1);
            if (last?.kind === "text") last.text += b.text;
            else cell.parts.push({ kind: "text", text: b.text, at });
            this.activity = { kind: "message", text: "replying" };
          } else if (b?.type === "thinking" && b.thinking) {
            cell.parts.push({ kind: "thinking", text: b.thinking, at });
            this.activity = { kind: "thinking", text: "thinking" };
          } else if (b?.type === "tool_use" && b.id) {
            const input = b.input ?? {};
            const tool = {
              id: b.id,
              name: b.name ?? "tool",
              input: { title: titleOf(b.name, input), ...input },
              isError: false,
              status: "in_progress",
            };
            this.toolsById.set(b.id, tool);
            cell.parts.push({ kind: "tool", tool, at });
            this.activity = { kind: "tool", text: tool.input.title || tool.name };
          }
        }
        return;
      }

      case "user": {
        // Tool results come back as user-role messages.
        for (const b of msg.message?.content ?? []) {
          if (b?.type !== "tool_result" || !b.tool_use_id) continue;
          const tool = this.toolsById.get(b.tool_use_id);
          if (!tool) continue;
          tool.result = textOf(b.content).slice(0, 20000);
          tool.isError = b.is_error === true;
          tool.status = tool.isError ? "failed" : "completed";
        }
        return;
      }

      case "result": {
        const cell = this.current;
        if (cell) {
          cell.stopReason = msg.is_error
            ? "error"
            : msg.subtype === "success"
              ? "end_turn"
              : (msg.subtype ?? "end_turn");
        }
        if (typeof msg.total_cost_usd === "number") this.costUsd = msg.total_cost_usd;
        this.activity = null;
        return;
      }

      default:
        return; // stream_event and future types
    }
  }
}
